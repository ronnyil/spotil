import { fetchAircraft } from "./adsb.js";
import { RunwayTracker, runwayEnds } from "./runway.js";
import { resolveRunways, rankSpots, navLinks } from "./recommend.js";
import { destinationPoint, haversineNm } from "./geo.js";
import { STRINGS, t } from "./i18n.js";

const REFRESH_MS = 20000;
const FETCH_RADIUS_NM = 20;

const state = {
  lang: localStorage.getItem("tlv.lang") || "en",
  operation: "landing",
  userPosition: null,
  airport: null,
  spots: [],
  tracker: null,
  resolved: null,
  lastFetch: null,
  source: null,
  error: null,
  map: null,
  layers: {},
};

const $ = (sel) => document.querySelector(sel);

async function boot() {
  const [airport, spotFile] = await Promise.all([
    fetch("data/airport.json").then((r) => r.json()),
    fetch("data/spots.json").then((r) => r.json()),
  ]);
  state.airport = airport;
  state.spots = spotFile.spots;
  state.tracker = new RunwayTracker(airport);

  applyLanguage();
  wireControls();
  initMap();

  await refresh();
  setInterval(refresh, REFRESH_MS);
  setInterval(renderStatus, 1000);
}

function wireControls() {
  $("#langToggle").addEventListener("click", () => {
    state.lang = state.lang === "en" ? "he" : "en";
    localStorage.setItem("tlv.lang", state.lang);
    applyLanguage();
    render();
  });

  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => {
      state.operation = tab.dataset.op;
      for (const other of document.querySelectorAll(".tab")) {
        const on = other === tab;
        other.classList.toggle("active", on);
        other.setAttribute("aria-selected", String(on));
      }
      render();
    });
  }

  const safety = $("#safety");
  if (localStorage.getItem("tlv.safetyAck") !== "1") safety.hidden = false;
  $("#safetyDismiss").addEventListener("click", () => {
    localStorage.setItem("tlv.safetyAck", "1");
    safety.hidden = true;
  });
}

function applyLanguage() {
  const s = STRINGS[state.lang];
  document.documentElement.lang = state.lang;
  document.documentElement.dir = s.dir;
  $("#langToggle").textContent = state.lang === "en" ? "עברית" : "English";
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = t(state.lang, el.dataset.i18n);
  }
  document.querySelector('.tab[data-op="landing"]').textContent = t(state.lang, "landing");
  document.querySelector('.tab[data-op="takeoff"]').textContent = t(state.lang, "takeoff");
}

async function refresh() {
  const { lat, lon } = state.airport.arp;
  try {
    const { aircraft, source } = await fetchAircraft(lat, lon, FETCH_RADIUS_NM);
    state.tracker.observe(aircraft);
    state.liveAircraft = aircraft;
    state.source = source;
    state.error = null;
  } catch (err) {
    state.error = err.message;
  }
  state.lastFetch = Date.now();
  state.resolved = resolveRunways(state.tracker.summary(), state.airport);
  render();
}

function render() {
  renderConfig();
  renderRecommendation();
  renderTraffic();
  renderStatus();
  renderMap();
}

function renderConfig() {
  const r = state.resolved;
  if (!r) return;

  for (const op of ["landing", "takeoff"]) {
    const data = r[op];
    const rwyEl = $(`#${op}Rwy`);
    const basisEl = $(`#${op}Basis`);
    const meterEl = $(`#${op}Meter`);

    if (data.runway) {
      rwyEl.textContent = data.runway;
      rwyEl.classList.remove("unknown");
    } else {
      rwyEl.textContent = t(state.lang, "unknown");
      rwyEl.classList.add("unknown");
    }

    basisEl.className = `basis ${data.basis}`;
    basisEl.innerHTML = `<span class="dot"></span>${t(state.lang, data.basis === "observed" ? "observed" : data.basis === "predicted" ? "predicted" : "unknown")}`;

    // A prediction has no measured confidence, so show the bar only for a
    // live reading rather than implying certainty we do not have.
    const pct = data.basis === "observed" ? Math.round(data.confidence * 100) : 0;
    meterEl.style.width = `${pct}%`;
    meterEl.parentElement.classList.toggle("predicted-meter", data.basis !== "observed");
  }

  const note = $("#modeNote");
  const predicted = r.landing.basis !== "observed" || r.takeoff.basis !== "observed";
  if (state.error) {
    note.textContent = t(state.lang, "error");
    note.hidden = false;
  } else if (r.landing.basis === "unknown") {
    note.textContent = t(state.lang, "nightNote");
    note.hidden = false;
  } else if (predicted) {
    note.textContent = t(state.lang, "predictedNote");
    note.hidden = false;
  } else {
    note.hidden = true;
  }
}

