// Reproducible generator for the bundled Apple Wallet PNG assets.
//
// Run from anywhere with Node (no dependencies — pure zlib + Buffer):
//
//   node artifacts/resupply-api/src/lib/apple-wallet/gen-assets.mjs
//
// It prints the two base64 PNG payloads (icon + logo) and their byte
// sizes. Paste the strings into `assets.ts`. The assets are a gold
// "PennPaps" P-monogram rendered with 4×4 supersampled anti-aliasing:
//   - icon.png  — 87×87, gold P on the pass navy (rgb 15,29,58),
//                 a self-contained "app icon" (iOS rounds the corners).
//   - logo.png  — 120×120, gold P on a transparent background, the
//                 mark that sits beside the "PennPaps" logoText on the
//                 pass face.
//
// Brand colors mirror the pass styling in `pkpass.ts`
// (backgroundColor rgb 15,29,58; labelColor / accent rgb 204,184,121).

import { deflateSync } from "node:zlib";

const NAVY = [15, 29, 58];
const GOLD = [204, 184, 121];

// CRC-32 (PNG polynomial) — small table-driven implementation.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// Encode an RGBA pixel buffer (length = w*h*4) as a color-type-6 PNG.
function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Prepend a filter byte (0 = none) to each scanline.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Coverage of the "P" monogram at a continuous point, in [0,1] units
// of the canvas. Returns true if the point is inside the glyph ink.
function inGlyph(x, y) {
  const pad = 0.18;
  const t = 0.16; // stroke thickness
  const gy0 = pad;
  const gy1 = 1 - pad;
  const sx0 = pad;
  const sx1 = pad + t;
  const rOuter = 0.3;
  const rInner = rOuter - t;
  const cx = sx1;
  const cy = gy0 + rOuter;

  // Vertical stem.
  if (x >= sx0 && x <= sx1 && y >= gy0 && y <= gy1) return true;

  // Bowl: right half of an annulus centered on the stem's right edge.
  if (x >= cx) {
    const dx = x - cx;
    const dy = y - cy;
    const r = Math.sqrt(dx * dx + dy * dy);
    if (r >= rInner && r <= rOuter) return true;
  }
  return false;
}

// Render the monogram with 4×4 supersampling. `bg` may be null for a
// transparent background.
function renderMonogram(size, bg) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (px + (sx + 0.5) / SS) / size;
          const v = (py + (sy + 0.5) / SS) / size;
          if (inGlyph(u, v)) hits++;
        }
      }
      const cov = hits / (SS * SS); // ink coverage 0..1
      const i = (py * size + px) * 4;

      if (bg) {
        // Opaque background; blend gold ink over it.
        rgba[i] = Math.round(bg[0] * (1 - cov) + GOLD[0] * cov);
        rgba[i + 1] = Math.round(bg[1] * (1 - cov) + GOLD[1] * cov);
        rgba[i + 2] = Math.round(bg[2] * (1 - cov) + GOLD[2] * cov);
        rgba[i + 3] = 255;
      } else {
        // Transparent background; gold ink with coverage as alpha.
        rgba[i] = GOLD[0];
        rgba[i + 1] = GOLD[1];
        rgba[i + 2] = GOLD[2];
        rgba[i + 3] = Math.round(255 * cov);
      }
    }
  }
  return rgba;
}

const iconPng = encodePng(87, 87, renderMonogram(87, NAVY));
const logoPng = encodePng(120, 120, renderMonogram(120, null));

const iconB64 = iconPng.toString("base64");
const logoB64 = logoPng.toString("base64");

console.log(`icon.png  ${iconPng.length} bytes (87×87, gold P on navy)`);
console.log(iconB64);
console.log();
console.log(`logo.png  ${logoPng.length} bytes (120×120, gold P, transparent)`);
console.log(logoB64);
