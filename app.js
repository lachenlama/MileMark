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
  renderNoted(p);
  renderMarks(p);
}

// ---------- the app noticing you ----------
function personalNote(p) {
  const runs = (p.runs || []).length;
  if (runs >= 5) return `<span>${runs} runs in.</span> we stopped thinking of you as new a while ago.`;
  if (runs >= 3) return `three sundays and counting — <span>the road knows your name now.</span>`;
  if (runs === 2) return `you came back. <span>that's the rare part.</span>`;
  return `you're on the wall. <span>we saved your spot.</span>`;
}
function renderNoted(p) {
  const el = $("#notedLine");
  if (!p || !(p.runs || []).length) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = personalNote(p);
}

// ---------- your marks (shareable achievements) ----------
function renderMarks(p) {
  const sec = $("#marksSection");
  const grid = $("#marksGrid");
  if (!p) {
    sec.hidden = true;
    return;
  }
  const all = MM.achievementsFor(p);
  const earned = all.filter((b) => b.earned);
  if (!earned.length) {
    sec.hidden = true;
    return;
  }
  sec.hidden = false;
  grid.innerHTML = "";
  const locked = all.filter((b) => !b.earned).slice(0, 3); // a few to chase
  for (const b of [...earned, ...locked]) {
    const el = document.createElement(b.earned ? "button" : "div");
    el.className = "mark " + (b.earned ? "earned" : "locked");
    el.innerHTML = `
      <span class="mark-glyph">${b.glyph}</span>
      <span class="mark-name"></span>
      <span class="mark-note"></span>
      <span class="mark-share"></span>`;
    el.querySelector(".mark-name").textContent = b.name;
    el.querySelector(".mark-note").textContent = b.earned ? b.note : b.hint;
    el.querySelector(".mark-share").textContent = b.earned ? "↗ share" : "not yet";
    if (b.earned) el.addEventListener("click", () => MMShare.openBadge(b, p));
    grid.appendChild(el);
  }
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

  const p = MM.me();
  const joined = p && (p.runs || []).includes(run.id);
  const started = MM.runStarted(run);
  const logged = !!MM.myResult(run.id);

  // before the run: join + (if in) share you're in. after the run: log it / share result.
  $("#joinFeatured").hidden = started;
  $("#shareFeatured").hidden = !joined || started;
  const logBtn = $("#logFeatured");
  logBtn.hidden = !(joined && started);
  logBtn.textContent = logged ? "update / share your run →" : "log your run →";
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
  const isLoop = start[0] === end[0] && start[1] === end[1];
  L.circleMarker(start, { radius: 8, color: "#fff", weight: 2, fillColor: "#ff233d", fillOpacity: 1 })
    .addTo(leafletMap)
    .bindTooltip(isLoop ? "start / finish" : "start", {
      permanent: true,
      direction: "top",
      className: "mm-tip mm-tip-start",
      offset: [0, -5],
    });
  if (!isLoop) {
    L.circleMarker(end, { radius: 8, color: "#fff", weight: 2, fillColor: "#ffd43b", fillOpacity: 1 })
      .addTo(leafletMap)
      .bindTooltip("finish line", {
        permanent: true,
        direction: "top",
        className: "mm-tip mm-tip-finish",
        offset: [0, -5],
      });
  }
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
    const isYou = !!r.you; // server marks which wall entry is the current member
    const res = r.result;
    const li = document.createElement("li");
    li.className = "runner-item" + (isYou ? " is-you" : "") + (res ? " logged" : "");
    li.innerHTML = `
      <span class="avatar"></span>
      <span class="runner-main">
        <b></b>
        <small></small>
        <em class="runner-note" hidden></em>
      </span>
      <span class="pace-tag"></span>`;
    const av = li.querySelector(".avatar");
    av.textContent = MM.initials(r.alias);
    av.style.background = MM.avatarColor(r.alias);
    li.querySelector("b").textContent = r.alias;
    li.querySelector("small").textContent = res ? resultLine(res) : r.level || r.pace;

    // confessional one-liner from the log
    if (res && res.note) {
      const note = li.querySelector(".runner-note");
      note.textContent = "“" + res.note + "”";
      note.hidden = false;
    }

    const tagSlot = li.querySelector(".pace-tag");
    if (isYou) {
      const tag = document.createElement("span");
      tag.className = "you-tag";
      tag.textContent = "← this is you";
      tagSlot.replaceWith(tag);
    } else if (res) {
      const tag = document.createElement("span");
      tag.className = "ran-tag";
      if (res.stravaUrl) {
        const a = document.createElement("a");
        a.href = res.stravaUrl;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = "ran it ↗";
        tag.appendChild(a);
      } else {
        tag.textContent = "ran it ✓";
      }
      tagSlot.replaceWith(tag);
    } else {
      tagSlot.textContent = r.pace;
    }
    ul.appendChild(li);
  }
  updateWallFade();
}

