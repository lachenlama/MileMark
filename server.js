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
const zlib = require("zlib");
const webpush = require("web-push");

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
try { ensureDb(); } catch { }

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

const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@milemark.local";
let vapidPublicKey = process.env.VAPID_PUBLIC_KEY || "";
let vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || "";

function initVapid(db) {
  if (vapidPublicKey && vapidPrivateKey) {
    try {
      webpush.setVapidDetails(VAPID_SUBJECT, vapidPublicKey, vapidPrivateKey);
    } catch (e) {
      console.error("VAPID setup error from env:", e.message);
    }
    return;
  }
  if (db && db.vapidKeys && db.vapidKeys.publicKey && db.vapidKeys.privateKey) {
    vapidPublicKey = db.vapidKeys.publicKey;
    vapidPrivateKey = db.vapidKeys.privateKey;
    try {
      webpush.setVapidDetails(VAPID_SUBJECT, vapidPublicKey, vapidPrivateKey);
    } catch (e) {
      console.error("VAPID setup error from db:", e.message);
    }
    return;
  }
  const generated = webpush.generateVAPIDKeys();
  vapidPublicKey = generated.publicKey;
  vapidPrivateKey = generated.privateKey;
  if (db) {
    db.vapidKeys = generated;
  }
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, vapidPublicKey, vapidPrivateKey);
  } catch (e) {
    console.error("VAPID setup error for generated keys:", e.message);
  }
}

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

const DEFAULT_RUNS = [];
const DEFAULT_DB = {
  runs: [],
  runners: {},
  profiles: {},
  pushSubscriptions: [],
  vapidKeys: null,
};

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
  const brainDir = "C:\\Users\\lamas\\.gemini\\antigravity-ide\\brain\\d75a34c9-0817-4f47-b1e4-8bd3805e978f";
  const userUploadDir = path.join(brainDir, ".user_uploaded");
  const imgDir = path.join(ROOT, "images");
  if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
  const bgGenPath = path.join(brainDir, "site_bg_pattern_1787251535547.jpg");
  const bgTargetPath = path.join(imgDir, "bg.jpg");
  if (fs.existsSync(bgGenPath)) {
    try { fs.copyFileSync(bgGenPath, bgTargetPath); } catch { }
  }
  if (fs.existsSync(userUploadDir)) {
    const artMap = {
      "coffee.jpg": "media_1787230402177.jpg",       // Coffee by Maailis Pasal
      "ice-bath.jpg": "media_1787230401957.jpg",     // Icebath
      "breakfast.jpg": "media_1787230402086.jpg",    // Breakfast by MileMark
      "dj-set.jpg": "media_1787230401846.jpg",       // DJ set by AROX
      "group-run.jpg": "media_1787230401613.jpg",    // Group and ice bath / shoes
    };
    for (const [targetName, srcName] of Object.entries(artMap)) {
      const srcPath = path.join(userUploadDir, srcName);
      const targetPath = path.join(imgDir, targetName);
      if (fs.existsSync(srcPath)) {
        try {
          fs.copyFileSync(srcPath, targetPath);
        } catch { }
      }
    }
  }
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
let memoryDbCache = null;
let isWritingDb = false;
const writeQueue = [];

async function flushWriteQueue() {
  if (isWritingDb || writeQueue.length === 0) return;
  isWritingDb = true;
  const nextDb = writeQueue.shift();
  try {
    if (USE_REDIS) {
      await redisSet(JSON.stringify(nextDb));
    } else {
      ensureDb();
      fs.writeFileSync(DB_PATH, JSON.stringify(nextDb, null, 2));
    }
  } catch (err) {
    console.error("Database persistent write error:", err);
  } finally {
    isWritingDb = false;
    if (writeQueue.length > 0) {
      setImmediate(flushWriteQueue);
    }
  }
}

