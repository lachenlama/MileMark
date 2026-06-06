// MileMark admin — build a run's route on the map, set details, save it.
const $ = (s) => document.querySelector(s);

let route = []; // [[lat,lng], ...]
let markers = [];
let line = null;
let map = null;
let editingId = null;

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2600);
}

// ---------- map + route building ----------
function initMap() {
  map = L.map("adminMap").setView(MM.MAP_CENTER, MM.MAP_ZOOM);
  const layers = MM.tileLayers();
  layers.streets.addTo(map); // labeled streets by default — easiest to find landmarks
  L.control
    .layers({ streets: layers.streets, satellite: layers.satellite, dark: layers.dark })
    .addTo(map);
  map.on("click", (e) => addPoint([e.latlng.lat, e.latlng.lng]));
}

function addPoint(latlng) {
  route.push(latlng);
  redrawRoute();
}

function redrawRoute() {
  markers.forEach((m) => map.removeLayer(m));
  markers = [];
  if (line) {
    map.removeLayer(line);
    line = null;
  }
  if (route.length) {
    line = L.polyline(route, { color: "#ff233d", weight: 5, opacity: 0.95 }).addTo(map);
  }
  const isLoop =
    route.length > 2 &&
    route[0][0] === route[route.length - 1][0] &&
    route[0][1] === route[route.length - 1][1];
  route.forEach((pt, i) => {
    const isStart = i === 0;
    const isEnd = i === route.length - 1 && route.length > 1;
    const color = isStart ? "#ff233d" : isEnd ? "#ffd43b" : "#f6f3ed";
    const m = L.circleMarker(pt, {
      radius: isStart || isEnd ? 9 : 6,
      color: "#080808",
      weight: 2,
      fillColor: color,
      fillOpacity: 1,
    }).addTo(map);
    // handwritten start / finish labels (excalidraw vibe)
    if (isStart) {
      m.bindTooltip(isLoop ? "start / finish" : "start", {
        permanent: true,
        direction: "top",
        className: "mm-tip mm-tip-start",
        offset: [0, -5],
      });
    } else if (isEnd && !isLoop) {
      m.bindTooltip("finish line", {
        permanent: true,
        direction: "top",
        className: "mm-tip mm-tip-finish",
        offset: [0, -5],
      });
    }
    // circleMarker has no native drag; emulate with mouse/touch handlers
    enableDrag(m, i);
    m.on("contextmenu", () => {
      route.splice(i, 1);
      redrawRoute();
    });
    markers.push(m);
  });
  $("#routeKm").textContent = MM.routeKm(route).toFixed(1) + " km";
  $("#routePts").textContent = route.length;
}

function enableDrag(marker, i) {
  let dragging = false;
  marker.on("mousedown", (e) => {
    dragging = true;
    map.dragging.disable();
    L.DomEvent.stopPropagation(e);
  });
  map.on("mousemove", (e) => {
    if (dragging) {
      route[i] = [e.latlng.lat, e.latlng.lng];
      marker.setLatLng(route[i]);
      if (line) line.setLatLngs(route);
      $("#routeKm").textContent = MM.routeKm(route).toFixed(1) + " km";
    }
  });
  map.on("mouseup", () => {
    if (dragging) {
      dragging = false;
      map.dragging.enable();
    }
  });
}

// ---------- form / save ----------
function isoToLocalInput(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    "T" +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes())
  );
}

function slugId(title) {
  return (
    "run-" +
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 30) +
    "-" +
    Date.now().toString(36)
  );
}

