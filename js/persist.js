// Remembers what was observed across page loads.
//
// The ADS-B networks only report where aircraft are now - there is no history
// to query - so knowing which runway was in use five minutes ago requires
// having been watching. The tracker lived in memory only, so every reload
// started blind: at quiet times the site would observe a single arrival, then
// forget it the moment the page was refreshed and fall back to guessing from
// the time of day.

const KEY = "tlv.observations.v1";

// Beyond this a stored vote is discarded outright. Matches the tracker's own
// vote lifetime, so restoring cannot resurrect evidence it would have dropped.
const MAX_VOTE_AGE_MS = 20 * 60 * 1000;

// How long a confident reading stays worth reporting once traffic goes quiet.
// Runway configuration at TLV changes a few times a day, so an observation
// from half an hour ago is still far better evidence than the time of day -
// but it is shown with its age so nobody mistakes it for live.
export const RECENT_WINDOW_MS = 90 * 60 * 1000;

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    // Private browsing, blocked storage, or corrupt JSON. Running without
    // history is the previous behaviour, so degrade to it silently.
    return null;
  }
}

export function load(now = Date.now()) {
  const data = read();
  if (!data || data.v !== 1) return { votes: [], lastSeen: {} };

  const votes = (data.votes || []).filter(
    (v) => v && Number.isFinite(v.at) && now - v.at <= MAX_VOTE_AGE_MS
  );

  const lastSeen = {};
  for (const op of ["landing", "takeoff"]) {
    const entry = data.lastSeen?.[op];
    if (entry && Number.isFinite(entry.at) && now - entry.at <= RECENT_WINDOW_MS) {
      lastSeen[op] = entry;
    }
  }
  return { votes, lastSeen };
}

export function save({ votes, lastSeen }) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: 1, votes, lastSeen }));
  } catch {
    // Quota or blocked storage; history is an enhancement, not a requirement.
  }
}
