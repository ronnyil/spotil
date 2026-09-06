// Turns "landing 12, departing 26" into "stand here, now".

import { haversineNm, bearingTo, compassPoint, destinationPoint } from "./geo.js";
import { lightQuality } from "./sun.js";
import { runwayEnds } from "./runway.js";

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

// Live reading where we have one, the time-of-day pattern where we do not.
// Never silently passes a guess off as an observation.
export function resolveRunways(summary, airport, date = new Date(), minConfidence = 0.35) {
  const guess = patternPrediction(airport, date);
  const resolve = (live, fallback) =>
    live.runway && live.confidence >= minConfidence
      ? { runway: live.runway, confidence: live.confidence, basis: "observed", aircraft: live.aircraft, alternatives: live.alternatives }
      : { runway: fallback, confidence: live.runway ? live.confidence : 0, basis: fallback ? "predicted" : "unknown", observedRunway: live.runway, aircraft: live.aircraft ?? [], alternatives: live.alternatives ?? [] };

  return {
    landing: resolve(summary.landing, guess.landing),
    takeoff: resolve(summary.takeoff, guess.takeoff),
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