async function saveRun(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const title = (fd.get("title") || "").toString().trim();
  const startsAt = (fd.get("startsAt") || "").toString();
  if (!title || !startsAt) return toast("need at least a title and a date");
  if (route.length < 2) return toast("drop at least 2 route points on the map");

  const run = {
    id: editingId || slugId(title),
    title,
    blurb: (fd.get("blurb") || "").toString().trim(),
    startsAt: new Date(startsAt).toISOString(),
    where: (fd.get("where") || "").toString().trim(),
    distance: (fd.get("distance") || "").toString().trim(),
    featured: fd.get("featured") === "on",
    route: route.slice(),
  };
  const btn = e.target.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  try {
    await MM.upsertRun(run);
    await MM.refresh();
  } catch (err) {
    if (btn) btn.disabled = false;
    return toast(err.message || "couldn't save — are you still logged in?");
  }
  if (btn) btn.disabled = false;
  toast(editingId ? "run updated ✓" : "run saved ✓");
  resetForm();
  renderRuns();
}

function loadRun(run) {
  editingId = run.id;
  const f = $("#runForm");
  f.id.value = run.id;
  f.title.value = run.title;
  f.blurb.value = run.blurb || "";
  f.startsAt.value = isoToLocalInput(run.startsAt);
  f.where.value = run.where || "";
  f.distance.value = run.distance || "";
  f.featured.checked = !!run.featured;
  route = (run.route || []).map((p) => [p[0], p[1]]);
  redrawRoute();
  if (route.length) map.fitBounds(L.polyline(route).getBounds().pad(0.25));
  window.scrollTo({ top: 0, behavior: "smooth" });
  toast("editing “" + run.title + "”");
}

function resetForm() {
  editingId = null;
  $("#runForm").reset();
  $("#runForm").id.value = "";
  route = [];
  redrawRoute();
}

// ---------- run list ----------
function renderRuns() {
  const wrap = $("#adminRuns");
  wrap.innerHTML = "";
  const runs = MM.getRuns();
  if (!runs.length) {
    wrap.innerHTML = '<p class="empty">no runs yet — build one above.</p>';
    return;
  }
  for (const run of runs) {
    const km = MM.routeKm(run.route);
    const count = MM.getRunners(run.id).length;
    const row = document.createElement("article");
    row.className = "admin-run";
    row.innerHTML = `
      <div class="ar-glyph">${MM.routeGlyph(run.route)}</div>
      <div class="ar-body">
        <b></b>
        ${run.featured ? '<span class="level-badge">featured</span>' : ""}
        <small></small>
      </div>
      <div class="ar-actions">
        <button class="ghost-btn" data-edit>edit</button>
        <button class="ghost-btn danger" data-del>delete</button>
      </div>`;
    row.querySelector("b").textContent = run.title;
    row.querySelector("small").textContent =
      MM.whenText(run.startsAt) + " · " + (km ? km.toFixed(1) + " km" : "no route") + " · " + count + " in";
    row.querySelector("[data-edit]").addEventListener("click", () => loadRun(run));
    row.querySelector("[data-del]").addEventListener("click", async () => {
      if (!confirm("delete “" + run.title + "”?")) return;
      try {
        await MM.deleteRun(run.id);
        await MM.refresh();
      } catch (err) {
        return toast(err.message || "couldn't delete");
      }
      if (editingId === run.id) resetForm();
      renderRuns();
      toast("deleted");
    });
    wrap.appendChild(row);
  }
}

// ---------- init ----------
async function init() {
  initMap();
  redrawRoute();
  $("#runForm").addEventListener("submit", saveRun);
  $("#undoBtn").addEventListener("click", () => {
    route.pop();
    redrawRoute();
  });
  $("#clearBtn").addEventListener("click", () => {
    route = [];
    redrawRoute();
  });
  $("#resetFormBtn").addEventListener("click", resetForm);
  const logout = $("#logoutBtn");
  if (logout) {
    logout.addEventListener("click", async () => {
      await MM.adminLogout().catch(() => {});
      location.href = "/admin-login.html";
    });
  }
  setTimeout(() => map.invalidateSize(), 200);

  try {
    await MM.refresh();
  } catch (e) {
    toast("couldn't load runs from the server");
  }
  renderRuns();
}

init();