async function readDb() {
  if (memoryDbCache) return memoryDbCache;
  if (USE_REDIS) {
    const raw = await redisGet();
    if (raw) {
      memoryDbCache = normalizeDb(JSON.parse(raw));
      return memoryDbCache;
    }
    const seed = clone(DEFAULT_DB);
    await redisSet(JSON.stringify(seed));
    memoryDbCache = normalizeDb(seed);
    return memoryDbCache;
  }
  ensureDb();
  memoryDbCache = normalizeDb(JSON.parse(fs.readFileSync(DB_PATH, "utf8")));
  return memoryDbCache;
}

async function writeDb(db) {
  memoryDbCache = normalizeDb(db);
  writeQueue.push(clone(memoryDbCache));
  flushWriteQueue();
}
function normalizeDb(db) {
  if (!db || typeof db !== "object") db = {};
  if (!Array.isArray(db.runs)) db.runs = clone(DEFAULT_RUNS);
  db.runs.forEach((r) => {
    if (!r.status) r.status = "scheduled";
    if (typeof r.statusNote !== "string") r.statusNote = "";
  });
  if (!db.runners || typeof db.runners !== "object") db.runners = {};
  if (!db.profiles || typeof db.profiles !== "object") db.profiles = {};
  if (!Array.isArray(db.pushSubscriptions)) db.pushSubscriptions = [];
  initVapid(db);
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
  const computed = ACHIEVEMENT_ORDER.filter((id) => ACHIEVEMENT_CHECKS[id] && ACHIEVEMENT_CHECKS[id](ctx));
  // Preserve special / easter-egg badges minted under Not Another Exp.
  const special = (profile.badges || []).filter((id) => !ACHIEVEMENT_CHECKS[id]);
  return [...new Set([...computed, ...special])];
}
function publicProfile(p) {
  return {
    key: p.key,
    alias: p.alias,
    // the member's own contact details — only ever returned to that member (me/join/log),
    // never in the public wall or leaderboard, so they're safe to send back for prefill.
    email: p.email || "",
    phone: p.phone || "",
    ig: p.ig || "",
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

// ---------- http helpers & security headers ----------
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

function sendCompressed(req, res, statusCode, headers, body) {
  const buf = Buffer.isBuffer(body)
    ? body
    : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));

  const acceptEncoding = String(req?.headers?.["accept-encoding"] || "");
  const resHeaders = { ...SECURITY_HEADERS, ...(headers || {}) };

  if (buf.length >= 512) {
    if (/\bgzip\b/i.test(acceptEncoding)) {
      zlib.gzip(buf, (err, compressed) => {
        if (err) {
          resHeaders["Content-Length"] = buf.length;
          res.writeHead(statusCode, resHeaders);
          res.end(buf);
          return;
        }
        resHeaders["Content-Encoding"] = "gzip";
        resHeaders["Content-Length"] = compressed.length;
        resHeaders["Vary"] = "Accept-Encoding";
        res.writeHead(statusCode, resHeaders);
        res.end(compressed);
      });
      return;
    } else if (/\bdeflate\b/i.test(acceptEncoding)) {
      zlib.deflate(buf, (err, compressed) => {
        if (err) {
          resHeaders["Content-Length"] = buf.length;
          res.writeHead(statusCode, resHeaders);
          res.end(buf);
          return;
        }
        resHeaders["Content-Encoding"] = "deflate";
        resHeaders["Content-Length"] = compressed.length;
        resHeaders["Vary"] = "Accept-Encoding";
        res.writeHead(statusCode, resHeaders);
        res.end(compressed);
      });
      return;
    }
  }

  resHeaders["Content-Length"] = buf.length;
  res.writeHead(statusCode, resHeaders);
  res.end(buf);
}

