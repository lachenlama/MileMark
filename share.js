// MileMark share layer — turns a "mark" (achievement) or an "i'm in" moment into
// a hand-drawn, Instagram-Story-sized card (1080×1920) you can drop on your story.
// Excalidraw vibe: dotted paper, wobbly ink frame, a handwriting note.
// Sharing: Web Share API with the PNG (opens the IG/share sheet on phones),
// falling back to a download on desktop.
const MMShare = (() => {
  const W = 1080;
  const H = 1920;
  const BG = "#080808";
  const INK = "#f6f3ed";
  const MUTED = "#b9b3aa";

  let fontsReady = null;
  function loadFonts() {
    if (fontsReady) return fontsReady;
    fontsReady = (document.fonts
      ? Promise.all([
          document.fonts.load('400 130px "Anton"'),
          document.fonts.load('700 64px "Caveat"'),
          document.fonts.load('800 32px "Manrope"'),
          document.fonts.load('900 32px "Manrope"'),
        ]).catch(() => {})
      : Promise.resolve());
    return fontsReady;
  }

  // ---- excalidraw-ish ink helpers ----
  const jit = (n) => (Math.random() - 0.5) * n;
  function roughLine(ctx, x1, y1, x2, y2, wob = 4) {
    for (let i = 0; i < 2; i++) {
      ctx.beginPath();
      ctx.moveTo(x1 + jit(wob), y1 + jit(wob));
      const mx = (x1 + x2) / 2 + jit(wob * 1.5);
      const my = (y1 + y2) / 2 + jit(wob * 1.5);
      ctx.quadraticCurveTo(mx, my, x2 + jit(wob), y2 + jit(wob));
      ctx.stroke();
    }
  }
  function roughRect(ctx, x, y, w, h, wob = 5) {
    roughLine(ctx, x, y, x + w, y, wob);
    roughLine(ctx, x + w, y, x + w, y + h, wob);
    roughLine(ctx, x + w, y + h, x, y + h, wob);
    roughLine(ctx, x, y + h, x, y, wob);
  }
  function dottedPaper(ctx) {
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    for (let y = 70; y < H; y += 64) {
      for (let x = 70; x < W; x += 64) {
        ctx.beginPath();
        ctx.arc(x, y, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }
  function wrap(ctx, text, maxW) {
    const words = (text || "").split(/\s+/);
    const lines = [];
    let line = "";
    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (ctx.measureText(test).width > maxW && line) {
        lines.push(line);
        line = w;
      } else line = test;
    }
    if (line) lines.push(line);
    return lines;
  }

  // draws a wobbly sketch of a run route into a box (excalidraw line vibe)
  function drawRouteSketch(ctx, route, cx, cy, boxW, boxH, tone) {
    if (!route || route.length < 2) return;
    const lats = route.map((p) => p[0]);
    const lngs = route.map((p) => p[1]);
    const minLa = Math.min(...lats),
      maxLa = Math.max(...lats);
    const minLo = Math.min(...lngs),
      maxLo = Math.max(...lngs);
    const sx = maxLo - minLo || 1e-6;
    const sy = maxLa - minLa || 1e-6;
    const x0 = cx - boxW / 2;
    const y0 = cy - boxH / 2;
    const pts = route.map(([la, lo]) => [
      x0 + ((lo - minLo) / sx) * boxW,
      y0 + boxH - ((la - minLa) / sy) * boxH,
    ]);
    ctx.save();
    ctx.strokeStyle = tone;
    ctx.lineWidth = 9;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let i = 1; i < pts.length; i++) {
      roughLine(ctx, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], 3);
    }
    const dot = (p, fill) => {
      ctx.beginPath();
      ctx.fillStyle = fill;
      ctx.arc(p[0], p[1], 13, 0, Math.PI * 2);
      ctx.fill();
    };
    dot(pts[0], "#ff233d");
    dot(pts[pts.length - 1], "#ffd43b");
    ctx.restore();
  }

  // ---- the card ----
  // opts: { kind:"badge"|"signup", tone, glyph, headline, note, alias, sub, route }
  async function renderCard(opts) {
    await loadFonts();
    const tone = opts.tone || "#ff233d";
    const cv = document.createElement("canvas");
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext("2d");

    // background + brand glows
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    const g1 = ctx.createRadialGradient(150, -80, 0, 150, -80, 760);
    g1.addColorStop(0, "rgba(255,35,61,0.30)");
    g1.addColorStop(1, "rgba(255,35,61,0)");
    ctx.fillStyle = g1;
    ctx.fillRect(0, 0, W, H);
    const g2 = ctx.createRadialGradient(960, 120, 0, 960, 120, 720);
    g2.addColorStop(0, "rgba(255,212,59,0.22)");
    g2.addColorStop(1, "rgba(255,212,59,0)");
    ctx.fillStyle = g2;
    ctx.fillRect(0, 0, W, H);
    dottedPaper(ctx);

    // hand-drawn ink frame
    ctx.strokeStyle = tone;
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    roughRect(ctx, 54, 54, W - 108, H - 108, 6);

    ctx.textAlign = "center";

    // wordmark
    ctx.fillStyle = INK;
    ctx.font = '400 70px "Anton", sans-serif';
    ctx.save();
    ctx.translate(0, 0);
    ctx.fillText("MILEMARK", W / 2, 196);
    ctx.restore();
    ctx.fillStyle = MUTED;
    ctx.font = '700 50px "Caveat", cursive';
    ctx.fillText("a not another run", W / 2, 256);

    // top hairline
    ctx.strokeStyle = "rgba(255,255,255,0.16)";
    ctx.lineWidth = 3;
    roughLine(ctx, 200, 300, W - 200, 300, 3);

    if (opts.kind === "signup" || opts.kind === "result") {
      // route sketch (or a glyph fallback), then a big headline
      if (opts.route && opts.route.length > 1) {
        drawRouteSketch(ctx, opts.route, W / 2, 560, 560, 340, tone);
      } else {
        ctx.font = "200px serif";
        ctx.fillStyle = tone;
        ctx.fillText(opts.glyph || "✺", W / 2, 640);
      }
      ctx.fillStyle = INK;
      const big = opts.kind === "result" ? 168 : 200;
      ctx.font = "400 " + big + 'px "Anton", sans-serif';
      ctx.fillText((opts.headline || "i'm in.").toLowerCase(), W / 2, 1010);
    } else {
      // badge: big glyph in a hand-drawn ring
      ctx.save();
      ctx.strokeStyle = tone;
      ctx.lineWidth = 7;
      const r = 200;
      ctx.beginPath();
      for (let a = 0; a <= Math.PI * 2 + 0.2; a += 0.18) {
        const rr = r + jit(7);
        const px = W / 2 + Math.cos(a) * rr;
        const py = 600 + Math.sin(a) * rr;
        a === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = tone;
      ctx.font = "230px serif";
      ctx.textBaseline = "middle";
      ctx.fillText(opts.glyph || "✺", W / 2, 612);
      ctx.textBaseline = "alphabetic";

      // eyebrow
      ctx.fillStyle = MUTED;
      ctx.font = '900 34px "Manrope", sans-serif';
      ctx.fillText("·  A  NEW  MARK  ·", W / 2, 900);

      // name
      ctx.fillStyle = INK;
      ctx.font = '400 150px "Anton", sans-serif';
      ctx.fillText((opts.headline || "").toLowerCase(), W / 2, 1040);
    }

    // wobbly underline accent
    ctx.strokeStyle = tone;
    ctx.lineWidth = 9;
    roughLine(ctx, W / 2 - 220, 1095, W / 2 + 220, 1095, 7);

    // handwriting note
    ctx.fillStyle = INK;
    ctx.font = '700 70px "Caveat", cursive';
    const noteLines = wrap(ctx, opts.note || "", W - 360);
    let ny = 1260;
    for (const ln of noteLines) {
      ctx.fillText(ln, W / 2, ny);
      ny += 86;
    }

    // bottom: who
    ctx.strokeStyle = "rgba(255,255,255,0.16)";
    ctx.lineWidth = 3;
    roughLine(ctx, 200, 1640, W - 200, 1640, 3);
    if (opts.alias) {
      ctx.fillStyle = INK;
      ctx.font = '400 84px "Anton", sans-serif';
      ctx.fillText(opts.alias.toLowerCase(), W / 2, 1740);
    }
    if (opts.sub) {
      ctx.fillStyle = MUTED;
      ctx.font = '800 38px "Manrope", sans-serif';
      ctx.fillText(opts.sub, W / 2, 1796);
    }

    return cv;
  }

  // ---- share / download ----
  function canvasToBlob(cv) {
    return new Promise((res) => cv.toBlob(res, "image/png", 0.95));
  }
  async function shareCanvas(cv, text) {
    const blob = await canvasToBlob(cv);
    const file = new File([blob], "milemark.png", { type: "image/png" });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], text });
        return "shared";
      }
    } catch (e) {
      if (e && e.name === "AbortError") return "cancelled";
    }
    // fallback: download
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "milemark-mark.png";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return "downloaded";
  }

  // ---- opt builders ----
  function badgeOpts(badge, profile) {
    const lvl = profile ? MM.levelFor(profile.points) : null;
    return {
      kind: "badge",
      tone: badge.tone,
      glyph: badge.glyph,
      headline: badge.name,
      note: badge.note,
      alias: profile ? profile.alias : "",
      sub: lvl ? "lvl " + (lvl.index + 1) + " · " + lvl.name + " · " + profile.points + " pts" : "",
    };
  }
  function signupOpts(run, profile, level) {
    return {
      kind: "signup",
      tone: "#ff233d",
      glyph: "✺",
      headline: "i'm in.",
      note: "“" + run.title + "” — " + MM.whenText(run.startsAt) + ". see you on the road.",
      route: run.route,
      alias: profile ? profile.alias : "",
      sub: level ? "lvl " + (level.index + 1) + " · " + level.name : "",
    };
  }
  function resultOpts(run, profile, result) {
    const km = result && result.distanceKm;
    const time = result && result.durationSec ? MM.formatTime(result.durationSec) : "";
    const lvl = profile ? MM.levelFor(profile.points) : null;
    const bits = [];
    if (time) bits.push(time);
    if (lvl) bits.push("lvl " + (lvl.index + 1) + " · " + lvl.name);
    return {
      kind: "result",
      tone: "#46e39c",
      glyph: "⚑",
      headline: km ? km + " km" : "i ran it",
      note: result && result.note ? result.note : "“" + run.title + "” — done. that's the proof.",
      route: run.route,
      alias: profile ? profile.alias : "",
      sub: bits.join("  ·  "),
    };
  }

  // ---- preview modal ----
  let lastCanvas = null;
  function ensureModal() {
    let m = document.getElementById("shareModal");
    if (m) return m;
    m = document.createElement("div");
    m.id = "shareModal";
    m.className = "share-modal";
    m.hidden = true;
    m.innerHTML = `
      <div class="sm-backdrop" data-sm-close></div>
      <div class="sm-card">
        <button type="button" class="sm-x" data-sm-close aria-label="close">✕</button>
        <p class="sm-kicker" id="smKicker"></p>
        <h3 id="smTitle">your mark</h3>
        <div class="sm-preview"><img id="smImg" alt="your shareable card" /></div>
        <div class="sm-actions">
          <button class="cta" id="smShare">drop it on your story →</button>
          <button class="ghost-btn sm-save" id="smSave">save image</button>
        </div>
        <p class="sm-fine" id="smFine">made on milemark · tag us if you post it</p>
      </div>`;
    document.body.appendChild(m);
    m.querySelectorAll("[data-sm-close]").forEach((el) =>
      el.addEventListener("click", closeModal)
    );
    m.querySelector("#smShare").addEventListener("click", async () => {
      if (!lastCanvas) return;
      const r = await shareCanvas(lastCanvas, "another mark on milemark.");
      if (r === "downloaded" && window.toast) toast("saved — add it to your story");
    });
    m.querySelector("#smSave").addEventListener("click", async () => {
      if (!lastCanvas) return;
      const blob = await canvasToBlob(lastCanvas);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "milemark-mark.png";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      if (window.toast) toast("saved to your phone");
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !m.hidden) closeModal();
    });
    return m;
  }
  function closeModal() {
    const m = document.getElementById("shareModal");
    if (m) m.hidden = true;
    document.body.style.overflow = "";
  }
  async function openCard(opts, ui) {
    const m = ensureModal();
    m.querySelector("#smKicker").textContent = (ui && ui.kicker) || "your mark";
    m.querySelector("#smTitle").textContent = (ui && ui.title) || opts.headline || "your mark";
    const img = m.querySelector("#smImg");
    img.removeAttribute("src");
    m.hidden = false;
    document.body.style.overflow = "hidden";
    lastCanvas = await renderCard(opts);
    img.src = lastCanvas.toDataURL("image/png");
  }

  // public api
  return {
    renderCard,
    shareCanvas,
    openBadge: (badge, profile, ui) =>
      openCard(badgeOpts(badge, profile), ui || { kicker: "a mark you earned", title: badge.name }),
    openSignup: (run, profile, level, ui) =>
      openCard(signupOpts(run, profile, level), ui || { kicker: "you're on the wall", title: "i'm in" }),
    openResult: (run, profile, result, ui) =>
      openCard(resultOpts(run, profile, result), ui || { kicker: "you ran it", title: "logged" }),
    closeModal,
  };
})();
