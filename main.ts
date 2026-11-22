// One glossy strawberry, painted pixel by pixel.
// Node 22, standard library only, no network, fully deterministic.
import * as fs from 'node:fs';
import * as zlib from 'node:zlib';

const W = 1024;
const H = 1024;
const OUT = '/output/entry.png';

// ---------- deterministic PRNG ----------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Cheap deterministic per-pixel hash -> [0,1)
function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => t * t * (3 - 2 * t);

// ---------- strawberry outline ----------
// half-width profile, control points (t, fraction of max half-width)
const PROF: Array<[number, number]> = [
  [0.0, 0.42], [0.07, 0.82], [0.16, 1.0], [0.3, 0.97],
  [0.48, 0.86], [0.65, 0.68], [0.8, 0.47], [0.9, 0.27], [1.0, 0.0],
];
function halfWidth(t: number): number {
  if (t <= 0) return PROF[0][1] * 340;
  for (let i = 1; i < PROF.length; i++) {
    if (t <= PROF[i][0]) {
      const [t0, w0] = PROF[i - 1];
      const [t1, w1] = PROF[i];
      const u = smooth((t - t0) / (t1 - t0));
      return lerp(w0, w1, u) * 340;
    }
  }
  return 0;
}

const CX = 512;
const Y0 = 296; // top of fruit (under calyx)
const Y1 = 936; // tip

function inBody(x: number, y: number): { t: number; nx: number } | null {
  if (y < Y0 || y > Y1) return null;
  const t = (y - Y0) / (Y1 - Y0);
  const hw = halfWidth(t);
  const dx = (x - CX) / hw;
  if (Math.abs(dx) > 1) return null;
  return { t, nx: dx };
}

// ---------- seeds ----------
interface Seed { x: number; y: number; r: number; }
const seeds: Seed[] = [];
{
  const rows = 9;
  for (let r = 0; r < rows; r++) {
    const t = 0.1 + (r / (rows - 1)) * 0.82;
    const hw = halfWidth(t);
    const spacing = 62;
    const n = Math.max(1, Math.floor((2 * hw * 0.86) / spacing));
    const stagger = r % 2 === 0 ? 0 : spacing / 2;
    const jrnd = mulberry32(1000 + r * 77);
    for (let i = 0; i < n; i++) {
      const sx = CX + (i - (n - 1) / 2) * spacing + stagger * (i % 2 === 0 ? 0.4 : -0.4) + (jrnd() - 0.5) * 14;
      const sy = Y0 + t * (Y1 - Y0) + (jrnd() - 0.5) * 10;
      if (Math.abs(sx - CX) < hw * 0.9) seeds.push({ x: sx, y: sy, r: 12 });
    }
  }
}

// ---------- water droplets (seeded, inside body) ----------
interface Drop { x: number; y: number; r: number; }
const drops: Drop[] = [];
{
  const rnd = mulberry32(20261122);
  let guard = 0;
  while (drops.length < 16 && guard++ < 400) {
    const x = 200 + rnd() * 624;
    const y = 340 + rnd() * 540;
    if (inBody(x, y)) drops.push({ x, y, r: 7 + rnd() * 9 });
  }
}

// ---------- calyx leaves ----------
interface Leaf { ang: number; len: number; wid: number; }
const leaves: Leaf[] = [
  { ang: -1.25, len: 235, wid: 52 },
  { ang: -0.85, len: 265, wid: 58 },
  { ang: -0.45, len: 285, wid: 60 },
  { ang: -0.08, len: 270, wid: 56 },
  { ang: 0.32, len: 285, wid: 60 },
  { ang: 0.72, len: 262, wid: 56 },
  { ang: 1.12, len: 228, wid: 50 },
];
// leaf test: returns u (0 base -> 1 tip) or -1
function leafAt(x: number, y: number): { u: number; leaf: Leaf } | null {
  const bx = CX, by = 300;
  for (const leaf of leaves) {
    const dx = x - bx, dy = y - by;
    const ca = Math.cos(leaf.ang), sa = Math.sin(leaf.ang);
    // leaf axis points up-out: rotate so axis is -y in local frame
    const along = -(dx * sa + dy * ca); // distance along leaf (up = positive)
    const perp = dx * ca - dy * sa;
    if (along < 0 || along > leaf.len) continue;
    const u = along / leaf.len;
    const w = leaf.wid * Math.sin(Math.PI * Math.pow(u, 0.75)) * (1 - u * 0.25);
    if (Math.abs(perp) < w) return { u, leaf };
  }
  return null;
}

