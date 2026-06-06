// MileMark server — serves the static PWA (from the repo root) and a small JSON
// API at /api/*. Mirrors the NotACafeGG pattern: one JSON blob, stored in Upstash
// Redis (REST, no SDK) when the env vars are set, else a local data/db.json for dev.
// Auth = signed HMAC cookies: a per-member "claim by contact" cookie, plus a
// password-gated admin cookie. Exports handleRequest so api/index.js can run it
// as a single Vercel serverless function.
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const sep = trimmed.indexOf("=");
    if (sep === -1) return;
    const key = trimmed.slice(0, sep).trim();
    const value = trimmed.slice(sep + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  });
}
loadEnvFile();

const PORT = process.env.PORT || 4173;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "milemark-admin";
const SESSION_SECRET = process.env.SESSION_SECRET || "milemark-local-secret";
const ADMIN_SESSION_MINUTES = Math.max(1, Number(process.env.ADMIN_SESSION_MINUTES || 120));
const ADMIN_SESSION_MS = ADMIN_SESSION_MINUTES * 60 * 1000;
const MEMBER_SESSION_DAYS = 180;
const MEMBER_SESSION_MS = MEMBER_SESSION_DAYS * 24 * 60 * 60 * 1000;
const ROOT = __dirname; // static files live alongside this file (repo root)
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = process.env.VERCEL
  ? path.join(os.tmpdir(), "milemark-db.json")
  : path.join(DATA_DIR, "db.json");
const USE_REDIS = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
);
const REDIS_KEY = process.env.UPSTASH_REDIS_KEY || "milemark-db";

const POINTS_PER_RUN = 50;
const LEVELS = [
  { min: 0, name: "just laced up" },
  { min: 100, name: "shows up" },
  { min: 250, name: "regular" },
  { min: 500, name: "road dog" },
  { min: 850, name: "machine" },
  { min: 1300, name: "certified legend" },
];

// Server only needs the *check* logic; the badge copy (name/note/glyph) lives on
// the client in data.js. Keep the ids here in sync with that catalog.
const ACHIEVEMENT_ORDER = [
  "first-mark",
  "front-row",
  "dawn-patrol",
  "golden-hour",
  "the-climb",
  "three-deep",
  "the-regular",
  "first-finish",
  "the-long-way",
  "the-distance",
];
const ACHIEVEMENT_CHECKS = {
  "first-mark": (c) => c.count >= 1,
  "front-row": (c) => c.bestPos <= 2,
  "dawn-patrol": (c) => c.hours.some((h) => h < 7),
  "golden-hour": (c) => c.titles.some((t) => /sunset|golden|evening|dusk/.test(t)),
  "the-climb": (c) => c.titles.some((t) => /hill|climb|peak|up/.test(t)),
  "three-deep": (c) => c.count >= 3,
  "the-regular": (c) => c.count >= 5,
  // earned by logging a run after it happens (the honor-system loop)
  "first-finish": (c) => c.loggedCount >= 1,
  "the-long-way": (c) => c.maxKm >= 10,
  "the-distance": (c) => c.totalKm >= 42,
};

const DEFAULT_RUNS = [
  {
    id: "run-zero-2026-06-07",
    title: "the sunday slow one",
    blurb:
      "no medals. no leaderboard flexing. just the road, a bad playlist, and whoever shows up. walk it, run it, talk the whole way.",
    startsAt: "2026-06-07T06:00:00+05:30",
    where: "outside the cafe, Salbari",
    distance: "",
    featured: true,
    route: [
      [26.68, 88.38],
      [26.6815, 88.382],
      [26.683, 88.381],
      [26.6835, 88.3785],
      [26.682, 88.377],
      [26.6805, 88.3782],
      [26.68, 88.38],
    ],
  },
  {
    id: "run-hill-2026-06-14",
    title: "the one with the hill",
    blurb: "short but it bites. one climb, one view, then coffee. bring legs.",
    startsAt: "2026-06-14T06:30:00+05:30",
    where: "tba — we'll text the spot",
    distance: "",
    featured: false,
    route: [
      [26.676, 88.385],
      [26.6775, 88.3865],
      [26.679, 88.388],
      [26.6805, 88.387],
    ],
  },
  {
    id: "run-sunset-2026-06-21",
    title: "the golden hour jog",
    blurb: "evening one. slow, easy, the sky doing its thing. no excuses about mornings.",
    startsAt: "2026-06-21T17:00:00+05:30",
    where: "tba",
    distance: "",
    featured: false,
    route: [
      [26.6845, 88.379],
      [26.685, 88.3815],
      [26.6862, 88.383],
      [26.6855, 88.3855],
    ],
  },
];
const DEFAULT_DB = { runs: DEFAULT_RUNS, runners: {}, profiles: {} };

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

