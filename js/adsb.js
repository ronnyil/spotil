// Live aircraft positions from free community ADS-B networks.
//
// Flightradar24 is deliberately not used here: its API is enterprise-only with
// no self-serve tier, and its terms forbid scraping and redistributing the
// feed. These networks carry the same ADS-B signal, are keyless and
// CORS-enabled, and permit non-commercial use. See README.md.

// Several URL shapes are tried per network because these community APIs have
// changed paths over time and not every deployment serves both forms.
const SOURCES = [
  { name: "airplanes.live", url: (lat, lon, nm) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${nm}` },
  { name: "adsb.lol", url: (lat, lon, nm) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${nm}` },
  { name: "adsb.fi", url: (lat, lon, nm) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${nm}` },
  { name: "adsb.lol (lat/lon)", url: (lat, lon, nm) => `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${nm}` },
  { name: "airplanes.live (lat/lon)", url: (lat, lon, nm) => `https://api.airplanes.live/v2/lat/${lat}/lon/${lon}/dist/${nm}` },
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
export async function fetchAircraft(lat, lon, radiusNm, { timeoutMs = 8000, proxy = "" } = {}) {
  const errors = [];
  const la = lat.toFixed(4), lo = lon.toFixed(4), nm = Math.round(radiusNm);

  const sources = proxy
    ? [{ name: "proxy", url: () => `${proxy.replace(/\/$/, "")}/?lat=${la}&lon=${lo}&radius=${nm}` }, ...SOURCES]
    : SOURCES;

  for (const source of sources) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(source.url(la, lo, nm), {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      // An HTTP status means the request was allowed through and answered, so
      // it is worth reporting separately from a request the browser refused.
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const raw = body.ac || body.aircraft || [];
      // The proxy reports which upstream it actually used, which is more
      // useful in the status line than the word "proxy".
      const label = source.name === "proxy" && body.source ? `proxy → ${body.source}` : source.name;
      return { aircraft: normalise(raw), source: label, fetchedAt: Date.now() };
    } catch (err) {
      errors.push(`${source.name}: ${describe(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  const failure = new Error(`no source reachable (${errors.join("; ")})`);
  failure.perSource = errors;
  throw failure;
}

// A browser reports a CORS rejection and an unreachable host identically, as a
// bare TypeError, so say what is actually known rather than inventing a cause.
function describe(err) {
  if (err.name === "AbortError") return "timed out";
  if (err instanceof TypeError) return "blocked or unreachable";
  return err.message;
}