function renderRecommendation() {
  const host = $("#recommendation");
  const r = state.resolved;
  host.innerHTML = "";
  if (!r) return;

  const op = state.operation;
  const runway = r[op].runway;
  const ranked = rankSpots(state.spots, state.airport, runway, op, {
    from: state.userPosition,
  });

  if (ranked.length === 0) {
    host.innerHTML = `<div class="spot"><p class="detail">${t(state.lang, "noSpot")}</p></div>`;
    return;
  }

  ranked.forEach((rec, i) => host.appendChild(spotCard(rec, i === 0, runway)));
}

function spotCard(rec, primary, runway) {
  const lang = state.lang;
  const { spot, light } = rec;
  const el = document.createElement("article");
  el.className = `spot${primary ? " primary" : ""}`;

  const links = navLinks(spot, lang);
  const lightLabel = STRINGS[lang].lightLabels[light.label] || light.label;
  const name = spot.name[lang] || spot.name.en;
  const otherName = lang === "en" ? spot.name.he : spot.name.en;

  const facts = [
    `<li>${t(lang, "runway")} ${runway}</li>`,
    `<li>${t(lang, "lookDirection")}: ${rec.lookCompass} (${Math.round(rec.lookBearing)}°)</li>`,
    `<li class="${light.score > 0.55 ? "good" : light.score < 0.3 ? "bad" : ""}">${t(lang, "light")}: ${lightLabel}</li>`,
    `<li>${t(lang, "quality")}: ${"★".repeat(rec.quality)}${"☆".repeat(5 - rec.quality)}</li>`,
  ];
  if (rec.distanceNm !== null) {
    facts.push(`<li>${Math.round(rec.distanceNm * 1.852)} ${t(lang, "km")} ${t(lang, "away")}</li>`);
  }
  if (spot.facilities?.parking === false) {
    facts.push(`<li class="bad">${lang === "en" ? "No parking" : "אין חניה"}</li>`);
  } else if (spot.facilities?.parking) {
    facts.push(`<li class="good">${lang === "en" ? "Parking" : "חניה"}</li>`);
  }
  if (spot.facilities?.food) facts.push(`<li>${lang === "en" ? "Food" : "אוכל"}</li>`);

  const details = [];
  if (spot.warning) details.push(`<p class="detail warn">⚠ ${spot.warning[lang] || spot.warning.en}</p>`);
  if (spot.directions) details.push(`<p class="detail">${spot.directions[lang] || spot.directions.en}</p>`);
  if (spot.notes) details.push(`<p class="detail">${spot.notes[lang] || spot.notes.en}</p>`);

  el.innerHTML = `
    ${primary ? `<p class="rank">${t(lang, "goHere")}</p>` : ""}
    <h3>${name}</h3>
    <p class="he-name" dir="auto">${otherName || ""}</p>
    <ul class="facts">${facts.join("")}</ul>
    ${details.join("")}
    ${spot.coordsApproximate ? `<p class="approx">📍 ${t(lang, "approxPin")}</p>` : ""}
    <div class="actions">
      <a href="${links.waze}" target="_blank" rel="noopener">${t(lang, "waze")}</a>
      <a class="secondary" href="${links.google}" target="_blank" rel="noopener">${t(lang, "maps")}</a>
    </div>
  `;
  return el;
}

