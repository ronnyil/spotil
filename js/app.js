import { fetchAircraft } from "./adsb.js";
import { RunwayTracker } from "./runway.js";
import { resolveRunways, rankSpots, navLinks } from "./recommend.js";
import { STRINGS, t } from "./i18n.js";
import { decorate } from "./diagram.js";

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
};

const $ = (sel) => document.querySelector(sel);

async function boot() {
  // Cache-busted so a returning visitor never runs on a stale proxy URL or an
  // out-of-date spot list; these files are small and change rarely.
  const v = Date.now();
  const [airport, spotFile, config, diagramSvg] = await Promise.all([
    fetch(`data/airport.json?v=${v}`).then((r) => r.json()),
    fetch(`data/spots.json?v=${v}`).then((r) => r.json()),
    // Running without a proxy is a valid configuration, so a missing or broken
    // config file must not stop the page from loading.
    fetch(`data/config.json?v=${v}`).then((r) => r.json()).catch(() => ({})),
    // The diagram is a static asset; a failure to load it must not stop the
    // page, which answers the question perfectly well without a picture.
    fetch(`assets/llbg.svg?v=${v}`).then((r) => r.text()).catch(() => ""),
  ]);
  state.airport = airport;
  state.spots = spotFile.spots;
  state.proxy = config.adsbProxy || "";
  if (diagramSvg) $("#diagram").innerHTML = diagramSvg;
  state.tracker = new RunwayTracker(airport);

  applyLanguage();
  wireControls();

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

  for (const button of document.querySelectorAll(".op")) {
    button.addEventListener("click", () => {
      state.operation = button.dataset.op;
      for (const other of document.querySelectorAll(".op")) {
        const on = other === button;
        other.classList.toggle("is-selected", on);
        other.setAttribute("aria-pressed", String(on));
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
  for (const button of document.querySelectorAll(".op")) {
    button.setAttribute("aria-label", t(state.lang, button.dataset.op));
  }
  document.documentElement.lang = state.lang;
  document.documentElement.dir = s.dir;
  $("#langToggle").textContent = state.lang === "en" ? "עברית" : "English";
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = t(state.lang, el.dataset.i18n);
  }
}

async function refresh() {
  const { lat, lon } = state.airport.arp;
  try {
    const res = await fetchAircraft(lat, lon, FETCH_RADIUS_NM, { proxy: state.proxy });
    // Only feed genuinely new data to the tracker. Re-observing the same
    // snapshot would keep refreshing each vote's timestamp, so stale data
    // would read as live and never decay.
    if (res.payloadTime !== state.lastPayloadTime) {
      state.tracker.observe(res.aircraft);
      state.lastPayloadTime = res.payloadTime;
    }
    state.liveAircraft = res.aircraft;
    state.source = res.source;
    state.staleAge = res.stale ? res.ageSeconds : null;
    state.error = null;
  } catch (err) {
    state.error = err.message;
    state.staleAge = null;
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
  renderDiagram();
}

function renderDiagram() {
  const svg = document.querySelector("#diagram svg");
  const r = state.resolved;
  if (!svg || !r) return;

  // Show the spot for whichever operation is selected, so the picture and the
  // recommendation below it always agree.
  const op = state.operation;
  const top = rankSpots(state.spots, state.airport, r[op].runway, op, {
    from: state.userPosition,
  })[0];

  const legend = decorate(svg, {
    airport: state.airport,
    landingRunway: r.landing.runway,
    takeoffRunway: r.takeoff.runway,
    spot: top?.spot ?? null,
    strings: STRINGS[state.lang],
  });

  const host = document.querySelector("#diagram");
  host.querySelector(".diagram-legend")?.remove();
  if (!legend.length) return;
  const ul = document.createElement("ul");
  ul.className = "diagram-legend";
  ul.innerHTML = legend.map((i) => `<li class="lg-${i.kind}"><span class="key"></span>${i.text}</li>`).join("");
  host.appendChild(ul);
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
    const basisText = t(state.lang, data.basis === "observed" ? "observedShort"
      : data.basis === "predicted" ? "predictedShort" : "unknownShort");
    // A live reading from one aircraft and one from eight are both "live", so
    // show the count rather than letting the label imply equal weight.
    const n = data.basis === "observed" ? (data.aircraft?.length ?? 0) : 0;
    const suffix = n ? ` · ${n} ${t(state.lang, n === 1 ? "aircraftOne" : "aircraft")}` : "";
    basisEl.innerHTML = `<span class="dot"></span>${basisText}${suffix}`;

    // A prediction has no measured confidence, so show the bar only for a
    // live reading rather than implying certainty we do not have.
    const pct = data.basis === "observed" ? Math.round(data.confidence * 100) : 0;
    meterEl.style.width = `${pct}%`;
    meterEl.parentElement.classList.toggle("predicted-meter", data.basis !== "observed");
  }

  const note = $("#modeNote");
  const predicted = r.landing.basis !== "observed" || r.takeoff.basis !== "observed";
  if (state.error) {
    note.innerHTML = `${t(state.lang, "error")} <a href="debug.html">${t(state.lang, "diagnose")} \u2192</a>`;
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
  if (state.staleAge != null) {
    const mins = Math.floor(state.staleAge / 60);
    const readable = mins >= 1 ? `${mins} min` : `${state.staleAge}s`;
    bits.push(`⚠ ${t(lang, "staleData")} ${readable}`);
  }
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

boot().catch((err) => {
  document.querySelector("#status").textContent = `Startup failed: ${err.message}`;
});