function sendJson(res, statusCode, payload, extraHeaders, req) {
  const headers = {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    ...(extraHeaders || {}),
  };
  const body = JSON.stringify(payload);
  const targetReq = req || res._req;
  if (targetReq) {
    sendCompressed(targetReq, res, statusCode, headers, body);
  } else {
    res.writeHead(statusCode, headers);
    res.end(body);
  }
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
const IS_PROD = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
const SECURE_COOKIE = IS_PROD ? "; Secure" : "";

function memberCookieHeader(key) {
  return `mm_member=${encodeURIComponent(createMemberCookie(key))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MEMBER_SESSION_DAYS * 24 * 60 * 60}${SECURE_COOKIE}`;
}
// ---------- Rate Limiting ----------
const rateLimitBuckets = new Map();

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff && typeof xff === "string") {
    const firstIp = xff.split(",")[0].trim();
    if (firstIp) return firstIp;
  }
  return (
    req.socket?.remoteAddress ||
    req.connection?.remoteAddress ||
    req.headers["x-real-ip"] ||
    "127.0.0.1"
  );
}

function checkRateLimit(key, maxRequests, windowMs) {
  const now = Date.now();
  let record = rateLimitBuckets.get(key);
  if (!record || record.resetAt <= now) {
    record = { count: 1, resetAt: now + windowMs };
    rateLimitBuckets.set(key, record);
    return { limited: false, remaining: maxRequests - 1, resetInMs: windowMs };
  }
  record.count++;
  if (record.count > maxRequests) {
    return { limited: true, remaining: 0, resetInMs: Math.max(0, record.resetAt - now) };
  }
  return { limited: false, remaining: maxRequests - record.count, resetInMs: Math.max(0, record.resetAt - now) };
}

function clearRateLimit(key) {
  rateLimitBuckets.delete(key);
}

if (typeof setInterval !== "undefined") {
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of rateLimitBuckets.entries()) {
      if (record.resetAt <= now) {
        rateLimitBuckets.delete(key);
      }
    }
  }, 10 * 60 * 1000);
  if (cleanupTimer.unref) cleanupTimer.unref();
}

async function broadcastPushNotification(db, { title, body, url, runId }) {
  if (!webpush || !vapidPublicKey) return { ok: false, sent: 0, failed: 0, error: "Push not configured" };
  const payload = JSON.stringify({
    title: String(title || "MileMark").trim().slice(0, 100),
    body: String(body || "We run soon. See you on the road.").trim().slice(0, 300),
    url: String(url || "./").trim().slice(0, 200),
    tag: "milemark-alert-" + Date.now(),
  });

  let subscribers = db.pushSubscriptions || [];
  if (runId) {
    subscribers = subscribers.filter((s) => !s.runId || s.runId === runId);
  }

  let sent = 0;
  let failed = 0;
  const expiredEndpoints = new Set();

  await Promise.all(
    subscribers.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, payload);
        sent++;
      } catch (err) {
        failed++;
        if (err.statusCode === 404 || err.statusCode === 410) {
          expiredEndpoints.add(sub.endpoint);
        } else {
          console.error("WebPush broadcast error:", err.message);
        }
      }
    })
  );

  if (expiredEndpoints.size > 0) {
    db.pushSubscriptions = db.pushSubscriptions.filter((s) => !expiredEndpoints.has(s.endpoint));
    await writeDb(db);
  }

  return { ok: true, sent, failed, purged: expiredEndpoints.size };
}

function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  sendJson(res, 401, { error: "Admin login required." });
  return false;
}

