// MileMark shared data layer — now a thin client over the /api backend.
// Loaded before share.js, app.js and admin.js. Exposes a global `MM`.
//
// The wall, runs, points, levels and "marks" all live on the server (server.js)
// so every phone sees the same state. This module fetches a snapshot into a local
// cache via MM.refresh(), then most accessors (featuredRun, getRunners, me,
// achievementsFor…) read from that cache synchronously — so the render code stays
// simple. Only the writes (join, admin run CRUD) and refresh are async.
const MM = (() => {
  // ---- gamification config (display side) ----
  const POINTS_PER_RUN = 50;
  const LEVELS = [
    { min: 0, name: "just laced up" },
    { min: 100, name: "shows up" },
    { min: 250, name: "regular" },
    { min: 500, name: "road dog" },
    { min: 850, name: "machine" },
    { min: 1300, name: "certified legend" },
  ];

  // Badge *presentation* only — the server decides who's earned what (by id).
  // Keep these ids in sync with ACHIEVEMENT_ORDER in server.js.
  const ACHIEVEMENTS = [
    { id: "first-mark", name: "first mark", glyph: "✺", tone: "#ff233d", note: "you showed up once. that's the whole thing.", hint: "sign up for your first run." },
    { id: "front-row", name: "front row", glyph: "✶", tone: "#ffd43b", note: "first names on the wall. you set the tone for everyone after.", hint: "be one of the first 3 to sign up for a run." },
    { id: "dawn-patrol", name: "dawn patrol", glyph: "☼", tone: "#ff8a3d", note: "you said yes to a 6am. most people don't.", hint: "sign up for a run that starts before 7am." },
    { id: "golden-hour", name: "golden hour", glyph: "◐", tone: "#ffd43b", note: "you ran toward the light, not the clock.", hint: "sign up for an evening / sunset run." },
    { id: "the-climb", name: "the climb", glyph: "▲", tone: "#7c9eff", note: "you didn't dodge the hill. it bit. you stayed.", hint: "sign up for a run with a climb in it." },
    { id: "three-deep", name: "three deep", glyph: "❍", tone: "#46e39c", note: "three times now. the road's starting to remember you.", hint: "show up for 3 runs." },
    { id: "the-regular", name: "the regular", glyph: "✸", tone: "#ff233d", note: "five in. they pour your coffee before you ask.", hint: "show up for 5 runs." },
    { id: "first-finish", name: "first finish", glyph: "⚑", tone: "#46e39c", note: "you didn't just sign up. you finished, then said so.", hint: "log a run after you've done it." },
    { id: "the-long-way", name: "the long way", glyph: "⟿", tone: "#7c9eff", note: "ten clicks in one go. you took the long way on purpose.", hint: "log a single run of 10km or more." },
    { id: "the-distance", name: "the distance", glyph: "∞", tone: "#ffd43b", note: "forty-two km logged, all told — the distance of the myth.", hint: "log 42km total across your runs." },
    { id: "not-another-intruder", name: "the intruder", issuer: "Not Another Exp.", glyph: "👁️", tone: "#00f0ff", note: "you ain't suppose to be here ;) genesis badge minted under Not Another Exp.", hint: "stumble into the hidden organiser room.", isNft: true },
  ];

  // map default center — Salbari / Siliguri area, North Bengal
  const MAP_CENTER = [26.68, 88.38];
  const MAP_ZOOM = 14;

  // ---- cached server snapshot ----
  let state = { runs: [], runners: {} };
  let meProfile = null;
  let meLevel = null;

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      ...opts,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-json */
    }
    if (!res.ok) throw new Error((data && data.error) || "request failed (" + res.status + ")");
    return data;
  }

  // pull a fresh snapshot of the world + who-i-am
  async function refresh() {
    const [s, m] = await Promise.all([api("/api/state"), api("/api/me")]);
    state = s && Array.isArray(s.runs) ? s : { runs: [], runners: {} };
    meProfile = (m && m.member) || null;
    meLevel = (m && m.level) || null;
    return state;
  }

  // ---- sync accessors over the cache ----
  function getRuns() {
    return state.runs || [];
  }
  function featuredRun() {
    const runs = getRuns();
    if (!runs.length) return null;
    const now = new Date();

    // 1. Explicit featured run that is in the future and not cancelled
    const futureFeatured = runs.find(
      (r) => r.featured && new Date(r.startsAt) > now && r.status !== "cancelled"
    );
    if (futureFeatured) return futureFeatured;

    // 2. Nearest upcoming future run (sorted by startsAt ascending)
    const upcomingRuns = runs
      .filter((r) => new Date(r.startsAt) > now && r.status !== "cancelled")
      .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
    if (upcomingRuns.length > 0) return upcomingRuns[0];

    // 3. Any explicit featured run (e.g. today / postponed / recently completed)
    const anyFeatured = runs.find((r) => r.featured);
    if (anyFeatured) return anyFeatured;

    // 4. Fallback: most recent run or null
    return runs[0] || null;
  }
  function otherRuns() {
    const f = featuredRun();
    return getRuns().filter((r) => r && r.id !== (f && f.id));
  }
  function getRunners(runId) {
    return state.runners[runId] || [];
  }
  function me() {
    return meProfile;
  }
  function myLevel() {
    return meLevel || (meProfile ? levelFor(meProfile.points) : null);
  }

  function levelFor(points) {
    let idx = 0;
    LEVELS.forEach((l, i) => {
      if (points >= l.min) idx = i;
    });
    const cur = LEVELS[idx];
    const next = LEVELS[idx + 1] || null;
    const span = next ? next.min - cur.min : 1;
    const into = points - cur.min;
    return {
      index: idx,
      name: cur.name,
      points,
      next,
      toNext: next ? next.min - points : 0,
      progress: next ? Math.min(1, into / span) : 1,
    };
  }

  // merge the catalog with the earned-id set the server gave us
  function achievementsFor(profile) {
    const earned = new Set((profile && profile.badges) || []);
    return ACHIEVEMENTS.map((b) => ({ ...b, earned: earned.has(b.id) }));
  }
  function earnedAchievements(profile) {
    return achievementsFor(profile).filter((b) => b.earned);
  }

  // ---- writes ----
  async function join(runId, { alias, phone, email, ig, pace, note }) {
    const r = await api("/api/join", {
      method: "POST",
      body: JSON.stringify({ runId, alias, phone, email, ig, pace, note }),
    });
    await refresh();
    const newBadges = (r.newBadges || [])
      .map((id) => ACHIEVEMENTS.find((b) => b.id === id))
      .filter(Boolean);
    return { profile: r.profile, level: r.level, awarded: r.awarded, newBadges };
  }

  async function log(runId, { durationSec, distanceKm, note, stravaUrl }) {
    const r = await api("/api/log", {
      method: "POST",
      body: JSON.stringify({ runId, durationSec, distanceKm, note, stravaUrl }),
    });
    await refresh();
    const newBadges = (r.newBadges || [])
      .map((id) => ACHIEVEMENTS.find((b) => b.id === id))
      .filter(Boolean);
    return { profile: r.profile, level: r.level, result: r.result, newBadges };
  }

  // has the current member already logged this run?
  function myResult(runId) {
    const list = getRunners(runId);
    const mine = list.find((r) => r.you);
    return (mine && mine.result) || null;
  }
  // a run is loggable once it has started (honor-system: log it after)
  function runStarted(run) {
    return run && new Date(run.startsAt) <= new Date();
  }

  async function leaderboard() {
    return (await api("/api/leaderboard")).leaders || [];
  }

  async function claimEasterEgg({ alias, email } = {}) {
    const res = await api("/api/claim-easter-egg", {
      method: "POST",
      body: JSON.stringify({ alias, email }),
    });
    await refresh();
    const badge = ACHIEVEMENTS.find((b) => b.id === "not-another-intruder");
    return { ...res, badge };
  }

  // ---- admin ----
  async function upsertRun(run) {
    return (await api("/api/runs", { method: "POST", body: JSON.stringify(run) })).run;
  }
  async function updateRunStatus(runId, status, statusNote = "", notifyPush = true) {
    return api("/api/admin/run/status", {
      method: "POST",
      body: JSON.stringify({ runId, status, statusNote, notifyPush }),
    });
  }
  async function deleteRun(id) {
    return api("/api/runs/" + encodeURIComponent(id), { method: "DELETE" });
  }
  async function adminLogin(password) {
    return api("/api/admin/login", { method: "POST", body: JSON.stringify({ password }) });
  }
  async function adminLogout() {
    return api("/api/admin/logout", { method: "POST" });
  }
  async function adminMe() {
    try {
      return (await api("/api/admin/me")).admin === true;
    } catch {
      return false;
    }
  }

  // ---- visual helpers (pure) ----
  const normKey = (contact) =>
    (contact || "").trim().toLowerCase().replace(/^@/, "").replace(/\s+/g, "");

  function initials(name) {
    const parts = (name || "")
      .trim()
      .replace(/^@/, "")
      .split(/[\s_.]+/)
      .filter(Boolean);
    return ((parts[0]?.[0] || "?") + (parts[1]?.[0] || "")).toUpperCase();
  }
  function avatarColor(name) {
    let h = 0;
    for (const ch of name || "?") h = (h * 31 + ch.charCodeAt(0)) % 360;
    const palette = ["#ff233d", "#ffd43b", "#46e39c", "#ff8a3d", "#7c9eff"];
    return palette[h % palette.length];
  }

  function routeKm(route) {
    if (!route || route.length < 2) return 0;
    const R = 6371;
    let km = 0;
    for (let i = 1; i < route.length; i++) {
      const [la1, lo1] = route[i - 1];
      const [la2, lo2] = route[i];
      const dLa = ((la2 - la1) * Math.PI) / 180;
      const dLo = ((lo2 - lo1) * Math.PI) / 180;
      const a =
        Math.sin(dLa / 2) ** 2 +
        Math.cos((la1 * Math.PI) / 180) *
        Math.cos((la2 * Math.PI) / 180) *
        Math.sin(dLo / 2) ** 2;
      km += 2 * R * Math.asin(Math.sqrt(a));
    }
    return km;
  }

  let glyphSeq = 0;
  function routeGlyph(route) {
    if (!route || route.length < 2) {
      return `<svg viewBox="0 0 100 56" class="glyph-empty"><text x="50" y="31" text-anchor="middle">no route yet</text></svg>`;
    }
    const lngs = route.map((p) => p[1]);
    const lats = route.map((p) => p[0]);
    const minX = Math.min(...lngs),
      maxX = Math.max(...lngs);
    const minY = Math.min(...lats),
      maxY = Math.max(...lats);
    const pad = 8;
    const w = 100,
      h = 56;
    const sx = (maxX - minX) || 1e-6;
    const sy = (maxY - minY) || 1e-6;
    const pts = route.map(([la, lo]) => {
      const x = pad + ((lo - minX) / sx) * (w - 2 * pad);
      const y = h - pad - ((la - minY) / sy) * (h - 2 * pad); // invert lat
      return [x, y];
    });
    const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
    const id = "g" + glyphSeq++;
    const [sxp, syp] = pts[0];
    const [exp, eyp] = pts[pts.length - 1];
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="route-glyph">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#ff233d"/><stop offset="1" stop-color="#ffd43b"/>
      </linearGradient></defs>
      <path d="${d}" fill="none" stroke="url(#${id})" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${sxp.toFixed(1)}" cy="${syp.toFixed(1)}" r="3.4" fill="#ff233d"/>
      <circle cx="${exp.toFixed(1)}" cy="${eyp.toFixed(1)}" r="3.4" fill="#ffd43b"/>
    </svg>`;
  }

  function tileLayers() {
    return {
      streets: L.tileLayer(
        "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
        { maxZoom: 20, attribution: "© OpenStreetMap · © CARTO" }
      ),
      satellite: L.layerGroup([
        L.tileLayer(
          "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          { maxZoom: 19, attribution: "© Esri" }
        ),
        L.tileLayer(
          "https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png",
          { maxZoom: 20 }
        ),
      ]),
      dark: L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        maxZoom: 20,
        attribution: "© OpenStreetMap · © CARTO",
      }),
    };
  }

  function whenText(startsAt) {
    return new Date(startsAt).toLocaleString("en-IN", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  // seconds -> "28:30" or "1:05:00"
  function formatTime(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h ? h + ":" + pad(m) + ":" + pad(s) : m + ":" + pad(s);
  }

  // ---- Calendar & GPX Exports ----
  function toIcsDate(date) {
    const d = new Date(date);
    return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  }

  function exportIcs(run) {
    if (!run) return;
    const start = new Date(run.startsAt);
    const end = new Date(start.getTime() + 90 * 60 * 1000); // estimated 90 mins
    const km = routeKm(run.route);
    const distText = run.distance || (km ? `~${km.toFixed(1)} km` : "");
    const title = `MileMark: ${run.title}`;
    const desc = `${run.blurb || "A Not Another Experience Run."}\n\nDistance: ${distText}\nWhere: ${run.where || "Salbari, North Bengal"}\nApp: ${window.location.origin}`;

    const icsContent = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//MileMark//Not Another Experience//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      `UID:${run.id}-${start.getTime()}@milemark.local`,
      `DTSTAMP:${toIcsDate(new Date())}`,
      `DTSTART:${toIcsDate(start)}`,
      `DTEND:${toIcsDate(end)}`,
      `SUMMARY:${title.replace(/\n/g, "\\n")}`,
      `DESCRIPTION:${desc.replace(/\n/g, "\\n")}`,
      `LOCATION:${(run.where || "Salbari, North Bengal").replace(/\n/g, "\\n")}`,
      "STATUS:CONFIRMED",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const blob = new Blob([icsContent], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `milemark-${run.id || "run"}.ics`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 200);
  }

  function googleCalendarUrl(run) {
    if (!run) return "#";
    const start = new Date(run.startsAt);
    const end = new Date(start.getTime() + 90 * 60 * 1000);
    const km = routeKm(run.route);
    const distText = run.distance || (km ? `~${km.toFixed(1)} km` : "");
    const title = `MileMark: ${run.title}`;
    const details = `${run.blurb || "A Not Another Experience Run."}\n\nDistance: ${distText}\nWhere: ${run.where || "Salbari, North Bengal"}\nApp: ${window.location.origin}`;

    const params = new URLSearchParams({
      action: "TEMPLATE",
      text: title,
      dates: `${toIcsDate(start)}/${toIcsDate(end)}`,
      details: details,
      location: run.where || "Salbari, North Bengal",
    });
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  }

  function exportGpx(run) {
    if (!run || !run.route || run.route.length < 2) return;
    const title = run.title || "MileMark Run";
    const pts = run.route
      .map(
        (pt) =>
          `      <trkpt lat="${Number(pt[0]).toFixed(6)}" lon="${Number(pt[1]).toFixed(6)}"></trkpt>`
      )
      .join("\n");
    const gpxContent = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="MileMark - Not Another Experience" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>MileMark - ${title}</name>
    <desc>${(run.blurb || "").replace(/[<>&]/g, "")}</desc>
    <time>${new Date().toISOString()}</time>
  </metadata>
  <trk>
    <name>${title.replace(/[<>&]/g, "")}</name>
    <type>Running</type>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>`;

    const blob = new Blob([gpxContent], { type: "application/gpx+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `milemark-${run.id || "route"}.gpx`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 200);
  }

  function safeCsvCell(val) {
    let str = (val || "").toString().replace(/"/g, '""');
    if (/^[=\+\-@\t\r]/.test(str)) {
      str = "'" + str;
    }
    return `"${str}"`;
  }

  function exportRosterCsv(run) {
    if (!run) return;
    const runners = getRunners(run.id);
    const headers = ["Alias / Name", "Phone", "Email", "Pace", "Note", "Logged?", "Logged Km", "Logged Time", "Strava URL"];
    const rows = runners.map((r) => {
      const res = r.result || {};
      return [
        safeCsvCell(r.alias),
        safeCsvCell(r.phone),
        safeCsvCell(r.email),
        safeCsvCell(r.pace),
        safeCsvCell(r.note),
        res.distanceKm || res.durationSec ? "YES" : "NO",
        res.distanceKm ? res.distanceKm : "",
        res.durationSec ? formatTime(res.durationSec) : "",
        safeCsvCell(res.stravaUrl),
      ].join(",");
    });
    const csvContent = "\uFEFF" + [headers.join(","), ...rows].join("\r\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `roster-${run.id || "run"}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 200);
  }

  // ---- Web Push Client ----
  function isPushSupported() {
    return (
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window
    );
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/\-/g, "+").replace(/_/g, "/");
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  async function getPushSubscription() {
    if (!isPushSupported()) return null;
    try {
      const reg = await navigator.serviceWorker.ready;
      return await reg.pushManager.getSubscription();
    } catch {
      return null;
    }
  }

  async function subscribePush(runId = null) {
    if (!isPushSupported()) throw new Error("push notifications not supported on this device");
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      throw new Error("notification permission was not granted");
    }

    const { publicKey } = await api("/api/push/vapid-key");
    if (!publicKey) throw new Error("VAPID public key not configured on server");

    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }

    await api("/api/push/subscribe", {
      method: "POST",
      body: JSON.stringify({ subscription: sub.toJSON(), runId }),
    });

    return sub;
  }

  async function unsubscribePush() {
    if (!isPushSupported()) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe();
        await api("/api/push/unsubscribe", {
          method: "POST",
          body: JSON.stringify({ endpoint }),
        });
      }
    } catch {
      /* ignore error */
    }
  }

  return {
    MAP_CENTER,
    MAP_ZOOM,
    LEVELS,
    POINTS_PER_RUN,
    ACHIEVEMENTS,
    refresh,
    getRuns,
    featuredRun,
    otherRuns,
    getRunners,
    me,
    myLevel,
    levelFor,
    achievementsFor,
    earnedAchievements,
    join,
    log,
    myResult,
    runStarted,
    leaderboard,
    claimEasterEgg,
    upsertRun,
    updateRunStatus,
    deleteRun,
    adminLogin,
    adminLogout,
    adminMe,
    normKey,
    initials,
    avatarColor,
    routeKm,
    routeGlyph,
    tileLayers,
    whenText,
    formatTime,
    exportIcs,
    googleCalendarUrl,
    exportGpx,
    exportRosterCsv,
    isPushSupported,
    getPushSubscription,
    subscribePush,
    unsubscribePush,
  };
})();
