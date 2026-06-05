// Dev tool: generates the MileMark app icons (PNG) with no external deps.
// Draws a dark full-bleed square with a bold red->yellow "route" line + start/end pins.
// Run: node generate-icons.js
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const RED = [255, 35, 61];
const YELLOW = [255, 212, 59];
const BG = [8, 8, 8];

// route waypoints in unit space (x right, y down)
const ROUTE = [
  [0.18, 0.76],
  [0.42, 0.5],
  [0.6, 0.64],
  [0.84, 0.24],
];

function lerp(a, b, t) {
  return a + (b - a) * t;
}
function mix(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}
// distance from point p to segment ab, plus the clamped param t along ab
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1e-9;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return { dist: Math.hypot(px - cx, py - cy), t };
}

function drawPixel(u, v) {
  // u,v in [0,1]. returns [r,g,b]
  const half = 0.072; // half line width
  const aa = 0.012; // antialias band
  let best = { dist: 1e9, g: 0 };
  for (let i = 0; i < ROUTE.length - 1; i++) {
    const [ax, ay] = ROUTE[i];
    const [bx, by] = ROUTE[i + 1];
    const r = segDist(u, v, ax, ay, bx, by);
    if (r.dist < best.dist) {
      best = { dist: r.dist, g: (i + r.t) / (ROUTE.length - 1) };
    }
  }
  const lineColor = mix(RED, YELLOW, best.g);
  let col = BG.slice();
  // line body
  const lineA = 1 - smooth(half, half + aa, best.dist);
  col = mix(col, lineColor, lineA);
  // pins (start = red, end = yellow), drawn as filled dots with dark core
  const pins = [
    { p: ROUTE[0], c: RED },
    { p: ROUTE[ROUTE.length - 1], c: YELLOW },
  ];
  for (const pin of pins) {
    const d = Math.hypot(u - pin.p[0], v - pin.p[1]);
    const ring = 1 - smooth(0.085, 0.085 + aa, d);
    col = mix(col, pin.c, ring);
    const core = 1 - smooth(0.04, 0.04 + aa, d);
    col = mix(col, BG, core * 0.92);
  }
  return col.map((c) => Math.round(Math.max(0, Math.min(255, c))));
}

function smooth(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function makePNG(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = drawPixel((x + 0.5) / size, (y + 0.5) / size);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = 255;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const outDir = path.join(__dirname, "icons");
fs.mkdirSync(outDir, { recursive: true });
const targets = [
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["icon-maskable-512.png", 512],
  ["apple-touch-icon.png", 180],
];
for (const [name, size] of targets) {
  fs.writeFileSync(path.join(outDir, name), makePNG(size));
  console.log("wrote icons/" + name + " (" + size + "px)");
}
