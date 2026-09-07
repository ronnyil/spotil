// Live overlay on the LLBG runway diagram.
//
// The base drawing in assets/llbg.svg is static and geometrically real: every
// runway sits where its surveyed threshold coordinates put it. This module adds
// what changes - which runways are in use, which way aircraft are moving, and
// where the recommended spot is - by projecting lat/lon into the same
// coordinate space the drawing uses, declared in airport.json.

import { runwayEnds } from "./runway.js";
import { destinationPoint, bearingTo, haversineNm, compassPoint } from "./geo.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const NM_TO_M = 1852;

// How far from the threshold the approach and departure arrows run. Fixed
// lengths rather than a real distance: a 3 km final would leave the frame, and
// the arrow is there to show direction, not range.
const ARROW_LENGTH = 62;
// Far enough past the threshold to clear the designator drawn there, which the
// arrows previously ran straight through.
const ARROW_GAP = 34;
const MARGIN = 12;

export function project(projection, lat, lon) {
  return {
    x: (lon - projection.originLon) * projection.pxPerDegLon,
    y: (projection.originLat - lat) * projection.pxPerDegLat,
  };
}

// Keeps a point inside the drawing while preserving its direction from the
// airport, so a spot beyond the frame still reads as "over that way".
function clampToFrame(p, frame, margin = MARGIN) {
  const minX = frame.x + margin, maxX = frame.x + frame.w - margin;
  const minY = frame.y + margin, maxY = frame.y + frame.h - margin;
  return {
    x: Math.min(maxX, Math.max(minX, p.x)),
    y: Math.min(maxY, Math.max(minY, p.y)),
    clamped: p.x < minX || p.x > maxX || p.y < minY || p.y > maxY,
  };
}

function el(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function arrowhead(id, className) {
  const marker = el("marker", {
    id, viewBox: "0 0 10 10", refX: "9", refY: "5",
    markerWidth: "5", markerHeight: "5", orient: "auto-start-reverse",
    class: className,
  });
  marker.appendChild(el("path", { d: "M0,1 L9,5 L0,9 z" }));
  return marker;
}

// Draws the live state onto an already-inserted copy of the base SVG.
export function decorate(svg, {
  airport, landingRunway, takeoffRunway, spot, strings,
}) {
  const projection = airport.diagramProjection;
  const frame = projection.frame;
  const ends = runwayEnds(airport);
  const byId = new Map(ends.map((e) => [e.id, e]));

  for (const node of svg.querySelectorAll(".runway, .threshold-label")) {
    node.classList.remove("is-active");
  }
  const overlay = svg.querySelector("#live-overlay");
  overlay.replaceChildren();

  const defs = el("defs", {});
  defs.appendChild(arrowhead("ah-arrive", "ah-arrive"));
  defs.appendChild(arrowhead("ah-depart", "ah-depart"));
  overlay.appendChild(defs);

  const activate = (runwayId) => {
    const end = byId.get(runwayId);
    if (!end) return null;
    svg.querySelector(`#rwy-${end.pair.replace("/", "-")}`)?.classList.add("is-active");
    svg.querySelector(`#label-${runwayId}`)?.classList.add("is-active");
    return end;
  };

  const legend = [];

  // Arrivals: an arrow on the approach side pointing at the threshold, which
  // is the direction a spotter will see aircraft coming from.
  const landing = activate(landingRunway);
  if (landing) {
    const t = project(projection, landing.threshold.lat, landing.threshold.lon);
    const back = (landing.trueBearing + 180) % 360;
    const rad = (back * Math.PI) / 180;
    const ux = Math.sin(rad), uy = -Math.cos(rad);
    const from = clampToFrame(
      { x: t.x + ux * (ARROW_GAP + ARROW_LENGTH), y: t.y + uy * (ARROW_GAP + ARROW_LENGTH) }, frame);
    overlay.appendChild(el("line", {
      class: "arrive-arrow",
      x1: from.x.toFixed(1), y1: from.y.toFixed(1),
      x2: (t.x + ux * ARROW_GAP).toFixed(1), y2: (t.y + uy * ARROW_GAP).toFixed(1),
      "marker-end": "url(#ah-arrive)",
    }));
    legend.push({ kind: "arrive", text: `${strings.arrivalsFrom} ${compassPoint(back)} · ${strings.runway} ${landing.id}` });
  }

  // Departures: an arrow leaving along the climb-out direction.
  const takeoff = activate(takeoffRunway);
  if (takeoff) {
    const t = project(projection, takeoff.threshold.lat, takeoff.threshold.lon);
    const rad = (takeoff.trueBearing * Math.PI) / 180;
    const ux = Math.sin(rad), uy = -Math.cos(rad);
    // Measured from the far end, since that is where a departure leaves the
    // field: the roll starts at this threshold and runs the runway's length.
    const runM = takeoff.lengthM;
    const far = destinationPoint(takeoff.threshold, takeoff.trueBearing, runM / NM_TO_M);
    const f = project(projection, far.lat, far.lon);
    const to = clampToFrame(
      { x: f.x + ux * (ARROW_GAP + ARROW_LENGTH), y: f.y + uy * (ARROW_GAP + ARROW_LENGTH) }, frame);
    overlay.appendChild(el("line", {
      class: "depart-arrow",
      x1: (f.x + ux * ARROW_GAP).toFixed(1), y1: (f.y + uy * ARROW_GAP).toFixed(1),
      x2: to.x.toFixed(1), y2: to.y.toFixed(1),
      "marker-end": "url(#ah-depart)",
    }));
    legend.push({ kind: "depart", text: `${strings.departsTo} ${compassPoint(takeoff.trueBearing)} · ${strings.runway} ${takeoff.id}` });
  }

  if (spot) {
    const raw = project(projection, spot.lat, spot.lon);
    const p = clampToFrame(raw, frame, 18);
    const km = (haversineNm(airport.arp, spot) * NM_TO_M) / 1000;
    overlay.appendChild(el("circle", { class: "spot-halo", cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: "11" }));
    overlay.appendChild(el("circle", { class: "spot-dot", cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: "5.5" }));
    legend.push({
      kind: "spot",
      // Say so when the marker sits on the frame edge rather than at its true
      // position, so the picture is not read as a distance.
      text: `${strings.youStandHere} · ${compassPoint(bearingTo(airport.arp, spot))} ${km.toFixed(1)} km`
        + (p.clamped ? ` ${strings.offMap}` : ""),
    });
  }

  return legend;
}
