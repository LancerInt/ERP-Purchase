/**
 * Generates the PWA / home-screen icons from the Lancer "L" brand mark.
 * Pure Node (zlib) — no image deps. Re-run after changing the brand:
 *   node scripts/generate-pwa-icons.cjs
 *
 * To swap in a real logo later, replace the drawIcon() body (or just
 * overwrite the PNGs in /public with your exported sizes).
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// --- minimal PNG encoder (RGBA, 8-bit) ---------------------------------
const crcTable = (() => {
  const t = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
};
function encodePNG(N, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const stride = N * 4;
  const raw = Buffer.alloc((stride + 1) * N);
  for (let y = 0; y < N; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// --- the "L" icon ------------------------------------------------------
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const A = hex('#0b8cff'); // primary-500
const B = hex('#0052a3'); // primary-700

function drawIcon(N) {
  const rgba = Buffer.alloc(N * N * 4);
  const t = Math.round(0.13 * N);              // stroke thickness
  const vx0 = Math.round(0.37 * N);            // L left edge
  const vy0 = Math.round(0.27 * N);            // L top
  const vy1 = Math.round(0.73 * N);            // L bottom
  const hx1 = Math.round(0.66 * N);            // foot right edge
  const hy0 = vy1 - t;                         // foot top
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const g = (x + y) / (2 * (N - 1));       // diagonal gradient 0..1
      const i = (y * N + x) * 4;
      const inV = x >= vx0 && x < vx0 + t && y >= vy0 && y < vy1;
      const inH = x >= vx0 && x < hx1 && y >= hy0 && y < vy1;
      if (inV || inH) {
        rgba[i] = 255; rgba[i + 1] = 255; rgba[i + 2] = 255; rgba[i + 3] = 255;
      } else {
        rgba[i] = Math.round(A[0] + (B[0] - A[0]) * g);
        rgba[i + 1] = Math.round(A[1] + (B[1] - A[1]) * g);
        rgba[i + 2] = Math.round(A[2] + (B[2] - A[2]) * g);
        rgba[i + 3] = 255;
      }
    }
  }
  return encodePNG(N, rgba);
}

const out = path.join(__dirname, '..', 'public');
fs.writeFileSync(path.join(out, 'pwa-192.png'), drawIcon(192));
fs.writeFileSync(path.join(out, 'pwa-512.png'), drawIcon(512));
fs.writeFileSync(path.join(out, 'apple-touch-icon.png'), drawIcon(180));
console.log('Generated pwa-192.png, pwa-512.png, apple-touch-icon.png in /public');