// server-side files that must never be served as static
const BLOCKED_STATIC = new Set(["/server.js", "/package.json"]);
function isBlockedStatic(pathname) {
  if (BLOCKED_STATIC.has(pathname)) return true;
  if (pathname === "/data" || pathname.startsWith("/data/")) return true;
  if (pathname === "/api" || pathname.startsWith("/api/")) return true;
  if (pathname.startsWith("/.")) return true; // .env, .git, dotfiles
  if (pathname.includes("/.git")) return true;
  return false;
}

const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------- storage ----------
function ensureDb() {
  if (USE_REDIS) return;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify(DEFAULT_DB, null, 2));
}
async function redisGet() {
  const res = await fetch(
    `${process.env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(REDIS_KEY)}`,
    {
      headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
      cache: "no-store",
    }
  );
  if (!res.ok) throw new Error(`Upstash GET failed (${res.status})`);
  return (await res.json()).result;
}
async function redisSet(value) {
  const res = await fetch(
    `${process.env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(REDIS_KEY)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
      body: value,
    }
  );
  if (!res.ok) throw new Error(`Upstash SET failed (${res.status})`);
}
async function readDb() {
  if (USE_REDIS) {
    const raw = await redisGet();
    if (raw) return normalizeDb(JSON.parse(raw));
    const seed = clone(DEFAULT_DB);
    await redisSet(JSON.stringify(seed));
    return normalizeDb(seed);
  }
  ensureDb();
  return normalizeDb(JSON.parse(fs.readFileSync(DB_PATH, "utf8")));
}
async function writeDb(db) {
  if (USE_REDIS) return redisSet(JSON.stringify(db));
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}
function normalizeDb(db) {
  if (!db || typeof db !== "object") db = {};
  if (!Array.isArray(db.runs)) db.runs = clone(DEFAULT_RUNS);
  if (!db.runners || typeof db.runners !== "object") db.runners = {};
  if (!db.profiles || typeof db.profiles !== "object") db.profiles = {};
  return db;
}

// ---------- domain helpers ----------
function normKey(contact) {
  return String(contact || "").trim().toLowerCase().replace(/^@/, "").replace(/\s+/g, "");
}
function levelFor(points) {
  let idx = 0;
  LEVELS.forEach((l, i) => {
    if (points >= l.min) idx = i;
  });
  const cur = LEVELS[idx];
  const next = LEVELS[idx + 1] || null;
  const span = next ? next.min - cur.min : 1;
  return {
    index: idx,
    name: cur.name,
    points,
    next,
    toNext: next ? next.min - points : 0,
    progress: next ? Math.min(1, (points - cur.min) / span) : 1,
  };
}
// hour-of-day in IST (the cafe's timezone), independent of the server's timezone
function istHour(iso) {
  const d = new Date(iso);
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes() + 330; // +05:30
  return Math.floor(((minutes % 1440) + 1440) % 1440 / 60);
}
function achievementIdsFor(profile, db) {
  const byId = {};
  db.runs.forEach((r) => (byId[r.id] = r));
  const ids = profile.runs || [];
  const joined = ids.map((id) => byId[id]).filter(Boolean);
  const titles = joined.map((r) => (r.title || "").toLowerCase());
  const hours = joined.map((r) => istHour(r.startsAt));
  const bestPos = ids.reduce((best, id) => {
    const list = db.runners[id] || [];
    const i = list.findIndex((x) => normKey(x.contact) === profile.key);
    return i >= 0 && i < best ? i : best;
  }, 99);
  let maxKm = 0;
  ids.forEach((id) => {
    const e = (db.runners[id] || []).find((x) => normKey(x.contact) === profile.key);
    if (e && e.result && e.result.distanceKm > maxKm) maxKm = e.result.distanceKm;
  });
  const ctx = {
    count: joined.length,
    points: profile.points || 0,
    titles,
    hours,
    bestPos,
    loggedCount: (profile.logged || []).length,
    totalKm: profile.totalKm || 0,
    maxKm,
  };
  return ACHIEVEMENT_ORDER.filter((id) => ACHIEVEMENT_CHECKS[id](ctx));
}
function publicProfile(p) {
  return {
    key: p.key,
    alias: p.alias,
    points: p.points,
    runs: p.runs,
    badges: p.badges,
    logged: p.logged || [],
    totalKm: p.totalKm || 0,
    totalSec: p.totalSec || 0,
  };
}
function slugId(title) {
  return (
    "run-" +
    String(title || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 30) +
    "-" +
    Date.now().toString(36)
  );
}

// ---------- http helpers ----------
function sendJson(res, statusCode, payload, extraHeaders) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    ...(extraHeaders || {}),
  });
  res.end(JSON.stringify(payload));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body is too large."));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
  });
}
function parseCookies(req) {
  return String(req.headers.cookie || "")
    .split(";")
    .map((c) => c.trim())
    .filter(Boolean)
    .reduce((acc, c) => {
      const i = c.indexOf("=");
      if (i === -1) return acc;
      acc[decodeURIComponent(c.slice(0, i))] = decodeURIComponent(c.slice(i + 1));
      return acc;
    }, {});
}
function signSession(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
}
function verify(payload, signature) {
  const expected = signSession(payload);
  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
function createAdminCookie() {
  const payload = `admin:${Date.now()}`;
  return `${payload}.${signSession(payload)}`;
}
function createMemberCookie(key) {
  const payload = `member:${key}:${Date.now()}`;
  return `${payload}.${signSession(payload)}`;
}
function isAdmin(req) {
  const token = parseCookies(req).mm_admin;
  if (!token) return false;
  const at = token.lastIndexOf(".");
  if (at === -1) return false;
  const payload = token.slice(0, at);
  const sig = token.slice(at + 1);
  if (!payload.startsWith("admin:") || !verify(payload, sig)) return false;
  const age = Date.now() - Number(payload.split(":")[1]);
  return Number.isFinite(age) && age < ADMIN_SESSION_MS;
}
function memberKeyFromCookie(req) {
  const token = parseCookies(req).mm_member;
  if (!token) return null;
  const at = token.lastIndexOf(".");
  if (at === -1) return null;
  const payload = token.slice(0, at);
  const sig = token.slice(at + 1);
  if (!payload.startsWith("member:") || !verify(payload, sig)) return null;
  const i1 = payload.indexOf(":");
  const i2 = payload.lastIndexOf(":");
  const key = payload.slice(i1 + 1, i2);
  const age = Date.now() - Number(payload.slice(i2 + 1));
  if (!key || !Number.isFinite(age) || age > MEMBER_SESSION_MS) return null;
  return key;
}
function memberCookieHeader(key) {
  return `mm_member=${encodeURIComponent(createMemberCookie(key))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MEMBER_SESSION_DAYS * 24 * 60 * 60}`;
}
function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  sendJson(res, 401, { error: "Admin login required." });
  return false;
}

// ---------- API ----------
async function handleApi(req, res, pathname) {
  // ---- admin auth ----
  if (req.method === "POST" && pathname === "/api/admin/login") {
    const body = await readBody(req);
    if (String(body.password || "") !== ADMIN_PASSWORD) {
      sendJson(res, 401, { error: "Wrong admin password." });
      return;
    }
    sendJson(res, 200, { ok: true, expiresInMinutes: ADMIN_SESSION_MINUTES }, {
      "Set-Cookie": `mm_admin=${encodeURIComponent(createAdminCookie())}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ADMIN_SESSION_MINUTES * 60}`,
    });
    return;
  }
  if (req.method === "POST" && pathname === "/api/admin/logout") {
    sendJson(res, 200, { ok: true }, {
      "Set-Cookie": "mm_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
    });
    return;
  }
  if (req.method === "GET" && pathname === "/api/admin/me") {
    sendJson(res, 200, { admin: isAdmin(req) });
    return;
  }

  const db = await readDb();

  // ---- public read: the whole home view in one shot ----
  if (req.method === "GET" && pathname === "/api/state") {
    const meKey = memberKeyFromCookie(req);
    const runners = {};
    for (const run of db.runs) {
      const list = (db.runners[run.id] || []).slice().sort((a, b) => (a.at || 0) - (b.at || 0));
      runners[run.id] = list.map((r) => ({
        alias: r.alias,
        pace: r.pace,
        level: r.level,
        at: r.at,
        you: !!meKey && normKey(r.contact) === meKey,
        result: r.result || null, // honor-system log: { durationSec, distanceKm, note, stravaUrl, at }
      }));
    }
    sendJson(res, 200, { runs: db.runs, runners });
    return;
  }

  // ---- who am i (claim-by-contact cookie) ----
  if (req.method === "GET" && pathname === "/api/me") {
    const meKey = memberKeyFromCookie(req);
    const profile = meKey ? db.profiles[meKey] : null;
    if (!profile) {
      sendJson(res, 200, { member: null, level: null });
      return;
    }
    profile.badges = achievementIdsFor(profile, db);
    sendJson(res, 200, { member: publicProfile(profile), level: levelFor(profile.points) });
    return;
  }

  // ---- sign up for a run (the core write) ----
  if (req.method === "POST" && pathname === "/api/join") {
    const body = await readBody(req);
    const runId = String(body.runId || "");
    const alias = String(body.alias || "").trim().slice(0, 40);
    const contact = String(body.contact || "").trim().slice(0, 60);
    const pace = String(body.pace || "just here for it").slice(0, 40);
    const note = String(body.note || "").trim().slice(0, 80);
    const run = db.runs.find((r) => r.id === runId);

    if (!run) return sendJson(res, 404, { error: "That run doesn't exist anymore." });
    if (!alias || !contact) return sendJson(res, 400, { error: "Need a name and a way to reach you." });

    const key = normKey(contact);
    const profile = db.profiles[key] || { key, alias, points: 0, runs: [], badges: [] };
    profile.alias = alias;

    let awarded = 0;
    if (!profile.runs.includes(runId)) {
      profile.runs.push(runId);
      profile.points += POINTS_PER_RUN;
      awarded = POINTS_PER_RUN;
    }
    const level = levelFor(profile.points);

    db.runners[runId] = db.runners[runId] || [];
    const onWall = db.runners[runId].some((r) => normKey(r.contact) === key);
    if (!onWall) {
      db.runners[runId].push({ alias, contact, pace, note, level: level.name, at: Date.now() });
    }

    const prev = profile.badges || [];
    const earned = achievementIdsFor(profile, db);
    const newBadges = earned.filter((id) => !prev.includes(id));
    profile.badges = earned;
    db.profiles[key] = profile;

    await writeDb(db);
    sendJson(
      res,
      200,
      { profile: publicProfile(profile), level, awarded, newBadges, badges: earned },
      { "Set-Cookie": memberCookieHeader(key) }
    );
    return;
  }

  // ---- honor-system log: record what you actually ran, after the run ----
  if (req.method === "POST" && pathname === "/api/log") {
    const meKey = memberKeyFromCookie(req);
    if (!meKey) return sendJson(res, 401, { error: "Sign up for a run first so we know it's you." });

    const body = await readBody(req);
    const runId = String(body.runId || "");
    const run = db.runs.find((r) => r.id === runId);
    if (!run) return sendJson(res, 404, { error: "That run doesn't exist anymore." });
    if (new Date(run.startsAt) > new Date()) {
      return sendJson(res, 400, { error: "You can log this once the run has happened." });
    }

    const profile = db.profiles[meKey];
    if (!profile || !(profile.runs || []).includes(runId)) {
      return sendJson(res, 400, { error: "You didn't sign up for this run." });
    }
    const entry = (db.runners[runId] || []).find((x) => normKey(x.contact) === meKey);
    if (!entry) return sendJson(res, 400, { error: "We can't find you on this run's wall." });

    const durationSec = Math.max(0, Math.min(86400, Math.round(Number(body.durationSec) || 0)));
    const distanceKm = Math.max(0, Math.min(200, Math.round((Number(body.distanceKm) || 0) * 100) / 100));
    const note = String(body.note || "").trim().slice(0, 120);
    const rawStrava = String(body.stravaUrl || "").trim();
    const stravaUrl = /^https?:\/\//.test(rawStrava) ? rawStrava.slice(0, 200) : "";

    entry.result = { durationSec, distanceKm, note, stravaUrl, at: Date.now() };

    // recompute aggregates from scratch (idempotent — handles re-logging/edits)
    profile.logged = profile.logged || [];
    if (!profile.logged.includes(runId)) profile.logged.push(runId);
    let tk = 0;
    let ts = 0;
    profile.runs.forEach((id) => {
      const e = (db.runners[id] || []).find((x) => normKey(x.contact) === meKey);
      if (e && e.result) {
        tk += e.result.distanceKm || 0;
        ts += e.result.durationSec || 0;
      }
    });
    profile.totalKm = Math.round(tk * 100) / 100;
    profile.totalSec = ts;

    const prev = profile.badges || [];
    const earned = achievementIdsFor(profile, db);
    const newBadges = earned.filter((id) => !prev.includes(id));
    profile.badges = earned;
    db.profiles[meKey] = profile;

    await writeDb(db);
    sendJson(res, 200, {
      profile: publicProfile(profile),
      level: levelFor(profile.points),
      result: entry.result,
      newBadges,
    });
    return;
  }

  // ---- the regulars (available for a future UI; brand stays anti-flex) ----
  if (req.method === "GET" && pathname === "/api/leaderboard") {
    const leaders = Object.values(db.profiles)
      .map((p) => ({
        alias: p.alias,
        points: p.points,
        runs: (p.runs || []).length,
        level: levelFor(p.points).name,
      }))
      .sort((a, b) => b.points - a.points)
      .slice(0, 50);
    sendJson(res, 200, { leaders });
    return;
  }

  // ---- admin: run CRUD ----
  if (req.method === "POST" && pathname === "/api/runs") {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const title = String(body.title || "").trim();
    const startsAt = String(body.startsAt || "");
    const route = Array.isArray(body.route) ? body.route : [];
    if (!title || !startsAt) return sendJson(res, 400, { error: "A run needs a title and a date." });
    if (route.length < 2) return sendJson(res, 400, { error: "Drop at least 2 route points." });

    const run = {
      id: body.id || slugId(title),
      title: title.slice(0, 80),
      blurb: String(body.blurb || "").trim().slice(0, 300),
      startsAt,
      where: String(body.where || "").trim().slice(0, 80),
      distance: String(body.distance || "").trim().slice(0, 40),
      featured: !!body.featured,
      route: route.map((p) => [Number(p[0]), Number(p[1])]),
    };
    if (run.featured) db.runs.forEach((r) => (r.featured = false)); // only one featured
    const i = db.runs.findIndex((r) => r.id === run.id);
    if (i >= 0) db.runs[i] = run;
    else db.runs.push(run);
    await writeDb(db);
    sendJson(res, i >= 0 ? 200 : 201, { run });
    return;
  }
  if (req.method === "DELETE" && pathname.startsWith("/api/runs/")) {
    if (!requireAdmin(req, res)) return;
    const id = decodeURIComponent(pathname.replace("/api/runs/", ""));
    const before = db.runs.length;
    db.runs = db.runs.filter((r) => r.id !== id);
    if (db.runs.length === before) return sendJson(res, 404, { error: "Run not found." });
    delete db.runners[id];
    await writeDb(db);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: "API route not found." });
}

// ---------- static ----------
function serveStatic(req, res, pathname) {
  // admin pages are gated server-side
  if ((pathname === "/admin.html" || pathname === "/admin.js") && !isAdmin(req)) {
    res.writeHead(302, { Location: "/admin-login.html" });
    res.end();
    return;
  }
  if (isBlockedStatic(pathname)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  const safe = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(ROOT, decodeURIComponent(safe)));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const ext = path.extname(filePath);
    const headers = { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" };
    if (pathname === "/sw.js") headers["Cache-Control"] = "no-cache";
    res.writeHead(200, headers);
    res.end(data);
  });
}

function handleRequest(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      Promise.resolve(handleApi(req, res, url.pathname)).catch((error) => {
        console.error(error);
        if (!res.headersSent) sendJson(res, 500, { error: "Server error. Try again shortly." });
        else res.end();
      });
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) sendJson(res, 500, { error: "Server error. Try again shortly." });
  }
}

if (require.main === module) {
  ensureDb();
  http.createServer(handleRequest).listen(PORT, () => {
    console.log(`MileMark running → http://localhost:${PORT}${USE_REDIS ? " (Upstash)" : " (local db)"}`);
  });
}

module.exports = handleRequest;
module.exports.handleRequest = handleRequest;
