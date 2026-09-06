// Vercel serverless function: the ADS-B proxy.
//
// Deliberately the Node.js runtime, not the Edge runtime. Vercel's Edge
// Functions run on Cloudflare's network, which is precisely the network these
// upstreams refuse - a CI probe showed adsb.lol and adsb.fi returning 200 from
// a GitHub runner while the Cloudflare Worker got 429 and 403 from the same
// endpoints. The Node runtime runs on AWS and is not caught by that.
//
// Caching is left to Vercel's CDN via the Cache-Control header rather than
// done in the function: s-maxage caps how often upstream is polled no matter
// how many people are using the site, and stale-while-revalidate keeps serving
// the last good response for fifteen minutes while a refresh is attempted in
// the background. That is the same behaviour the Worker implemented by hand.

import {
  parseQuery, fetchUpstream, CACHE_SECONDS, STALE_SECONDS,
} from "../shared/adsb-core.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

export default async function handler(req, res) {
  for (const [key, value] of Object.entries(CORS)) res.setHeader(key, value);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    return res.status(405).json({ error: "method not allowed" });
  }

  const parsed = parseQuery({
    lat: req.query.lat,
    lon: req.query.lon,
    radius: req.query.radius,
  });
  if (parsed.error) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(parsed.status).json({ error: parsed.error });
  }

  const result = await fetchUpstream(parsed.lat, parsed.lon, parsed.radius);

  if (result.ok) {
    res.setHeader(
      "Cache-Control",
      `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${STALE_SECONDS}`
    );
    return res.status(200).json(result.payload);
  }

  // Never cache a total failure: the next request should get a fresh attempt,
  // and the CDN will keep serving the previous good response on its own while
  // the stale-while-revalidate window lasts.
  res.setHeader("Cache-Control", "no-store");
  return res.status(502).json({ error: "no upstream reachable", detail: result.errors });
}
