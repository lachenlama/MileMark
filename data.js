// MileMark shared data layer — runs, runners, profiles, points/levels, route glyphs.
// Loaded before app.js and admin.js. Exposes a global `MM`.
// Everything is localStorage for now (per-device). Swap these helpers for a real
// backend later (NotACafeGG server.js + Upstash Redis is the pattern to reuse).
const MM = (() => {
  const RUNS_KEY = "milemark:runs";
  const PROFILES_KEY = "milemark:profiles";
  const ME_KEY = "milemark:me";
  const runnersKey = (runId) => "milemark:runners:" + runId;

  // ---- gamification config ----
  const POINTS_PER_RUN = 50;
  const LEVELS = [
    { min: 0, name: "just laced up" },
    { min: 100, name: "shows up" },
    { min: 250, name: "regular" },
    { min: 500, name: "road dog" },
    { min: 850, name: "machine" },
    { min: 1300, name: "certified legend" },
  ];

  // map default center — Salbari / Siliguri area, North Bengal
  const MAP_CENTER = [26.68, 88.38];
  const MAP_ZOOM = 14;

  // ---- default runs (seeded once; admin manages them after) ----
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

  // ---- storage helpers ----
  const read = (k, fb) => {
    try {
      const v = JSON.parse(localStorage.getItem(k));
      return v == null ? fb : v;
    } catch {
      return fb;
    }
  };
  const write = (k, v) => localStorage.setItem(k, JSON.stringify(v));

  function getRuns() {
    const stored = read(RUNS_KEY, null);
    if (stored && Array.isArray(stored) && stored.length) return stored;
    write(RUNS_KEY, DEFAULT_RUNS);
    return DEFAULT_RUNS;
  }
  function saveRuns(runs) {
    write(RUNS_KEY, runs);
  }
  function upsertRun(run) {
    const runs = getRuns();
    const i = runs.findIndex((r) => r.id === run.id);
    if (run.featured) runs.forEach((r) => (r.featured = false)); // only one featured
    if (i >= 0) runs[i] = run;
    else runs.push(run);
    saveRuns(runs);
    return run;
  }
  function deleteRun(id) {
    saveRuns(getRuns().filter((r) => r.id !== id));
  }
  function featuredRun() {
    const runs = getRuns();
    return runs.find((r) => r.featured) || runs[0] || null;
  }
  function otherRuns() {
    const f = featuredRun();
    return getRuns().filter((r) => r && r.id !== (f && f.id));
  }

  // ---- runners (per run) ----
  function getRunners(runId) {
    return read(runnersKey(runId), []);
  }
  function addRunner(runId, runner) {
    const list = getRunners(runId);
    list.push(runner);
    write(runnersKey(runId), list);
    return list;
  }

  // ---- profiles + points/levels ----
  const normKey = (contact) =>
    (contact || "").trim().toLowerCase().replace(/^@/, "").replace(/\s+/g, "");

  function getProfiles() {
    return read(PROFILES_KEY, {});
  }
  function getProfile(key) {
    return getProfiles()[key] || null;
  }
  function me() {
    const k = read(ME_KEY, null);
    return k ? getProfile(k) : null;
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

  // registers the current person to a run, awards points, returns updated profile + level
  function joinRun(runId, { alias, contact, pace, note }) {
    const key = normKey(contact);
    const profiles = getProfiles();
    const p = profiles[key] || { key, alias, points: 0, runs: [] };
    p.alias = alias; // keep latest display name
    let awarded = 0;
    if (!p.runs.includes(runId)) {
      p.runs.push(runId);
      p.points += POINTS_PER_RUN;
      awarded = POINTS_PER_RUN;
    }
    profiles[key] = p;
    write(PROFILES_KEY, profiles);
    write(ME_KEY, key);

    const level = levelFor(p.points);
    addRunner(runId, {
      alias,
      contact,
      pace,
      note,
      level: level.name,
      at: Date.now(),
    });
    return { profile: p, level, awarded };
  }

  // ---- visual helpers ----
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

  // haversine distance of a route in km
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

  // little SVG sketch of a route (no tiles) for run cards
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

  // base map tile layers (same OSM data, different looks). `streets` and
  // `satellite` show landmarks/labels clearly; `dark` is the on-brand vibe.
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

  return {
    MAP_CENTER,
    MAP_ZOOM,
    LEVELS,
    POINTS_PER_RUN,
    getRuns,
    saveRuns,
    upsertRun,
    deleteRun,
    featuredRun,
    otherRuns,
    getRunners,
    joinRun,
    getProfile,
    me,
    levelFor,
    initials,
    avatarColor,
    routeKm,
    routeGlyph,
    tileLayers,
    whenText,
  };
})();
