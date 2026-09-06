// Cloudflare Worker deployment of the ADS-B proxy.
//
// NOT the active deployment. Cloudflare's shared egress IPs are refused by the
// upstreams - a CI probe showed adsb.lol returning 429 and adsb.fi 403 to this
// Worker, while the same endpoints returned 200 from a GitHub runner moments
// later. The live proxy is api/adsb.js on Vercel's Node runtime.
//
// Kept because the block is on Cloudflare's IP reputation rather than on
// anything this code does, so it may become usable again - and because
// airplanes.live granting access would make it viable immediately.
//
// Deploy: wrangler deploy (see README).

import {
  parseQuery, fetchUpstream, CACHE_SECONDS, STALE_SECONDS,
} from "../shared/adsb-core.js";

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
    const parsed = parseQuery({
      lat: params.get("lat"),
      lon: params.get("lon"),
      radius: params.get("radius"),
    });
    if (parsed.error) return json({ error: parsed.error }, parsed.status);

    const { lat, lon, radius } = parsed;
    const keyFor = (kind) =>
      new Request(`https://adsb-proxy.invalid/${kind}?lat=${lat}&lon=${lon}&radius=${radius}`,
                  { method: "GET" });
    const cache = globalThis.caches?.default;

    const cached = cache ? await cache.match(keyFor("v1")) : undefined;
    if (cached) return cached;

    const result = await fetchUpstream(lat, lon, radius);

    if (result.ok) {
      const out = json(result.payload, 200, {
        "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
      });
      if (cache) {
        await cache.put(keyFor("v1"), out.clone());
        await cache.put(
          keyFor("last-good"),
          json(result.payload, 200, { "Cache-Control": `public, max-age=${STALE_SECONDS}` })
        );
      }
      return out;
    }

    // Every upstream refused. Slightly old traffic still identifies the runway
    // in use; a 502 identifies nothing.
    const lastGood = cache ? await cache.match(keyFor("last-good")) : undefined;
    if (lastGood) {
      const body = await lastGood.json();
      return json(
        {
          ...body,
          stale: true,
          ageSeconds: Math.max(0, Math.round(Date.now() / 1000 - body.now)),
          staleReason: result.errors,
        },
        200,
        { "Cache-Control": "no-store" }
      );
    }

    return json({ error: "no upstream reachable", detail: result.errors }, 502, {
      "Cache-Control": "no-store",
    });
  },
};
