// Live aircraft positions from free community ADS-B networks.
//
// Flightradar24 is deliberately not used here: its API is enterprise-only with
// no self-serve tier, and its terms forbid scraping and redistributing the
// feed. These networks carry the same ADS-B signal, are keyless and
// CORS-enabled, and permit non-commercial use. See README.md.

const SOURCES = [
  {
    name: "airplanes.live",
    url: (lat, lon, nm) =>
      `https://api.airplanes.live/v2/point/${lat.toFixed(4)}/${lon.toFixed(4)}/${Math.round(nm)}`,
  },
  {
    name: "adsb.fi",
    url: (lat, lon, nm) =>
      `https://opendata.adsb.fi/api/v2/lat/${lat.toFixed(4)}/lon/${lon.toFixed(4)}/dist/${Math.round(nm)}`,
  },
  {
    name: "adsb.lol",
    url: (lat, lon, nm) =>
      `https://api.adsb.lol/v2/point/${lat.toFixed(4)}/${lon.toFixed(4)}/${Math.round(nm)}`,
  },
];

// These networks all speak the readsb aircraft.json dialect.
function normalise(raw) {
  const out = [];
  for (const a of raw) {
    if (typeof a.lat !== "number" || typeof a.lon !== "number") continue;

    const onGround = a.alt_baro === "ground";
    const altBaro = onGround ? 0 : Number(a.alt_baro);
    if (!onGround && !Number.isFinite(altBaro)) continue;

    const track = Number(a.track);
    if (!Number.isFinite(track)) continue;

    // baro_rate is the pressure-derived climb rate; geom_rate is the GNSS one.
    // Either answers "climbing or descending", so take whichever is present.
    const rate = Number.isFinite(Number(a.baro_rate))
      ? Number(a.baro_rate)
      : Number.isFinite(Number(a.geom_rate))
        ? Number(a.geom_rate)
        : null;

    out.push({
      hex: a.hex,
      callsign: (a.flight || "").trim() || null,
      registration: a.r || null,
      type: a.t || null,
      lat: a.lat,
      lon: a.lon,
      altBaro,
      onGround,
      groundSpeed: Number.isFinite(Number(a.gs)) ? Number(a.gs) : null,
      track,
      verticalRate: rate,
    });
  }
  return out;
}

// Tries each network in turn, so one being down or rate-limiting us is not an
// outage. Rejects only when every source fails.
export async function fetchAircraft(lat, lon, radiusNm, { timeoutMs = 8000 } = {}) {
  const errors = [];

  for (const source of SOURCES) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(source.url(lat, lon, radiusNm), {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const raw = body.ac || body.aircraft || [];
      return { aircraft: normalise(raw), source: source.name, fetchedAt: Date.now() };
    } catch (err) {
      errors.push(`${source.name}: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`All ADS-B sources failed - ${errors.join("; ")}`);
}
