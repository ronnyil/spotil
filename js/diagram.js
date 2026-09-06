// A schematic of the airport's runways, drawn from the geometry in
// airport.json rather than from map tiles.
//
// It is deliberately not a map. A spotter's question is "which way are they
// flying, and which side of the field should I be on", and that is answered by
// runway orientation, not by where the taxiways are. Runways are drawn crossing
// at the airport reference point: their bearings and relative lengths are to
// scale, their offsets from each other are not, which is the honest way to draw
// this without the AIP threshold coordinates.

import { runwayEnds } from "./runway.js";
import { haversineNm, bearingTo, compassPoint } from "./geo.js";

const SIZE = 360;              // viewBox is square
const C = SIZE / 2;            // the ARP sits at the centre
const SPAN_M = 9000;           // metres across the full width
const SCALE = SIZE / SPAN_M;   // units per metre
const NM_TO_M = 1852;

const RUNWAY_WIDTH = 9;
const EDGE = 156;              // where approach and departure arrows reach
// Far enough past the threshold to clear the runway designator drawn there.
const ARROW_GAP = 28;
// Spots sit 2-8 km out; drawing them to the same scale as a 4 km runway would
// shrink the runways to illegibility. The marker is placed at a fixed radius on
// its true bearing - the direction is exact, the distance is in the legend.
const SPOT_RADIUS = 118;

// Bearings are compass degrees; SVG y grows downward, so north is -y.
function project(bearingDeg, distUnits) {
  const r = (bearingDeg * Math.PI) / 180;
  return { x: C + distUnits * Math.sin(r), y: C - distUnits * Math.cos(r) };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function renderDiagram({
  airport, landingRunway, takeoffRunway, spot, strings,
}) {
  const ends = runwayEnds(airport);
  const byId = new Map(ends.map((e) => [e.id, e]));

  const parts = [];
  parts.push(`<defs>
    <marker id="ah-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5.5" markerHeight="5.5" orient="auto-start-reverse">
      <path d="M0,1 L9,5 L0,9 z" fill="var(--diag-arrive)"/>
    </marker>
    <marker id="ah-dep" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5.5" markerHeight="5.5" orient="auto-start-reverse">
      <path d="M0,1 L9,5 L0,9 z" fill="var(--diag-depart)"/>
    </marker>
  </defs>`);

  // Inactive runways first so the active ones draw over them.
  const pairs = [...new Set(ends.map((e) => e.pair))];
  const activeIds = new Set([landingRunway, takeoffRunway].filter(Boolean));

  for (const pair of pairs) {
    const [a, b] = ends.filter((e) => e.pair === pair);
    const isActive = activeIds.has(a.id) || activeIds.has(b.id);
    const half = (a.lengthM * SCALE) / 2;
    const p1 = project(a.trueBearing, half);
    const p2 = project(b.trueBearing, half);

    parts.push(
      `<line x1="${p1.x.toFixed(1)}" y1="${p1.y.toFixed(1)}" x2="${p2.x.toFixed(1)}" y2="${p2.y.toFixed(1)}" ` +
      `stroke="${isActive ? "var(--diag-active)" : "var(--diag-idle)"}" ` +
      `stroke-width="${RUNWAY_WIDTH}" stroke-linecap="butt" opacity="${isActive ? 1 : 0.45}"/>`
    );

    // Designators sit just beyond each threshold, upright regardless of the
    // runway's angle - a rotated label is harder to read than a level one.
    for (const end of [a, b]) {
      const p = project(end.trueBearing, half + 13);
      const on = activeIds.has(end.id);
      parts.push(
        `<text x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" class="rwy-label${on ? " on" : ""}" ` +
        `text-anchor="middle" dominant-baseline="central">${esc(end.id)}</text>`
      );
    }
  }

  // Arrivals: an arrow on the approach side, pointing at the threshold, which
  // is the direction a spotter will actually see aircraft coming from.
  if (landingRunway && byId.has(landingRunway)) {
    const e = byId.get(landingRunway);
    const from = (e.trueBearing + 180) % 360;
    const half = (e.lengthM * SCALE) / 2;
    const start = project(from, EDGE);
    const stop = project(from, half + ARROW_GAP);
    parts.push(
      `<line x1="${start.x.toFixed(1)}" y1="${start.y.toFixed(1)}" x2="${stop.x.toFixed(1)}" y2="${stop.y.toFixed(1)}" ` +
      `stroke="var(--diag-arrive)" stroke-width="2.5" stroke-dasharray="7 5" marker-end="url(#ah-arr)"/>`
    );
  }

  // Departures: an arrow leaving the field along the climb-out direction.
  if (takeoffRunway && byId.has(takeoffRunway)) {
    const e = byId.get(takeoffRunway);
    const half = (e.lengthM * SCALE) / 2;
    const start = project(e.trueBearing, half + ARROW_GAP);
    const stop = project(e.trueBearing, EDGE);
    parts.push(
      `<line x1="${start.x.toFixed(1)}" y1="${start.y.toFixed(1)}" x2="${stop.x.toFixed(1)}" y2="${stop.y.toFixed(1)}" ` +
      `stroke="var(--diag-depart)" stroke-width="2.5" marker-end="url(#ah-dep)"/>`
    );
  }

  // The recommended spot, at its true bearing and distance from the field, so
  // the picture answers "which side am I standing on" as well.
  if (spot) {
    const brg = bearingTo(airport.arp, spot);
    const p = project(brg, SPOT_RADIUS);
    parts.push(
      `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="10" class="spot-halo"/>` +
      `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5.5" class="spot-dot"/>`
    );
  }

  // North, so the orientation is never in doubt.
  parts.push(
    `<g class="compass" transform="translate(26,26)">` +
    `<line x1="0" y1="13" x2="0" y2="-9" stroke="currentColor" stroke-width="1.5"/>` +
    `<path d="M-4,-9 L0,-16 L4,-9 z" fill="currentColor"/>` +
    `<text x="0" y="24" text-anchor="middle" dominant-baseline="central">N</text></g>`
  );

  const legend = [];
  if (landingRunway && byId.has(landingRunway)) {
    const e = byId.get(landingRunway);
    legend.push({
      kind: "arrive",
      text: `${strings.arrivalsFrom} ${compassPoint((e.trueBearing + 180) % 360)} · ${strings.runway} ${e.id}`,
    });
  }
  if (takeoffRunway && byId.has(takeoffRunway)) {
    const e = byId.get(takeoffRunway);
    legend.push({
      kind: "depart",
      text: `${strings.departsTo} ${compassPoint(e.trueBearing)} · ${strings.runway} ${e.id}`,
    });
  }
  if (spot) {
    const km = (haversineNm(airport.arp, spot) * NM_TO_M) / 1000;
    legend.push({
      kind: "spot",
      text: `${strings.youStandHere} · ${compassPoint(bearingTo(airport.arp, spot))} ${km.toFixed(1)} km`,
    });
  }

  return {
    svg: `<svg viewBox="0 0 ${SIZE} ${SIZE}" role="img" aria-label="${esc(strings.diagramAlt)}">${parts.join("")}</svg>`,
    legend,
  };
}
