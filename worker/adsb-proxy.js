// Cloudflare Worker: server-side proxy for community ADS-B data.
//
// The community ADS-B networks serve no Access-Control-Allow-Origin header, so
// a browser cannot read them directly from the site's origin. This sits in
// front of them, adds the CORS header, and caches briefly so that many
// spotters using the site at once still produce only a trickle of upstream
// requests - which is what these volunteer-run networks ask for.
//
// Deploy: see README.md. No API keys, no environment variables.

const UPSTREAMS = [
  { name: "airplanes.live", url: (lat, lon, nm) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${nm}` },
  { name: "adsb.lol", url: (lat, lon, nm) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${nm}` },
  { name: "adsb.fi", url: (lat, lon, nm) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${nm}` },
];

// Upstream is polled at most this often per distinct query, no matter how many
// visitors the site has.
const CACHE_SECONDS = 10;

// Keeps this from becoming an open ADS-B proxy for the whole world. Israel and
// a wide margin around it; widen if you ever point the site at another field.
const BOUNDS = { minLat: 28.0, maxLat: 35.5, minLon: 32.0, maxLon: 37.5 };
const MAX_RADIUS_NM = 50;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extra },
  });
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== "GET") {
      return json({ error: "method not allowed" }, 405);
    }

    const params = new URL(request.url).searchParams;
    const rawLat = params.get("lat");
    const rawLon = params.get("lon");

    // Number(null) is 0, which would sail past a finite check and then fail the
    // bounds test with a misleading message, so absence is checked first.
    if (rawLat === null || rawLon === null) {
      return json({ error: "lat and lon are required" }, 400);
    }

    const lat = Number(rawLat);
    const lon = Number(rawLon);
    const radius = Number(params.get("radius") ?? 20);

    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(radius)) {
      return json({ error: "lat, lon and radius must be numbers" }, 400);
    }
    if (lat < BOUNDS.minLat || lat > BOUNDS.maxLat || lon < BOUNDS.minLon || lon > BOUNDS.maxLon) {
      return json({ error: "outside the area this proxy serves" }, 403);
    }
    if (radius <= 0 || radius > MAX_RADIUS_NM) {
      return json({ error: `radius must be between 1 and ${MAX_RADIUS_NM} nm` }, 400);
    }

    // Round the key so near-identical queries from different visitors share one
    // cached upstream response instead of each triggering their own.
    const la = lat.toFixed(3), lo = lon.toFixed(3), nm = Math.round(radius);
    const cacheKey = new Request(
      `https://adsb-proxy.invalid/v1?lat=${la}&lon=${lo}&radius=${nm}`,
      { method: "GET" }
    );
    const cache = globalThis.caches?.default;

    const cached = cache ? await cache.match(cacheKey) : undefined;
    if (cached) return cached;

    const errors = [];
    for (const upstream of UPSTREAMS) {
      try {
        const res = await fetch(upstream.url(la, lo, nm), {
          headers: {
            Accept: "application/json",
            // These networks ask that clients identify themselves.
            "User-Agent": "spotil/1.0 (+https://github.com/ronnyil/spotil)",
          },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) {
          errors.push(`${upstream.name}: HTTP ${res.status}`);
          continue;
        }
        const body = await res.json();
        const aircraft = body.ac || body.aircraft || [];

        const out = json(
          { ac: aircraft, source: upstream.name, now: Date.now() / 1000, total: aircraft.length },
          200,
          { "Cache-Control": `public, max-age=${CACHE_SECONDS}` }
        );
        if (cache) await cache.put(cacheKey, out.clone());
        return out;
      } catch (err) {
        errors.push(`${upstream.name}: ${err.message}`);
      }
    }

    // Never cache a total failure - the next visitor should get a fresh try.
    return json({ error: "no upstream reachable", detail: errors }, 502, {
      "Cache-Control": "no-store",
    });
  },
};