// show the bottom fade only while the wall has more entries below the fold
function updateWallFade() {
  const box = $(".runner-scroll");
  const wall = $(".runner-wall");
  if (!box || !wall) return;
  const more = box.scrollHeight - box.clientHeight - box.scrollTop > 4;
  wall.classList.toggle("has-more", more);
  if (!box.dataset.fadeWired) {
    box.addEventListener("scroll", updateWallFade, { passive: true });
    window.addEventListener("resize", updateWallFade);
    box.dataset.fadeWired = "1";
  }
}

function resultLine(res) {
  const parts = ["ran it"];
  if (res.distanceKm) parts.push(res.distanceKm + " km");
  if (res.durationSec) parts.push(MM.formatTime(res.durationSec));
  return parts.join(" · ");
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

    const btn = card.querySelector("button");
    const p = MM.me();
    const joined = p && (p.runs || []).includes(run.id);
    if (MM.runStarted(run)) {
      if (joined) {
        btn.textContent = MM.myResult(run.id) ? "update your run →" : "log your run →";
        btn.addEventListener("click", () => openLogSheet(run));
      } else {
        btn.textContent = "this one's done";
        btn.disabled = true;
      }
    } else {
      btn.addEventListener("click", () => openSheet(run));
    }
    wrap.appendChild(card);
  }
}

// ---------- register sheet ----------
function openSheet(run) {
  activeRunId = run.id;
  $("#sheetRun").textContent = "for “" + run.title + "”";
  const p = MM.me();
  if (p) {
    const f = $("#joinForm");
    f.alias.value = p.alias || "";
    if (f.phone) f.phone.value = p.phone || "";
    if (f.email) f.email.value = p.email || "";
    if (f.ig) f.ig.value = p.ig || "";
  }
  $("#sheet").hidden = false;
  document.body.style.overflow = "hidden";
  setTimeout(() => $('#joinForm input[name="alias"]').focus(), 80);
}
function closeSheet() {
  $("#sheet").hidden = true;
  document.body.style.overflow = "";
}

// ---------- log sheet (honor-system result) ----------
let activeLogRunId = null;

// "28:30" -> 1710 · "1:05:00" -> 3905 · "30" -> 1800 (bare number = minutes)
function parseTime(str) {
  const s = (str || "").toString().trim();
  if (!s) return 0;
  const parts = s.split(":").map((n) => parseInt(n, 10));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 1) return parts[0] * 60;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function openLogSheet(run) {
  if (!run) return;
  activeLogRunId = run.id;
  $("#logRun").textContent = "for “" + run.title + "”";
  const f = $("#logForm");
  const prev = MM.myResult(run.id);
  const km = MM.routeKm(run.route);
  f.time.value = prev && prev.durationSec ? MM.formatTime(prev.durationSec) : "";
  f.distance.value = prev && prev.distanceKm ? prev.distanceKm : km ? km.toFixed(1) : "";
  f.note.value = (prev && prev.note) || "";
  f.stravaUrl.value = (prev && prev.stravaUrl) || "";
  $("#logSheet").hidden = false;
  document.body.style.overflow = "hidden";
}
function closeLogSheet() {
  $("#logSheet").hidden = true;
  document.body.style.overflow = "";
}

