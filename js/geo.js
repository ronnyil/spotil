// Geographic helpers. All bearings in degrees true, distances in nautical miles
// unless a name says otherwise.

export const NM_PER_KM = 0.539957;
const R_KM = 6371.0088;

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

export function haversineNm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h))) * NM_PER_KM;
}

// Initial great-circle bearing from a to b.
export function bearingTo(a, b) {
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(la2);
  const x =
    Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return norm360(toDeg(Math.atan2(y, x)));
}

export function norm360(deg) {
  return ((deg % 360) + 360) % 360;
}

// Smallest absolute difference between two bearings, 0..180.
export function angleDiff(a, b) {
  const d = Math.abs(norm360(a) - norm360(b)) % 360;
  return d > 180 ? 360 - d : d;
}

// Signed difference b - a, -180..180. Positive means b is clockwise of a.
export function signedDiff(a, b) {
  return ((norm360(b - a) + 540) % 360) - 180;
}

export function reciprocal(deg) {
  return norm360(deg + 180);
}

// Perpendicular distance from a point to the line through `origin` running
// along `bearing`. Uses the flat-earth approximation, fine at these ranges.
export function crossTrackNm(origin, point, bearing) {
  const d = haversineNm(origin, point);
  const brg = bearingTo(origin, point);
  return Math.abs(d * Math.sin(toRad(signedDiff(bearing, brg))));
}

// Distance along the `bearing` axis. Negative means behind the origin.
export function alongTrackNm(origin, point, bearing) {
  const d = haversineNm(origin, point);
  const brg = bearingTo(origin, point);
  return d * Math.cos(toRad(signedDiff(bearing, brg)));
}

export function compassPoint(deg) {
  const pts = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
               "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return pts[Math.round(norm360(deg) / 22.5) % 16];
}

// Point reached by travelling `distNm` from `origin` along `bearing`.
export function destinationPoint(origin, bearing, distNm) {
  const d = (distNm / NM_PER_KM) / R_KM;
  const br = toRad(bearing);
  const la1 = toRad(origin.lat);
  const lo1 = toRad(origin.lon);
  const la2 = Math.asin(
    Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br)
  );
  const lo2 =
    lo1 +
    Math.atan2(
      Math.sin(br) * Math.sin(d) * Math.cos(la1),
      Math.cos(d) - Math.sin(la1) * Math.sin(la2)
    );
  return { lat: toDeg(la2), lon: ((toDeg(lo2) + 540) % 360) - 180 };
}