// ---------- API ----------
async function handleApi(req, res, pathname) {
  // ---- admin auth (rate limited to 5 attempts per 15 min per IP) ----
  if (req.method === "POST" && pathname === "/api/admin/login") {
    const ip = getClientIp(req);
    const rateKey = `admin_login:${ip}`;
    const limit = checkRateLimit(rateKey, 5, 15 * 60 * 1000);
    if (limit.limited) {
      const minutes = Math.ceil(limit.resetInMs / 60000);
      sendJson(res, 429, {
        error: `Too many failed login attempts. Please wait ${minutes} minute${minutes === 1 ? "" : "s"} before trying again.`,
      });
      return;
    }

    const body = await readBody(req);
    if (String(body.password || "") !== ADMIN_PASSWORD) {
      sendJson(res, 401, { error: "Wrong admin password." });
      return;
    }
    clearRateLimit(rateKey);
    sendJson(res, 200, { ok: true, expiresInMinutes: ADMIN_SESSION_MINUTES }, {
      "Set-Cookie": `mm_admin=${encodeURIComponent(createAdminCookie())}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ADMIN_SESSION_MINUTES * 60}${SECURE_COOKIE}`,
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
        you: !!meKey && normKey(r.email || r.contact) === meKey,
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

  // ---- sign up for a run (the core write, rate limited to 10 signups per hour per IP) ----
  if (req.method === "POST" && pathname === "/api/join") {
    const ip = getClientIp(req);
    const rateKey = `join:${ip}`;
    const limit = checkRateLimit(rateKey, 10, 60 * 60 * 1000);
    if (limit.limited) {
      sendJson(res, 429, {
        error: "Too many signup requests from this connection. Please wait before trying again.",
      });
      return;
    }

    const body = await readBody(req);
    const runId = String(body.runId || "");
    const alias = String(body.alias || "").trim().slice(0, 40);
    const email = String(body.email || "").trim().toLowerCase().slice(0, 120);
    const phone = String(body.phone || "").trim().slice(0, 30);
    const ig = String(body.ig || "").trim().replace(/^@/, "").slice(0, 40);
    const pace = String(body.pace || "just here for it").slice(0, 40);
    const note = String(body.note || "").trim().slice(0, 80);
    const run = db.runs.find((r) => r.id === runId);

    const phoneDigits = phone.replace(/\D/g, "");
    // compare by the last 10 digits so "+91 99900 01111" and "9990001111" are the same person
    const phoneTail = phoneDigits.slice(-10);
    if (!run) return sendJson(res, 404, { error: "That run doesn't exist anymore." });
    if (run.status === "cancelled") {
      return sendJson(res, 400, { error: "This run has been cancelled by the organizers." });
    }
    if (!alias) return sendJson(res, 400, { error: "Tell us what to call you." });
    if (phoneDigits.length < 7) return sendJson(res, 400, { error: "Enter a valid phone number." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return sendJson(res, 400, { error: "Enter a valid email." });

    // identity = email. one person gets one spot per run, matched by email OR phone.
    const key = normKey(email);
    const meKey = memberKeyFromCookie(req);
    const isSessionOwner = !!meKey && meKey === key;
    const existingProfile = db.profiles[key];

    // --- Identity Protection: Anti-Collision & Profile Hijacking Prevention ---
    // If a profile already exists for this email:
    // 1. If requester has a valid signed session cookie for this key (isSessionOwner), allow update.
    // 2. If requester does NOT have a valid cookie (new device / cleared browser data):
    //    Verify that the submitted phone matches the existing profile's registered phone number.
    //    If phone numbers do NOT match, block the overwrite to prevent an attacker from stealing or modifying another runner's profile/points/alias.
    if (existingProfile && !isSessionOwner) {
      const storedPhoneDigits = (existingProfile.phone || "").replace(/\D/g, "");
      const storedPhoneTail = storedPhoneDigits.slice(-10);
      if (storedPhoneTail && storedPhoneTail !== phoneTail) {
        return sendJson(res, 403, {
          error: "This email is already registered to a runner. Use your original registered phone number or enter your own email.",
        });
      }
    }

    // Phone collision check across profiles:
    // Prevent an attacker with a different email from claiming an already registered phone number
    const otherProfileWithPhone = Object.values(db.profiles).find(
      (p) =>
        p.key !== key &&
        p.phone &&
        p.phone.replace(/\D/g, "").slice(-10) === phoneTail
    );
    if (otherProfileWithPhone && !isSessionOwner) {
      const isOtherSessionOwner = !!meKey && meKey === otherProfileWithPhone.key;
      if (!isOtherSessionOwner) {
        return sendJson(res, 409, {
          error: "This phone number is registered under a different email address. Please use your registered email.",
        });
      }
    }

    db.runners[runId] = db.runners[runId] || [];
    const existing = db.runners[runId].find(
      (r) =>
        normKey(r.email || r.contact) === key ||
        (r.phone && r.phone.replace(/\D/g, "").slice(-10) === phoneTail)
    );

    // "same identity" = matched by their own email or verified session
    const sameIdentity = existing && normKey(existing.email || existing.contact) === key;
    if (existing && !sameIdentity && !isSessionOwner) {
      return sendJson(res, 409, {
        error: "This phone number is already registered for this run under a different email.",
      });
    }

    const profile = db.profiles[key] || { key, alias, points: 0, runs: [], badges: [] };
    profile.alias = alias;
    profile.email = email;
    profile.phone = phone;
    profile.ig = ig;

    let awarded = 0;
    if (!existing) {
      if (!profile.runs.includes(runId)) profile.runs.push(runId);
      profile.points += POINTS_PER_RUN;
      awarded = POINTS_PER_RUN;
    }
    const level = levelFor(profile.points);

    if (!existing) {
      db.runners[runId].push({
        alias, email, contact: email, phone, ig, pace, note, level: level.name, at: Date.now(),
      });
    } else if (sameIdentity) {
      // the same person editing their own entry — refresh details, no dup row, no extra points
      Object.assign(existing, {
        alias, email, contact: email, phone, ig, pace,
        note: note || existing.note || "", level: level.name,
      });
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
      { profile: publicProfile(profile), level, awarded, newBadges, badges: earned, already: !!existing },
      { "Set-Cookie": memberCookieHeader(key) }
    );
    return;
  }

  // ---- honor-system log: record what you actually ran, after the run (rate limited to 15 logs per hour per IP) ----
  if (req.method === "POST" && pathname === "/api/log") {
    const ip = getClientIp(req);
    const rateKey = `log:${ip}`;
    const limit = checkRateLimit(rateKey, 15, 60 * 60 * 1000);
    if (limit.limited) {
      sendJson(res, 429, {
        error: "Too many log submissions from this network. Please try again later.",
      });
      return;
    }

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
    const STRAVA_URL_REGEX = /^https:\/\/(www\.)?(strava\.com|strava\.app\.link)\/[a-zA-Z0-9_\-\.\/?&=%#]+$/i;
    const stravaUrl = STRAVA_URL_REGEX.test(rawStrava) ? rawStrava.slice(0, 200) : "";

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

  // ---- easter egg badge claim: Not Another Exp. ----
  if (req.method === "POST" && pathname === "/api/claim-easter-egg") {
    const body = await readBody(req);
    const meKey = memberKeyFromCookie(req);
    let key = meKey;
    const alias = String(body.alias || "").trim().slice(0, 40);
    const email = String(body.email || "").trim().toLowerCase().slice(0, 120);

    if (!key) {
      if (!email || !alias) {
        sendJson(res, 400, { error: "Please enter your name and email to mint the badge." });
        return;
      }
      key = normKey(email);
    }

    const profile = db.profiles[key] || {
      key,
      alias: alias || "explorer",
      email: email || "",
      phone: "",
      ig: "",
      points: 0,
      runs: [],
      badges: [],
    };
    if (alias) profile.alias = alias;
    if (email && !profile.email) profile.email = email;

    const BADGE_ID = "not-another-intruder";
    profile.badges = profile.badges || [];
    const alreadyHad = profile.badges.includes(BADGE_ID);
    if (!alreadyHad) {
      profile.badges.push(BADGE_ID);
      profile.points = (profile.points || 0) + 100;
    }
    db.profiles[key] = profile;
    await writeDb(db);

    const tokenId = "NAE-GEN0-" + Math.abs(key.split("").reduce((a, b) => ((a << 5) - a + b.charCodeAt(0)) | 0, 0)).toString(16).toUpperCase().padStart(6, "0");

    sendJson(
      res,
      200,
      {
        ok: true,
        alreadyHad,
        tokenId,
        badgeId: BADGE_ID,
        profile: publicProfile(profile),
        level: levelFor(profile.points),
      },
      { "Set-Cookie": memberCookieHeader(key) }
    );
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

    const validStatuses = ["scheduled", "cancelled", "postponed"];
    const status = validStatuses.includes(body.status) ? body.status : "scheduled";
    const statusNote = String(body.statusNote || "").trim().slice(0, 200);

    const run = {
      id: body.id || slugId(title),
      title: title.slice(0, 80),
      blurb: String(body.blurb || "").trim().slice(0, 300),
      startsAt,
      where: String(body.where || "").trim().slice(0, 80),
      distance: String(body.distance || "").trim().slice(0, 40),
      status,
      statusNote,
      featured: !!body.featured,
      route: route.map((p) => [Number(p[0]), Number(p[1])]),
    };
    if (run.featured) db.runs.forEach((r) => (r.featured = false)); // only one featured
    const i = db.runs.findIndex((r) => r.id === run.id);
    const prevStatus = i >= 0 ? db.runs[i].status : "scheduled";
    if (i >= 0) db.runs[i] = run;
    else db.runs.push(run);
    await writeDb(db);

    let pushAlert = null;
    if (body.notifyPush) {
      const alertTitle =
        status === "cancelled"
          ? `⚠️ Run Cancelled: ${run.title}`
          : status === "postponed"
            ? `⏳ Run Postponed: ${run.title}`
            : `🏃 Run Update: ${run.title}`;
      const alertBody =
        statusNote ||
        (status === "cancelled"
          ? "This run has been cancelled by organizers. Check the app for updates."
          : status === "postponed"
            ? "This run has been postponed. Check the app for the new date and time."
            : "Details updated for this run. See you on the road!");
      pushAlert = await broadcastPushNotification(db, {
        title: alertTitle,
        body: alertBody,
        url: "./",
        runId: run.id,
      });
    }

    sendJson(res, i >= 0 ? 200 : 201, { run, pushAlert });
    return;
  }

  // Quick run status update & instant push broadcast
  if (req.method === "POST" && pathname === "/api/admin/run/status") {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const runId = String(body.runId || "").trim();
    const run = db.runs.find((r) => r.id === runId);
    if (!run) return sendJson(res, 404, { error: "Run not found." });

    const validStatuses = ["scheduled", "cancelled", "postponed"];
    if (!validStatuses.includes(body.status)) {
      return sendJson(res, 400, { error: "Invalid status. Must be scheduled, cancelled, or postponed." });
    }

    run.status = body.status;
    if (typeof body.statusNote === "string") {
      run.statusNote = body.statusNote.trim().slice(0, 200);
    }
    await writeDb(db);

    let pushAlert = null;
    if (body.notifyPush !== false) {
      const alertTitle =
        run.status === "cancelled"
          ? `⚠️ Run Cancelled: ${run.title}`
          : run.status === "postponed"
            ? `⏳ Run Postponed: ${run.title}`
            : `🏃 Run Re-scheduled: ${run.title}`;
      const alertBody =
        run.statusNote ||
        (run.status === "cancelled"
          ? "This run has been cancelled. Check the app for updates."
          : run.status === "postponed"
            ? "This run has been postponed. Check the app for the new schedule."
            : "This run is back on schedule! See you at the starting point.");

      pushAlert = await broadcastPushNotification(db, {
        title: alertTitle,
        body: alertBody,
        url: "./",
        runId: run.id,
      });
    }

    sendJson(res, 200, { ok: true, run, pushAlert });
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

  // ---- web push notifications ----
  if (req.method === "GET" && pathname === "/api/push/vapid-key") {
    sendJson(res, 200, { publicKey: vapidPublicKey });
    return;
  }

  if (req.method === "POST" && pathname === "/api/push/subscribe") {
    const body = await readBody(req);
    const subscription = body.subscription;
    if (!subscription || !subscription.endpoint || !subscription.keys) {
      return sendJson(res, 400, { error: "Invalid push subscription object." });
    }
    const meKey = memberKeyFromCookie(req);
    const runId = String(body.runId || "").trim();
    db.pushSubscriptions = db.pushSubscriptions || [];
    const idx = db.pushSubscriptions.findIndex((s) => s.endpoint === subscription.endpoint);
    const subRecord = {
      ...subscription,
      memberKey: meKey || null,
      runId: runId || null,
      updatedAt: Date.now(),
    };
    if (idx >= 0) {
      db.pushSubscriptions[idx] = subRecord;
    } else {
      db.pushSubscriptions.push(subRecord);
    }
    await writeDb(db);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/push/unsubscribe") {
    const body = await readBody(req);
    const endpoint = String(body.endpoint || "").trim();
    if (endpoint) {
      db.pushSubscriptions = (db.pushSubscriptions || []).filter((s) => s.endpoint !== endpoint);
      await writeDb(db);
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && pathname === "/api/admin/push/stats") {
    if (!requireAdmin(req, res)) return;
    const count = (db.pushSubscriptions || []).length;
    sendJson(res, 200, { count });
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/push/broadcast") {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const title = String(body.title || "MileMark").trim().slice(0, 100);
    const message = String(body.body || "We run soon. See you on the road.").trim().slice(0, 300);
    const url = String(body.url || "./").trim().slice(0, 200);
    const targetRunId = String(body.runId || "").trim();

    const pushResult = await broadcastPushNotification(db, {
      title,
      body: message,
      url,
      runId: targetRunId,
    });

    sendJson(res, 200, pushResult);
    return;
  }

  if (req.method === "POST" && pathname === "/api/admin/push/test") {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const targetSub = body.subscription;
    const title = String(body.title || "MileMark [Test]").trim().slice(0, 100);
    const message = String(
      body.body || "This is a test notification from MileMark organizers."
    ).trim().slice(0, 300);

    const payload = JSON.stringify({
      title,
      body: message,
      url: "./",
      tag: "milemark-test-" + Date.now(),
    });

    if (targetSub && targetSub.endpoint) {
      try {
        await webpush.sendNotification(targetSub, payload);
        sendJson(res, 200, { ok: true, sent: 1 });
        return;
      } catch (err) {
        sendJson(res, 500, { error: "Failed to send test notification: " + err.message });
        return;
      }
    }

    const firstSub = (db.pushSubscriptions || [])[0];
    if (!firstSub) {
      sendJson(res, 400, { error: "No push subscribers found to test with." });
      return;
    }
    try {
      await webpush.sendNotification(firstSub, payload);
      sendJson(res, 200, { ok: true, sent: 1 });
    } catch (err) {
      sendJson(res, 500, { error: "Failed to send test notification: " + err.message });
    }
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
  if (pathname.startsWith("/images/")) {
    try { ensureDb(); } catch { }
  }
  const safe = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(ROOT, decodeURIComponent(safe)));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }

  fs.stat(filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const ext = path.extname(filePath);
    const isImg = [".png", ".jpg", ".jpeg", ".svg", ".webp", ".ico"].includes(ext);
    const isDev = !process.env.VERCEL;
    const cacheControl = pathname === "/sw.js" || isDev
      ? "no-cache, must-revalidate"
      : isImg
        ? "public, max-age=31536000, immutable"
        : "public, max-age=3600, stale-while-revalidate=86400";

    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, {
        ...SECURITY_HEADERS,
        "ETag": etag,
        "Cache-Control": cacheControl,
      });
      res.end();
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, SECURITY_HEADERS);
        res.end("not found");
        return;
      }
      const headers = {
        ...SECURITY_HEADERS,
        "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
        "ETag": etag,
        "Cache-Control": cacheControl,
      };
      sendCompressed(req, res, 200, headers, data);
    });
  });
}

function handleRequest(req, res) {
  try {
    res._req = req;
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
