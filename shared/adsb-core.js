// Upstream selection, request validation and fetching, shared by both proxy
// deployments so they cannot drift apart. Everything here is plain ES modules
// with no runtime-specific API, so it runs unchanged on Cloudflare Workers,
// on Vercel's Node runtime, and under Node for tests.

// Ordered by what actually answers. Verified from a GitHub runner: adsb.lol
// and adsb.fi both return 200, while airplanes.live returns 403 with a request
// to contact them for access - a policy gate rather than an IP block, so it
// stays last until that access is granted.
export const UPSTREAMS = [
  { name: "adsb.lol", url: (lat, lon, nm) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${nm}` },
  { name: "adsb.fi", url: (lat, lon, nm) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${nm}` },
  { name: "airplanes.live", url: (lat, lon, nm) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${nm}` },
];

// Keeps this from becoming an open ADS-B proxy for the whole world. Israel and
// a wide margin around it; widen if the site ever points at another field.
export const BOUNDS = { minLat: 28.0, maxLat: 35.5, minLon: 32.0, maxLon: 37.5 };
export const MAX_RADIUS_NM = 50;

export const CACHE_SECONDS = 45;
export const STALE_SECONDS = 900;

export const USER_AGENT = "spotil/1.0 (+https://github.com/ronnyil/spotil)";

// Validates and normalises the query. Returns either { error, status } or the
// rounded values to use - rounded so that near-identical requests from
// different visitors share one cache entry.
export function parseQuery({ lat, lon, radius }) {
  if (lat === null || lat === undefined || lat === "" ||
      lon === null || lon === undefined || lon === "") {
    return { error: "lat and lon are required", status: 400 };
  }

  const la = Number(lat);
  const lo = Number(lon);
  const nm = Number(radius ?? 20);

  if (!Number.isFinite(la) || !Number.isFinite(lo) || !Number.isFinite(nm)) {
    return { error: "lat, lon and radius must be numbers", status: 400 };
  }
  if (la < BOUNDS.minLat || la > BOUNDS.maxLat || lo < BOUNDS.minLon || lo > BOUNDS.maxLon) {
    return { error: "outside the area this proxy serves", status: 403 };
  }
  if (nm <= 0 || nm > MAX_RADIUS_NM) {
    return { error: `radius must be between 1 and ${MAX_RADIUS_NM} nm`, status: 400 };
  }

  return { lat: la.toFixed(3), lon: lo.toFixed(3), radius: Math.round(nm) };
}

// Tries each upstream in turn. Resolves to { ok: true, payload } or
// { ok: false, errors } - never throws, so callers can decide what a total
// failure should look like in their runtime.
export async function fetchUpstream(lat, lon, radius, { timeoutMs = 8000, fetchImpl = fetch } = {}) {
  const errors = [];

  for (const upstream of UPSTREAMS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(upstream.url(lat, lon, radius), {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: controller.signal,
      });

      if (!res.ok) {
        // A refusing upstream usually explains itself in the body - a rate
        // limit notice, a block page, or a request to get in touch.
        let hint = "";
        try { hint = ` - ${(await res.text()).replace(/\s+/g, " ").slice(0, 120)}`; } catch {}
        errors.push(`${upstream.name}: HTTP ${res.status}${hint}`);
        continue;
      }

      const body = await res.json();
      const aircraft = body.ac || body.aircraft || [];
      return {
        ok: true,
        payload: {
          ac: aircraft,
          source: upstream.name,
          now: Date.now() / 1000,
          total: aircraft.length,
        },
      };
    } catch (err) {
      errors.push(`${upstream.name}: ${err.name}: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, errors };
}