function renderTraffic() {
  const list = $("#trafficList");
  const r = state.resolved;
  list.innerHTML = "";
  if (!r) return;

  const seen = [...(r.landing.aircraft || []), ...(r.takeoff.aircraft || [])]
    .sort((a, b) => b.at - a.at)
    .slice(0, 8);

  if (seen.length === 0) {
    list.innerHTML = `<li class="empty">${t(state.lang, "noTraffic")}</li>`;
    return;
  }

  for (const v of seen) {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="cs">${v.ac.callsign || v.ac.hex}</span>
      <span class="op">${t(state.lang, v.operation)} ${v.runway}</span>
      <span class="meta">${v.ac.type || ""} ${Math.round(v.altAgl)} ft · ${v.distNm.toFixed(1)} nm</span>
    `;
    list.appendChild(li);
  }
}

function renderStatus() {
  const el = $("#status");
  if (!state.lastFetch) return;
  const age = Math.round((Date.now() - state.lastFetch) / 1000);
  const lang = state.lang;

  if (state.error) {
    el.className = "status error";
    el.textContent = `${t(lang, "error")} (${state.error})`;
    return;
  }

  el.className = "status";
  const bits = [
    `${t(lang, "updated")} ${age} ${t(lang, "secondsAgo")}`,
    `${t(lang, "source")}: ${state.source}`,
    `${t(lang, "tracking")} ${state.resolved?.trackedAircraft ?? 0} ${t(lang, "aircraft")}`,
  ];
  el.textContent = bits.join(" · ");

  if (!el.dataset.wired) {
    el.dataset.wired = "1";
    const btn = document.createElement("button");
    btn.id = "locBtn";
    btn.className = "btn-loc";
    btn.type = "button";
    btn.addEventListener("click", requestLocation);
    el.after(btn);
  }
  $("#locBtn").textContent = t(lang, "useMyLocation");
}

function requestLocation() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.userPosition = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      render();
    },
    () => {},
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }
  );
}

function initMap() {
  // Leaflet is a progressive enhancement - without it the page still answers
  // the question, so drop the empty map frame rather than showing a blank box.
  if (typeof L === "undefined") {
    document.querySelector(".mapwrap").hidden = true;
    return;
  }
  const { lat, lon } = state.airport.arp;
  state.map = L.map("map", { scrollWheelZoom: false }).setView([lat, lon], 11);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap",
  }).addTo(state.map);

  // Extended centrelines, so it is obvious where the aircraft will be.
  for (const end of runwayEnds(state.airport)) {
    const far = destinationPoint(state.airport.arp, end.trueBearing, 8);
    L.polyline([[lat, lon], [far.lat, far.lon]], {
      color: "#94a3b8", weight: 1, dashArray: "4 6", interactive: false,
    }).addTo(state.map).bindTooltip(end.id, { permanent: false });
  }

  state.layers.spots = L.layerGroup().addTo(state.map);
  state.layers.aircraft = L.layerGroup().addTo(state.map);
}

function renderMap() {
  if (!state.map || !state.resolved) return;
  const op = state.operation;
  const runway = state.resolved[op].runway;
  const ranked = rankSpots(state.spots, state.airport, runway, op, { from: state.userPosition });
  const topId = ranked[0]?.spot.id;

  state.layers.spots.clearLayers();
  for (const spot of state.spots) {
    const active = ranked.some((r) => r.spot.id === spot.id);
    const isTop = spot.id === topId;
    L.circleMarker([spot.lat, spot.lon], {
      radius: isTop ? 10 : 6,
      color: isTop ? "#0b6bcb" : active ? "#1a7f52" : "#94a3b8",
      weight: isTop ? 3 : 2,
      fillOpacity: active ? 0.7 : 0.25,
    })
      .bindPopup(`<strong>${spot.name[state.lang] || spot.name.en}</strong>`)
      .addTo(state.layers.spots);
  }

  state.layers.aircraft.clearLayers();
  for (const ac of state.liveAircraft || []) {
    if (haversineNm(state.airport.arp, ac) > 15) continue;
    L.circleMarker([ac.lat, ac.lon], {
      radius: 3, color: "#f59e0b", weight: 1, fillOpacity: 0.9, interactive: false,
    }).addTo(state.layers.aircraft);
  }
}

boot().catch((err) => {
  document.querySelector("#status").textContent = `Startup failed: ${err.message}`;
});
