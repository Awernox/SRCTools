/**
 * Minimal dependency-free PNG codec + resampler.
 *
 * Only what the icon pipeline needs: decode non-interlaced 8-bit PNGs of any
 * colour type, encode 8-bit RGBA, and box-filter resample. Kept dependency-free
 * so `npm install` never has to pull a native image toolchain just to build the
 * app icon.
 */
import { inflateSync, deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** @returns {{width:number,height:number,rgba:Buffer}} */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let bitDepth = 0;
  let palette = null;
  let trns = null;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG unsupported');
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }

  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let rp = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const row = raw.subarray(rp, rp + stride);
    rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = row[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      cur[x] = v & 0xff;
    }
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    let r;
    let g;
    let b;
    let a = 255;
    if (colorType === 6) {
      r = out[i * 4];
      g = out[i * 4 + 1];
      b = out[i * 4 + 2];
      a = out[i * 4 + 3];
    } else if (colorType === 2) {
      r = out[i * 3];
      g = out[i * 3 + 1];
      b = out[i * 3 + 2];
    } else if (colorType === 0) {
      r = g = b = out[i];
    } else if (colorType === 4) {
      r = g = b = out[i * 2];
      a = out[i * 2 + 1];
    } else {
      const idx = out[i];
      r = palette[idx * 3];
      g = palette[idx * 3 + 1];
      b = palette[idx * 3 + 2];
      if (trns && idx < trns.length) a = trns[idx];
    }
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = a;
  }
  return { width, height, rgba };
}

export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunk = (type, data) => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Box-filter resample on premultiplied alpha (no dark fringes on edges). */
export function resample(src, sw, sh, dw, dh) {
  const dst = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor((y * sh) / dh);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor((x * sw) / dw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / dw));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * sw + xx) * 4;
          const al = src[i + 3];
          r += src[i] * al;
          g += src[i + 1] * al;
          b += src[i + 2] * al;
          a += al;
          n++;
        }
      }
      const o = (y * dw + x) * 4;
      if (a > 0) {
        dst[o] = Math.round(r / a);
        dst[o + 1] = Math.round(g / a);
        dst[o + 2] = Math.round(b / a);
      }
      dst[o + 3] = Math.round(a / n);
    }
  }
  return dst;
}

/**
 * Turns the source artwork into a white-on-transparent mark, trimmed to its
 * bounding box. The source is a white mark on opaque black, so luminance is
 * exactly the coverage mask we want for alpha.
 */
export function extractMark({ width, height, rgba }) {
  const keyed = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const lum = Math.round(
      0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2],
    );
    keyed[i * 4] = 255;
    keyed[i * 4 + 1] = 255;
    keyed[i * 4 + 2] = 255;
    keyed[i * 4 + 3] = Math.round((lum * rgba[i * 4 + 3]) / 255);
  }

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (keyed[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error('source image is blank after keying');

  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const cropped = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    keyed.copy(
      cropped,
      y * cw * 4,
      ((y + minY) * width + minX) * 4,
      ((y + minY) * width + maxX + 1) * 4,
    );
  }
  return { width: cw, height: ch, rgba: cropped };
}

/** Centres `mark` on a square canvas at `coverage` of the canvas extent. */
export function centreOnSquare(mark, size, coverage, background) {
  const target = Math.round(size * coverage);
  const scale = Math.min(target / mark.width, target / mark.height);
  const rw = Math.max(1, Math.round(mark.width * scale));
  const rh = Math.max(1, Math.round(mark.height * scale));
  const scaled = resample(mark.rgba, mark.width, mark.height, rw, rh);

  const canvas = Buffer.alloc(size * size * 4);
  if (background) background(canvas, size);

  const ox = Math.floor((size - rw) / 2);
  const oy = Math.floor((size - rh) / 2);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const s = (y * rw + x) * 4;
      const d = ((y + oy) * size + x + ox) * 4;
      const sa = scaled[s + 3] / 255;
      if (sa <= 0) continue;
      const da = canvas[d + 3] / 255;
      const oa = sa + da * (1 - sa);
      for (let c = 0; c < 3; c++) {
        canvas[d + c] = Math.round((scaled[s + c] * sa + canvas[d + c] * da * (1 - sa)) / oa);
      }
      canvas[d + 3] = Math.round(oa * 255);
    }
  }
  return { size, rgba: canvas, markWidth: rw, markHeight: rh };
}

/** Anti-aliased rounded-rectangle plate painter for app-icon backgrounds. */
export function roundedPlate(hex, radiusRatio = 0.2237) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (canvas, size) => {
    const radius = size * radiusRatio;
    const ss = 4; // supersample factor for smooth corners
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let hits = 0;
        for (let sy = 0; sy < ss; sy++) {
          for (let sx = 0; sx < ss; sx++) {
            const px = x + (sx + 0.5) / ss;
            const py = y + (sy + 0.5) / ss;
            const dx = Math.max(radius - px, px - (size - radius), 0);
            const dy = Math.max(radius - py, py - (size - radius), 0);
            if (dx * dx + dy * dy <= radius * radius) hits++;
          }
        }
        if (!hits) continue;
        const o = (y * size + x) * 4;
        canvas[o] = r;
        canvas[o + 1] = g;
        canvas[o + 2] = b;
        canvas[o + 3] = Math.round((hits / (ss * ss)) * 255);
      }
    }
  };
}