// ---------- render ----------
const img = new Uint8Array(W * H * 3);

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    // --- background: dark slate radial spotlight ---
    const bdx = (x - CX) / 640, bdy = (y - 470) / 640;
    const bd = Math.sqrt(bdx * bdx + bdy * bdy);
    const bg = clamp(1 - bd, 0, 1);
    let r = lerp(16, 52, bg * bg);
    let g = lerp(18, 58, bg * bg);
    let b = lerp(24, 72, bg * bg);
    // warm floor glow under the fruit
    const gy = Math.exp(-Math.pow((y - 940) / 90, 2)) * Math.exp(-Math.pow((x - CX) / 380, 2));
    r += 26 * gy; g += 14 * gy; b += 6 * gy;

    // soft contact shadow under fruit
    const sh = Math.exp(-Math.pow((y - 928) / 34, 2)) * Math.exp(-Math.pow((x - CX) / 330, 2));
    r *= 1 - 0.55 * sh; g *= 1 - 0.55 * sh; b *= 1 - 0.55 * sh;

    const body = inBody(x, y);
    if (body) {
      const { t, nx } = body;
      // base red: bright upper-left, deep red edges and bottom
      const lx = (x - 400) / 420, ly = (y - 430) / 430;
      const ld = Math.sqrt(lx * lx + ly * ly);
      const light = clamp(1.15 - ld * 0.85, 0, 1);
      const edge = Math.abs(nx);
      const edgeDark = Math.pow(edge, 2.4);
      const botDark = Math.pow(t, 2.2) * 0.35;
      let br = lerp(228, 150, edgeDark * 0.7 + botDark);
      let bg2 = lerp(46, 16, edgeDark * 0.6 + botDark);
      let bb = lerp(58, 26, edgeDark * 0.6 + botDark);
      br = lerp(br, 235, light * 0.35);
      bg2 = lerp(bg2, 62, light * 0.35);
      bb = lerp(bb, 70, light * 0.35);
      // warm rim light on the right edge
      const rim = Math.pow(clamp((nx - 0.55) / 0.45, 0, 1), 2) * (1 - t * 0.4);
      br += 60 * rim; bg2 += 22 * rim; bb += 8 * rim;
      r = br; g = bg2; b = bb;

      // seed dimples + pale seeds
      for (const s of seeds) {
        const dx = x - s.x, dy = (y - s.y) * 1.35;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < s.r + 4) {
          if (d < s.r) {
            // dimple: darker red bowl
            const k = 1 - d / s.r;
            r = lerp(r, 96, 0.55 * k + 0.25);
            g = lerp(g, 12, 0.55 * k + 0.25);
            b = lerp(b, 18, 0.55 * k + 0.25);
            // pale seed, slightly upper-left of dimple centre
            const sx2 = x - (s.x - 2), sy2 = (y - (s.y - 1)) * 1.4;
            const sd = Math.sqrt(sx2 * sx2 + sy2 * sy2);
            if (sd < 6.5) {
              const sk = 1 - sd / 6.5;
              r = lerp(r, 246, 0.9 * sk + 0.1);
              g = lerp(g, 226, 0.9 * sk + 0.1);
              b = lerp(b, 178, 0.9 * sk + 0.1);
            }
          } else {
            // dimple rim shadow
            const k = 1 - (d - s.r) / 4;
            r *= 1 - 0.25 * k; g *= 1 - 0.25 * k; b *= 1 - 0.25 * k;
          }
        }
      }

      // water droplets: bright rim, glassy body, highlight dot
      for (const d of drops) {
        const dx = x - d.x, dy = y - d.y;
        const dd = Math.sqrt(dx * dx + dy * dy);
        if (dd < d.r) {
          const k = dd / d.r;
          // glassy: lighten toward rim, darken centre slightly
          const rimL = Math.pow(k, 3) * 55;
          r = clamp(r + rimL - 18 * (1 - k), 0, 255);
          g = clamp(g + rimL * 0.9 - 8 * (1 - k), 0, 255);
          b = clamp(b + rimL * 1.1, 0, 255);
          // highlight dot upper-left
          const hx = x - (d.x - d.r * 0.35), hy = y - (d.y - d.r * 0.35);
          if (Math.sqrt(hx * hx + hy * hy) < d.r * 0.32) {
            r = 255; g = 255; b = 255;
          }
        }
      }

      // big soft specular gloss, upper-left
      const gx = (x - 405) / 170, gy2 = (y - 440) / 120;
      const gd = gx * gx + gy2 * gy2;
      const gloss = Math.exp(-gd * 1.6) * 0.34;
      r = lerp(r, 255, gloss); g = lerp(g, 235, gloss); b = lerp(b, 225, gloss);
      // small sharp sparkle
      const sx3 = (x - 585) / 46, sy3 = (y - 372) / 34;
      const sd3 = sx3 * sx3 + sy3 * sy3;
      const spark = Math.exp(-sd3 * 2.2) * 0.85;
      r = lerp(r, 255, spark); g = lerp(g, 250, spark); b = lerp(b, 245, spark);
    }

    // calyx leaves (drawn over the top of the fruit)
    const lf = leafAt(x, y);
    if (lf) {
      const { u } = lf;
      // green: bright at base, darker toward tip; vein lighter
      let gr = lerp(96, 34, u);
      let gg = lerp(158, 92, u);
      let gb = lerp(58, 30, u);
      // centre vein
      const bx = CX, by = 300;
      const ca = Math.cos(lf.leaf.ang), sa = Math.sin(lf.leaf.ang);
      const perp = (x - bx) * ca - (y - by) * sa;
      if (Math.abs(perp) < 2.2) { gr = 150; gg = 205; gb = 90; }
      // soft shading: darker at leaf edges
      const w = lf.leaf.wid * Math.sin(Math.PI * Math.pow(u, 0.75)) * (1 - u * 0.25);
      const ef = Math.abs(perp) / Math.max(w, 1);
      const ed = Math.pow(ef, 3) * 0.35;
      r = gr * (1 - ed); g = gg * (1 - ed); b = gb * (1 - ed);
    }

    // stem
    {
      const sdx = (x - CX) / 16, sdy = (y - 218) / 62;
      if (sdx * sdx + sdy * sdy < 1 && y < 292) {
        r = 74; g = 96; b = 44;
      }
    }

    // fine deterministic grain
    const n = (hash2(x, y) - 0.5) * 2;
    img[i] = clamp(Math.round(r + n), 0, 255);
    img[i + 1] = clamp(Math.round(g + n), 0, 255);
    img[i + 2] = clamp(Math.round(b + n), 0, 255);
  }
}

// ---------- PNG encode (deterministic) ----------
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

const raw = Buffer.alloc(H * (1 + W * 3));
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 3)] = 0; // filter: none
  raw.set(img.subarray(y * W * 3, (y + 1) * W * 3), y * (1 + W * 3) + 1);
}
const idat = zlib.deflateSync(raw, { level: 9 });

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // color type RGB
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.mkdirSync('/output', { recursive: true });
fs.writeFileSync(OUT, png);
console.log(`wrote ${OUT} (${png.length} bytes)`);
