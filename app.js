// MileMark main app. Renders the featured run (+map), more-run cards, the wall,
// and the player's points/level card. State lives in localStorage via data.js (MM).

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let activeRunId = null; // which run the sheet is registering for
let leafletMap = null;

// ---------- profile / level card ----------
function renderProfile() {
  const p = MM.me();
  const card = $("#profileCard");
  if (!p) {
    card.hidden = true;
    return;
  }
  const lvl = MM.levelFor(p.points);
  card.hidden = false;
  const av = $("#pcAvatar");
  av.textContent = MM.initials(p.alias);
  av.style.background = MM.avatarColor(p.alias);
  $("#pcName").textContent = p.alias;
  $("#pcLevel").textContent = "lvl " + (lvl.index + 1) + " · " + lvl.name;
  $("#pcPoints").textContent = p.points;
  $("#pcRuns").textContent = p.runs.length;
  $("#pcNext").textContent = lvl.next
    ? lvl.toNext + " pts to “" + lvl.next.name + "”"
    : "maxed out 🏆";
  $("#pcBarFill").style.width = Math.round(lvl.progress * 100) + "%";
}

// ---------- featured run ----------
function renderFeatured() {
  const run = MM.featuredRun();
  if (!run) return;
  activeRunId = run.id;
  $("#runTitle").textContent = run.title;
  $("#runBlurb").textContent = run.blurb;
  $("#metaWhen").textContent = MM.whenText(run.startsAt);
  $("#metaWhere").textContent = run.where || "tba";
  const km = MM.routeKm(run.route);
  $("#metaDist").textContent = run.distance || (km ? "~" + km.toFixed(1) + " km" : "tba");
  $("#mapDist").textContent = km ? "~" + km.toFixed(1) + " km" : "route";
  renderMap(run);
  renderWall(run.id);
}

function renderMap(run) {
  const wrap = $("#mapWrap");
  if (!run.route || run.route.length < 2 || typeof L === "undefined") {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  if (!leafletMap) {
    leafletMap = L.map("map", { scrollWheelZoom: false });
    const layers = MM.tileLayers();
    layers.streets.addTo(leafletMap); // default to a labeled map so landmarks show
    L.control.layers(
      { streets: layers.streets, satellite: layers.satellite, dark: layers.dark },
      null,
      { position: "topright" }
    ).addTo(leafletMap);
  } else {
    leafletMap.eachLayer((l) => {
      if (l instanceof L.Polyline || l instanceof L.CircleMarker) leafletMap.removeLayer(l);
    });
  }
  const line = L.polyline(run.route, { color: "#ff233d", weight: 5, opacity: 0.95 }).addTo(leafletMap);
  const start = run.route[0];
  const end = run.route[run.route.length - 1];
  L.circleMarker(start, { radius: 7, color: "#fff", weight: 2, fillColor: "#ff233d", fillOpacity: 1 }).addTo(leafletMap);
  L.circleMarker(end, { radius: 7, color: "#fff", weight: 2, fillColor: "#ffd43b", fillOpacity: 1 }).addTo(leafletMap);
  leafletMap.fitBounds(line.getBounds().pad(0.25));
  setTimeout(() => leafletMap.invalidateSize(), 100);
}

// ---------- the wall ----------
function renderWall(runId) {
  const list = MM.getRunners(runId);
  const ul = $("#runnerList");
  ul.innerHTML = "";
  $("#countNum").textContent = list.length;
  $("#emptyState").hidden = list.length > 0;
  for (const r of list) {
    const li = document.createElement("li");
    li.className = "runner-item";
    li.innerHTML = `
      <span class="avatar"></span>
      <span class="runner-main"><b></b><small></small></span>
      <span class="pace-tag"></span>`;
    const av = li.querySelector(".avatar");
    av.textContent = MM.initials(r.alias);
    av.style.background = MM.avatarColor(r.alias);
    li.querySelector("b").textContent = r.alias;
    li.querySelector("small").textContent = r.level || r.pace;
    li.querySelector(".pace-tag").textContent = r.pace;
    ul.appendChild(li);
  }
}

// ---------- more-run cards ----------
function renderCards() {
  const wrap = $("#runCards");
  wrap.innerHTML = "";
  const others = MM.otherRuns();
  if (!others.length) {
    wrap.innerHTML = '<p class="empty">just the one run for now.</p>';
    return;
  }
  for (const run of others) {
    const km = MM.routeKm(run.route);
    const count = MM.getRunners(run.id).length;
    const card = document.createElement("article");
    card.className = "run-card";
    card.innerHTML = `
      <div class="rc-glyph">${MM.routeGlyph(run.route)}</div>
      <div class="rc-body">
        <h3></h3>
        <p class="rc-blurb"></p>
        <div class="rc-meta">
          <span class="rc-when"></span>
          <span class="rc-dist"></span>
        </div>
        <button class="cta cta-sm">i'm in →</button>
        <p class="rc-count"><span></span> in</p>
      </div>`;
    card.querySelector("h3").textContent = run.title;
    card.querySelector(".rc-blurb").textContent = run.blurb;
    card.querySelector(".rc-when").textContent = MM.whenText(run.startsAt);
    card.querySelector(".rc-dist").textContent =
      run.distance || (km ? "~" + km.toFixed(1) + " km" : "tba");
    card.querySelector(".rc-count span").textContent = count;
    card.querySelector("button").addEventListener("click", () => openSheet(run));
    wrap.appendChild(card);
  }
}

// ---------- register sheet ----------
function openSheet(run) {
  activeRunId = run.id;
  $("#sheetRun").textContent = "for “" + run.title + "”";
  const p = MM.me();
  if (p) {
    $('#joinForm input[name="alias"]').value = p.alias || "";
  }
  $("#sheet").hidden = false;
  document.body.style.overflow = "hidden";
  setTimeout(() => $('#joinForm input[name="alias"]').focus(), 80);
}
function closeSheet() {
  $("#sheet").hidden = true;
  document.body.style.overflow = "";
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 3000);
}

