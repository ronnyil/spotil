// Derives which runways are actually in use from live ADS-B tracks.
//
// No free data source publishes TLV's runway configuration - ATIS is voice
// only - so we infer it from the traffic. An aircraft that is low, aligned
// with a runway's bearing, sitting on that runway's extended centreline and
// descending is landing on it; one that is climbing away past the far end is
// departing from it. Each aircraft votes once, votes decay, and the winner per
// operation is the runway in use.

import {
  haversineNm, angleDiff, reciprocal, crossTrackNm, alongTrackNm, norm360,
} from "./geo.js";

const LIMITS = {
  maxRangeNm: 15,
  arrival: {
    maxRangeNm: 12,
    maxAltAgl: 4500,
    maxTrackErr: 25,
    maxCrossTrackNm: 1.5,
    // Below this an aircraft is committed even if the climb rate reads noisily.
    assumeDescendingBelowAgl: 1500,
  },
  departure: {
    maxRangeNm: 12,
    minAltAgl: 150,
    maxAltAgl: 8000,
    maxTrackErr: 30,
    // Departures start their turn early, so allow a wider corridor.
    maxCrossTrackNm: 2.5,
    minClimbFpm: 300,
  },
  minGroundSpeedKt: 60,
  // A vote is worth half as much after this long, and is dropped entirely at
  // voteMaxAgeMs.
  voteHalfLifeMs: 8 * 60 * 1000,
  voteMaxAgeMs: 20 * 60 * 1000,
  // Total decayed vote weight at which a reading is called fully trustworthy.
  // Deliberately low. One aircraft aligned within a few degrees of a runway,
  // on its extended centreline, descending through 3000 ft at 9 nm is not a
  // coincidence - it is an arrival on that runway. Requiring three such
  // sightings meant falling back to the time-of-day pattern exactly when
  // traffic is thin, which is when that pattern is least reliable and when
  // being wrong is most expensive: runways 21 and 30 are on opposite sides of
  // the field. A weak single sighting still fails to clear the confidence
  // threshold on its own, so this trades no accuracy for far better coverage.
  saturationWeight: 1.5,
};

// Every runway end as a flat list. Bearings and thresholds are measured from
// real coordinates rather than derived from the designator plus magnetic
// variation, which was wrong by 3 to 6 degrees for every runway here.
export function runwayEnds(airport) {
  const ends = [];
  for (const rwy of airport.runways) {
    for (const end of rwy.ends) {
      ends.push({
        id: end.id,
        pair: rwy.pair,
        trueBearing: end.trueBearing,
        threshold: end.threshold,
        lengthM: rwy.lengthM,
        widthM: rwy.widthM,
      });
    }
  }
  return ends;
}

// Best single interpretation of one aircraft, or null if it is just passing
// through. Confidence is 0..1.
export function classifyAircraft(ac, airport, ends) {
  if (ac.onGround) return null;
  if (ac.groundSpeed !== null && ac.groundSpeed < LIMITS.minGroundSpeedKt) return null;

  const arp = airport.arp;
  const distNm = haversineNm(arp, ac);
  if (distNm > LIMITS.maxRangeNm) return null;

  const altAgl = ac.altBaro - airport.elevationFt;
  if (altAgl > LIMITS.arrival.maxAltAgl && altAgl > LIMITS.departure.maxAltAgl) {
    return null;
  }

  let best = null;

  for (const end of ends) {
    // Distances are measured from this runway's own threshold: the runways do
    // not pass through the airport reference point, so measuring from the ARP
    // put the centreline up to a kilometre off.
    const origin = end.threshold ?? arp;
    const trackErr = angleDiff(ac.track, end.trueBearing);
    const crossNm = crossTrackNm(origin, ac, end.trueBearing);
    const alongNm = alongTrackNm(origin, ac, end.trueBearing);

    // Arrival: inbound on the approach side, so behind the field along the
    // runway axis, pointing at it, going down.
    const A = LIMITS.arrival;
    const descending =
      (ac.verticalRate !== null && ac.verticalRate < -100) ||
      altAgl < A.assumeDescendingBelowAgl;
    if (
      distNm <= A.maxRangeNm &&
      altAgl <= A.maxAltAgl &&
      alongNm < 0 &&
      trackErr <= A.maxTrackErr &&
      crossNm <= A.maxCrossTrackNm &&
      descending
    ) {
      const confidence = score({
        trackErr, maxTrackErr: A.maxTrackErr,
        crossNm, maxCrossNm: A.maxCrossTrackNm,
        distNm, maxDistNm: A.maxRangeNm,
      });
      if (!best || confidence > best.confidence) {
        best = { operation: "landing", runway: end.id, pair: end.pair, confidence, distNm, altAgl };
      }
    }

    // Departure: past the far end, pointing away, going up.
    const D = LIMITS.departure;
    if (
      distNm <= D.maxRangeNm &&
      altAgl >= D.minAltAgl &&
      altAgl <= D.maxAltAgl &&
      alongNm > 0 &&
      trackErr <= D.maxTrackErr &&
      crossNm <= D.maxCrossTrackNm &&
      ac.verticalRate !== null &&
      ac.verticalRate >= D.minClimbFpm
    ) {
      const confidence = score({
        trackErr, maxTrackErr: D.maxTrackErr,
        crossNm, maxCrossNm: D.maxCrossTrackNm,
        distNm, maxDistNm: D.maxRangeNm,
      });
      if (!best || confidence > best.confidence) {
        best = { operation: "takeoff", runway: end.id, pair: end.pair, confidence, distNm, altAgl };
      }
    }
  }

  return best;
}