async function handleLogSubmit(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = {
    durationSec: parseTime(fd.get("time")),
    distanceKm: parseFloat(fd.get("distance")) || 0,
    note: (fd.get("note") || "").toString().trim(),
    stravaUrl: (fd.get("stravaUrl") || "").toString().trim(),
  };
  const btn = e.target.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  let result;
  try {
    result = await MM.log(activeLogRunId, payload);
  } catch (err) {
    if (btn) btn.disabled = false;
    return toast(err.message || "couldn't log it — try again");
  }
  if (btn) btn.disabled = false;

  closeLogSheet();
  e.target.reset();
  renderProfile();
  renderFeatured();
  renderCards();

  const run = MM.getRuns().find((r) => r.id === activeLogRunId);
  if (result.newBadges && result.newBadges.length) {
    const badge = result.newBadges[0];
    MMShare.openBadge(badge, MM.me(), { kicker: "you just earned a mark", title: badge.name });
    toast(`logged ✓ new mark: “${badge.name}”`);
  } else {
    if (run) MMShare.openResult(run, MM.me(), result.result, { kicker: "you ran it", title: "logged" });
    toast("logged ✓ nice one");
  }
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 3000);
}
window.toast = toast; // share.js uses it for download fallbacks

async function handleSubmit(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const alias = (fd.get("alias") || "").toString().trim();
  const phone = (fd.get("phone") || "").toString().trim();
  const email = (fd.get("email") || "").toString().trim();
  const ig = (fd.get("ig") || "").toString().trim();

  if (!alias) return toast("tell us what to call you");
  if (phone.replace(/\D/g, "").length < 7) return toast("enter a valid phone number");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return toast("enter a valid email");

  const submitBtn = e.target.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;

  let result;
  try {
    result = await MM.join(activeRunId, {
      alias,
      phone,
      email,
      ig,
      pace: (fd.get("pace") || "just here for it").toString(),
      note: (fd.get("note") || "").toString().trim(),
    });
  } catch (err) {
    if (submitBtn) submitBtn.disabled = false;
    return toast(err.message || "couldn't sign you up — try again");
  }
  if (submitBtn) submitBtn.disabled = false;
  const { level, awarded, newBadges } = result;

  closeSheet();
  e.target.reset();
  renderProfile();
  renderFeatured();
  renderCards();

  // a new mark earned → quiet little moment + a card to share. else just a toast.
  if (newBadges && newBadges.length) {
    const badge = newBadges[0];
    MMShare.openBadge(badge, MM.me(), {
      kicker: "you just earned a mark",
      title: badge.name,
    });
    toast(`new mark: “${badge.name}” ✺ +${awarded} pts`);
  } else {
    toast(
      awarded
        ? `you're in 🏃 +${awarded} pts · lvl ${level.index + 1} ${level.name}`
        : "already signed up for this one ✓"
    );
  }
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

function renderAll() {
  renderProfile();
  renderFeatured();
  renderCards();
}

// ---------- init ----------
async function init() {
  // listeners + install prompt don't need server data — wire them first
  setupInstall();
  $("#joinFeatured").addEventListener("click", () => openSheet(MM.featuredRun()));
  $("#shareFeatured").addEventListener("click", () => {
    const run = MM.featuredRun();
    const p = MM.me();
    if (run && p) MMShare.openSignup(run, p, MM.myLevel());
  });
  $("#logFeatured").addEventListener("click", () => openLogSheet(MM.featuredRun()));
  $("#joinForm").addEventListener("submit", handleSubmit);
  $("#logForm").addEventListener("submit", handleLogSubmit);
  $$("[data-close]").forEach((el) => el.addEventListener("click", closeSheet));
  $$("[data-log-close]").forEach((el) => el.addEventListener("click", closeLogSheet));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("#sheet").hidden) closeSheet();
    if (!$("#logSheet").hidden) closeLogSheet();
  });

  // pull shared state from the server, then paint
  try {
    await MM.refresh();
  } catch (e) {
    console.error("MileMark: /api/state failed —", e);
    toast("couldn't reach the server — pull to retry");
  }
  renderAll();
  tickCountdown();
  setInterval(tickCountdown, 1000);
}

init();