function handleSubmit(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const alias = (fd.get("alias") || "").toString().trim();
  const contact = (fd.get("contact") || "").toString().trim();
  if (!alias || !contact) return toast("need a name and a way to reach you");

  const { level, awarded } = MM.joinRun(activeRunId, {
    alias,
    contact,
    pace: (fd.get("pace") || "just here for it").toString(),
    note: (fd.get("note") || "").toString().trim(),
  });

  closeSheet();
  e.target.reset();
  renderProfile();
  renderFeatured();
  renderCards();
  toast(
    awarded
      ? `you're in 🏃 +${awarded} pts · lvl ${level.index + 1} ${level.name}`
      : "already signed up for this one ✓"
  );
}

// ---------- countdown ----------
function tickCountdown() {
  const run = MM.featuredRun();
  if (!run) return;
  const diff = Math.max(0, new Date(run.startsAt) - Date.now());
  const s = Math.floor(diff / 1000);
  const set = (k, v) => {
    const el = document.querySelector(`[data-cd="${k}"]`);
    if (el) el.textContent = String(v).padStart(2, "0");
  };
  set("days", Math.floor(s / 86400));
  set("hours", Math.floor((s % 86400) / 3600));
  set("mins", Math.floor((s % 3600) / 60));
  set("secs", s % 60);
}

// ---------- install (Android) + iOS hint ----------
let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  $("#installBtn").hidden = false;
});
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;

function setupInstall() {
  const btn = $("#installBtn");
  if (isIOS() && !isStandalone()) {
    btn.hidden = false;
    btn.textContent = "add to home screen";
    btn.addEventListener("click", () => toast("tap share, then “Add to Home Screen”"));
    return;
  }
  btn.addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    btn.hidden = true;
  });
}

// ---------- service worker ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

// ---------- init ----------
function init() {
  renderProfile();
  renderFeatured();
  renderCards();
  tickCountdown();
  setInterval(tickCountdown, 1000);
  setupInstall();

  $("#joinFeatured").addEventListener("click", () => openSheet(MM.featuredRun()));
  $("#joinForm").addEventListener("submit", handleSubmit);
  $$("[data-close]").forEach((el) => el.addEventListener("click", closeSheet));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#sheet").hidden) closeSheet();
  });
}

init();
