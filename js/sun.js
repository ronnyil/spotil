// Solar position from the NOAA solar calculator equations. Accurate to well
// under a degree, which is far more than a "is this spot backlit" call needs.

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

function julianDay(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

// Returns { azimuth, elevation } in degrees. Azimuth is measured clockwise
// from true north.
export function sunPosition(date, lat, lon) {
  const jc = (julianDay(date) - 2451545) / 36525;

  const geomMeanLong = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360;
  const geomMeanAnom = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
  const eccent = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);

  const sunEqCtr =
    Math.sin(toRad(geomMeanAnom)) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) +
    Math.sin(toRad(2 * geomMeanAnom)) * (0.019993 - 0.000101 * jc) +
    Math.sin(toRad(3 * geomMeanAnom)) * 0.000289;

  const sunTrueLong = geomMeanLong + sunEqCtr;
  const omega = 125.04 - 1934.136 * jc;
  const sunAppLong = sunTrueLong - 0.00569 - 0.00478 * Math.sin(toRad(omega));

  const meanObliq =
    23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
  const obliqCorr = meanObliq + 0.00256 * Math.cos(toRad(omega));

  const declination = toDeg(
    Math.asin(Math.sin(toRad(obliqCorr)) * Math.sin(toRad(sunAppLong)))
  );

  const varY = Math.tan(toRad(obliqCorr / 2)) ** 2;
  const eqOfTime =
    4 *
    toDeg(
      varY * Math.sin(2 * toRad(geomMeanLong)) -
        2 * eccent * Math.sin(toRad(geomMeanAnom)) +
        4 * eccent * varY * Math.sin(toRad(geomMeanAnom)) * Math.cos(2 * toRad(geomMeanLong)) -
        0.5 * varY * varY * Math.sin(4 * toRad(geomMeanLong)) -
        1.25 * eccent * eccent * Math.sin(2 * toRad(geomMeanAnom))
    );

  // Minutes past UTC midnight, so no local-timezone assumptions leak in.
  const minutesUtc =
    date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const trueSolarTime = (minutesUtc + eqOfTime + 4 * lon + 1440) % 1440;
  const hourAngle = trueSolarTime / 4 < 0 ? trueSolarTime / 4 + 180 : trueSolarTime / 4 - 180;

  const zenith = toDeg(
    Math.acos(
      Math.sin(toRad(lat)) * Math.sin(toRad(declination)) +
        Math.cos(toRad(lat)) * Math.cos(toRad(declination)) * Math.cos(toRad(hourAngle))
    )
  );
  const elevation = 90 - zenith;

  let azimuth;
  const denom = Math.cos(toRad(lat)) * Math.sin(toRad(zenith));
  if (Math.abs(denom) > 1e-9) {
    let a = toDeg(
      Math.acos(
        Math.max(-1, Math.min(1,
          (Math.sin(toRad(lat)) * Math.cos(toRad(zenith)) - Math.sin(toRad(declination))) / denom
        ))
      )
    );
    azimuth = hourAngle > 0 ? (a + 180) % 360 : (540 - a) % 360;
  } else {
    azimuth = declination > lat ? 0 : 180;
  }

  return { azimuth, elevation };
}

// How good the light is for shooting an aircraft that sits at `targetBearing`
// from the photographer. Sun behind the photographer is ideal.
// Returns { score: 0..1, label, elevation, azimuth }.
export function lightQuality(date, lat, lon, targetBearing) {
  const { azimuth, elevation } = sunPosition(date, lat, lon);

  if (elevation < -6) {
    return { score: 0.15, label: "night", azimuth, elevation };
  }
  if (elevation < 0) {
    return { score: 0.35, label: "twilight", azimuth, elevation };
  }

  // 0 deg = sun directly behind the aircraft (backlit), 180 = sun over your
  // shoulder onto the aircraft (ideal).
  const rel = Math.abs((((targetBearing - azimuth) % 360) + 540) % 360 - 180);
  let score = rel / 180;

  let label;
  if (rel < 45) label = "backlit";
  else if (rel < 100) label = "side-lit";
  else label = "sun behind you";

  // Very low sun is warm and lovely but grazing; very high sun is flat.
  if (elevation < 10) {
    score *= 0.9;
    if (label === "sun behind you") label = "golden hour";
  } else if (elevation > 70) {
    score *= 0.85;
    label = "harsh overhead";
  }

  return { score, label, azimuth, elevation };
}
