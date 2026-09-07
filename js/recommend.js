// Turns "landing 12, departing 26" into "stand here, now".

import { haversineNm, bearingTo, compassPoint, destinationPoint } from "./geo.js";
import { lightQuality } from "./sun.js";
import { runwayEnds } from "./runway.js";
import { RECENT_WINDOW_MS } from "./persist.js";

// Local hour at the airport, regardless of where the viewer's device is set.
export function localHour(date, timeZone) {
  const h = new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", hour12: false,
  }).format(date);
  return parseInt(h, 10) % 24;
}

// What the time of day suggests, used only when live traffic cannot tell us.
export function patternPrediction(airport, date = new Date()) {
  const hour = localHour(date, airport.timezone);
  const window = airport.typicalPattern.landingByLocalHour.find(({ fromHour, toHour }) =>
    fromHour <= toHour ? hour >= fromHour && hour < toHour : hour >= fromHour || hour < toHour
  );
  return {
    landing: window?.runway ?? null,
    takeoff: airport.typicalPattern.takeoffDefault,
    label: window?.label ?? null,
  };
}

// Resolves each operation in order of evidence: what is being observed now,
// then what was last actually observed, then the time-of-day pattern. The
// middle rung matters most at quiet times - a runway seen ten minutes ago is
// far better evidence than the hour of the day, because configuration changes
// a few times a day rather than a few times an hour.
export function resolveRunways(
  summary, airport, date = new Date(), minConfidence = 0.35, lastSeen = {}
) {
  const guess = patternPrediction(airport, date);
  const now = date.getTime();

  const resolve = (live, fallback, remembered) => {
    if (live.runway && live.confidence >= minConfidence) {
      // Strong evidence. Whether it counts as live depends on whether any of
      // the aircraft behind it are still flying.
      if (live.liveNow) {
        return {
          runway: live.runway, confidence: live.confidence, basis: "observed",
          aircraft: live.aircraft, alternatives: live.alternatives,
        };
      }
      return {
        runway: live.runway, confidence: live.confidence, basis: "recent",
        ageMs: Math.max(0, now - (live.latestAt ?? now)),
        aircraft: live.aircraft, alternatives: live.alternatives,
      };
    }

    if (remembered?.runway && Number.isFinite(remembered.at)
        && now - remembered.at <= RECENT_WINDOW_MS) {
      return {
        runway: remembered.runway,
        confidence: remembered.confidence ?? 0,
        basis: "recent",
        ageMs: now - remembered.at,
        aircraft: live.aircraft ?? [],
        alternatives: live.alternatives ?? [],
        observedRunway: live.runway,
      };
    }

    return {
      runway: fallback,
      confidence: live.runway ? live.confidence : 0,
      basis: fallback ? "predicted" : "unknown",
      observedRunway: live.runway,
      aircraft: live.aircraft ?? [],
      alternatives: live.alternatives ?? [],
    };
  };

  return {
    landing: resolve(summary.landing, guess.landing, lastSeen.landing),
    takeoff: resolve(summary.takeoff, guess.takeoff, lastSeen.takeoff),
    patternLabel: guess.label,
    trackedAircraft: summary.trackedAircraft,
    updatedAt: summary.updatedAt,
  };
}

// Where a spot should be looking: at the point where aircraft will be, which
// is out along the approach for a landing and out along the climb for a
// departure - not at the airport reference point.
function actionPoint(airport, runwayId, operation) {
  const end = runwayEnds(airport).find((e) => e.id === runwayId);
  if (!end) return airport.arp;
  const offsetNm = operation === "landing" ? 3 : 3;
  const bearing = operation === "landing" ? (end.trueBearing + 180) % 360 : end.trueBearing;
  return destinationPoint(airport.arp, bearing, offsetNm);
}

// Ranks spots for one operation on one runway. `from` is the viewer's position
// if they shared it, otherwise null.
export function rankSpots(spots, airport, runwayId, operation, {
  from = null, date = new Date(),
} = {}) {
  if (!runwayId) return [];

  const target = actionPoint(airport, runwayId, operation);

  return spots
    .map((spot) => {
      const match = spot.serves.find(
        (s) => s.runway === runwayId && s.operation === operation
      );
      if (!match) return null;

      const lookBearing = bearingTo(spot, target);
      const light = lightQuality(date, spot.lat, spot.lon, lookBearing);
      const driveNm = from ? haversineNm(from, spot) : null;

      // Local knowledge first: a spot the guides name for this runway beats a
      // marginally better-lit one that nobody recommends. Light then breaks
      // ties, and proximity only nudges.
      let score = match.quality / 5;
      score = score * 0.6 + light.score * 0.3;
      if (driveNm !== null) score += 0.1 * Math.max(0, 1 - driveNm / 20);
      else score += 0.05;

      return {
        spot,
        quality: match.quality,
        score,
        light,
        lookBearing,
        lookCompass: compassPoint(lookBearing),
        distanceNm: driveNm,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

// Google Maps and Waze both accept a free-text search, which routes correctly
// even where our pin is only approximate.
export function navLinks(spot, lang = "en") {
  const q = encodeURIComponent(spot.name.he || spot.name.en);
  return {
    google: `https://www.google.com/maps/search/?api=1&query=${q}`,
    googlePin: `https://www.google.com/maps/search/?api=1&query=${spot.lat},${spot.lon}`,
    waze: `https://www.waze.com/ul?q=${q}&navigate=yes`,
    wazePin: `https://www.waze.com/ul?ll=${spot.lat},${spot.lon}&navigate=yes`,
  };
}
