// Draws the app icon (orange rounded square with a white four-point spark) as PNGs, no image libraries needed.
import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Coverage (0..1) of the icon shapes at unit coordinates u,v in [0,1]. Returns [bgCoverage, sparkCoverage]. */
function shapes(u, v) {
  const r = 0.22; // corner radius
  const dx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0);
  const dy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
  const inBg = dx * dx + dy * dy <= r * r;
  // four-point spark: |x|^p + |y|^p <= s^p with p < 1 gives concave star arms
  const x = Math.abs(u - 0.5) / 0.32;
  const y = Math.abs(v - 0.5) / 0.32;
  const inSpark = Math.pow(x, 0.55) + Math.pow(y, 0.55) <= 1;
  return [inBg ? 1 : 0, inSpark ? 1 : 0];
}

export function makeIcons(sizes) {
  const out = {};
  const ss = 4; // supersampling for smooth edges
  for (const size of sizes) {
    out[size] = png(size, (px, py) => {
      let bg = 0; let spark = 0;
      for (let i = 0; i < ss; i++) for (let j = 0; j < ss; j++) {
        const [b, s] = shapes((px + (i + 0.5) / ss) / size, (py + (j + 0.5) / ss) / size);
        bg += b; spark += s * b;
      }
      bg /= ss * ss; spark /= ss * ss;
      const orange = [232, 89, 12];
      const mix = (c) => Math.round(c * (1 - spark / Math.max(bg, 1e-6)) + 255 * (spark / Math.max(bg, 1e-6)));
      return bg ? [mix(orange[0]), mix(orange[1]), mix(orange[2]), Math.round(bg * 255)] : [0, 0, 0, 0];
    });
  }
  return out;
}