// Tight alignment, close to the centreline and close to the field all raise
// confidence; the closest term dominates because a distant aircraft may still
// be manoeuvring onto a different runway.
function score({ trackErr, maxTrackErr, crossNm, maxCrossNm, distNm, maxDistNm }) {
  const align = 1 - trackErr / maxTrackErr;
  const lateral = 1 - crossNm / maxCrossNm;
  const near = 1 - (distNm / maxDistNm) * 0.6;
  return Math.max(0, Math.min(1, align * 0.4 + lateral * 0.3 + near * 0.3));
}

// Rolling record of what each aircraft was seen doing. One aircraft is one
// vote no matter how many times we poll it, which stops a single holding
// aircraft from outvoting a stream of real traffic.
export class RunwayTracker {
  constructor(airport, limits = LIMITS) {
    this.airport = airport;
    this.ends = runwayEnds(airport);
    this.limits = limits;
    this.votes = new Map(); // hex -> { operation, runway, confidence, at, ac }
    // Which aircraft were classified in the most recent poll. A reading backed
    // only by aircraft that have since landed is real evidence, but it is not
    // "live", and saying so would be a small lie told every quiet evening.
    this.currentHexes = new Set();
  }

  observe(aircraft, now = Date.now()) {
    const seen = [];
    this.currentHexes = new Set();
    for (const ac of aircraft) {
      const verdict = classifyAircraft(ac, this.airport, this.ends);
      if (!verdict) continue;

      const prev = this.votes.get(ac.hex);
      // Keep the most confident sighting of this aircraft, but always let a
      // newer verdict replace a stale one - an aircraft that landed and later
      // departs must not be stuck as an arrival.
      const stale = prev && now - prev.at > this.limits.voteHalfLifeMs;
      if (!prev || stale || verdict.confidence > prev.confidence) {
        this.votes.set(ac.hex, { ...verdict, at: now, ac });
      }
      seen.push({ ...verdict, ac });
      this.currentHexes.add(ac.hex);
    }
    this.prune(now);
    return seen;
  }

  // A trimmed form of each vote, small enough to store and carrying only what
  // a restored session needs: the verdict, when it was made, and enough of the
  // aircraft to name it.
  export(now = Date.now()) {
    this.prune(now);
    return [...this.votes.entries()].map(([hex, v]) => ({
      hex,
      operation: v.operation,
      runway: v.runway,
      pair: v.pair,
      confidence: v.confidence,
      distNm: v.distNm,
      altAgl: v.altAgl,
      at: v.at,
      ac: { hex: v.ac?.hex ?? hex, callsign: v.ac?.callsign ?? null, type: v.ac?.type ?? null },
    }));
  }

  // Restores stored votes, ignoring anything the tracker would already have
  // expired. A vote seen again in the current session overwrites the stored
  // one on its own merits.
  restore(votes, now = Date.now()) {
    for (const v of votes ?? []) {
      if (!v?.hex || !Number.isFinite(v.at)) continue;
      if (now - v.at > this.limits.voteMaxAgeMs) continue;
      this.votes.set(v.hex, v);
    }
    this.prune(now);
    return this.votes.size;
  }

  prune(now = Date.now()) {
    for (const [hex, v] of this.votes) {
      if (now - v.at > this.limits.voteMaxAgeMs) this.votes.delete(hex);
    }
  }

  // Current best reading: which runway is being landed on, which is being
  // departed from, and how much we trust each.
  summary(now = Date.now()) {
    this.prune(now);

    const tally = { landing: new Map(), takeoff: new Map() };
    const contributors = { landing: [], takeoff: [] };

    for (const [hex, v] of this.votes.entries()) {
      const age = now - v.at;
      const decay = Math.pow(0.5, age / this.limits.voteHalfLifeMs);
      const weight = v.confidence * decay;
      const bucket = tally[v.operation];
      bucket.set(v.runway, (bucket.get(v.runway) || 0) + weight);
      contributors[v.operation].push({ ...v, hex, weight });
    }

    return {
      landing: pick(tally.landing, contributors.landing, this.limits, this.currentHexes),
      takeoff: pick(tally.takeoff, contributors.takeoff, this.limits, this.currentHexes),
      trackedAircraft: this.votes.size,
      updatedAt: now,
    };
  }
}

function pick(tally, contributors, limits, currentHexes = new Set()) {
  if (tally.size === 0) {
    return { runway: null, confidence: 0, total: 0, aircraft: [], alternatives: [], liveNow: false, latestAt: null };
  }

  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  const [runway, weight] = ranked[0];
  const total = ranked.reduce((s, [, w]) => s + w, 0);

  // Two things must hold to be confident: this runway dominates the others,
  // and we have seen enough traffic to be sure of anything at all.
  const dominance = weight / total;
  const evidence = Math.min(1, total / limits.saturationWeight);

  const backing = contributors
    .filter((c) => c.runway === runway)
    .sort((a, b) => b.at - a.at);

  return {
    runway,
    confidence: dominance * evidence,
    total,
    aircraft: backing,
    // True only if at least one aircraft behind this reading was in the air at
    // the last poll.
    liveNow: backing.some((c) => currentHexes.has(c.hex)),
    latestAt: backing.length ? backing[0].at : null,
    alternatives: ranked.slice(1).map(([r, w]) => ({ runway: r, share: w / total })),
  };
}

export { LIMITS };
