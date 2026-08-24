// Renders the fallback Open Graph image (1200x630) without any image library.
// Discord rejects SVG for og:image, so this writes a real PNG: dark background,
// a soft blurple glow, and a play button in the middle.
//
// Usage: node scripts/banner.mjs public/banner.png
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

const WIDTH = 1200;
const HEIGHT = 630;

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(typed) >>> 0);
  return Buffer.concat([length, typed, crc]);
}

function mix(a, b, t) {
  return Math.round(a + (b - a) * Math.min(1, Math.max(0, t)));
}

function pixel(x, y) {
  const dx = x - WIDTH / 2;
  const dy = y - HEIGHT / 2;
  const dist = Math.hypot(dx, dy);

  // Background: #1e1f22 with a blurple glow that fades out by ~420px.
  const glow = Math.max(0, 1 - dist / 420) ** 2 * 0.35;
  let r = mix(0x1e, 0x58, glow);
  let g = mix(0x1f, 0x65, glow);
  let b = mix(0x22, 0xf2, glow);

  // Play button: blurple disc, white triangle, 1px anti-aliased edges.
  const radius = 96;
  const edge = dist - radius;
  if (edge < 1) {
    const cover = edge < 0 ? 1 : 1 - edge;
    r = mix(r, 0x58, cover);
    g = mix(g, 0x65, cover);
    b = mix(b, 0xf2, cover);
  }
  const tx = dx + 8;
  if (tx >= -36 && tx <= 44) {
    const limit = 44 * (1 - (tx + 36) / 80);
    const inside = Math.abs(dy) - limit;
    if (inside < 1) {
      const cover = inside < 0 ? 1 : 1 - inside;
      r = mix(r, 0xff, cover);
      g = mix(g, 0xff, cover);
      b = mix(b, 0xff, cover);
    }
  }
  return [r, g, b];
}

export function renderBanner() {
  const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
  let offset = 0;
  for (let y = 0; y < HEIGHT; y++) {
    raw[offset++] = 0; // filter: none
    for (let x = 0; x < WIDTH; x++) {
      const [r, g, b] = pixel(x, y);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const out = process.argv[2];
if (!out) {
  console.error("usage: node scripts/banner.mjs <output.png>");
  process.exit(1);
}
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, renderBanner());
console.log(`wrote ${out}`);
