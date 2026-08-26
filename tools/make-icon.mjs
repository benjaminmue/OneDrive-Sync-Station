#!/usr/bin/env node
// Renders the application icon to PNG.
//
// Community Applications needs a raster icon, and the mark is simple enough
// that rasterising it here beats depending on an image toolchain: no cairo, no
// ImageMagick, no headless browser, and the result is reproducible on any
// machine that can run Node.
//
// The geometry lives in ICON below and is shared with the SVG, so the vector
// and the raster version cannot drift apart. Edges are antialiased by sampling
// each pixel SUPERSAMPLE times per axis and averaging.
//
// Usage: node tools/make-icon.mjs [size] [outfile]

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

/** Design canvas the geometry is expressed in. Output is scaled from this. */
const CANVAS = 256;

/** Samples per axis and pixel. 4 means 16 samples, which is plenty at this size. */
const SUPERSAMPLE = 4;

/**
 * The mark: a dark rounded tile with a faceted cloud in the OneDrive blues.
 *
 * The cloud is built from three overlapping primitives rather than outlines,
 * which is what lets a few dozen lines of code draw it. Facets come from
 * painting them in a fixed order, brightest last, plus a darker band along the
 * bottom of the base to give the shape depth.
 */
const ICON = {
  background: { color: "#10233a", radius: 52 },
  // Painted in order; later entries win where they overlap.
  //
  // The base sits low and ends inside the lobes, so the silhouette is drawn by
  // the lobes rather than by a slab poking out at both sides. It carries the
  // darkest blue as one flat facet: a second tone inside it would show up as a
  // hard horizontal seam across the cloud.
  base: { x0: 62, x1: 202, y: 156, radius: 23, color: "#0364b8" },
  lobes: [
    { cx: 100, cy: 130, r: 33, color: "#0f78d4" },
    { cx: 151, cy: 113, r: 45, color: "#28a8ea" },
  ],
  // A slim highlight along the upper left of the big lobe, so the two lobes
  // stay distinguishable when the icon is scaled down to a sidebar entry.
  highlight: { cx: 151, cy: 113, r: 45, inset: 9, color: "#5cc0f2" },
};

/**
 * Parse a #rrggbb colour into its components.
 * @param {string} hex Colour in #rrggbb form.
 * @returns {[number, number, number]} Red, green and blue, 0 to 255.
 */
function rgb(hex) {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * Whether a point lies inside the rounded tile.
 * @param {number} x Horizontal position on the design canvas.
 * @param {number} y Vertical position on the design canvas.
 * @returns {boolean} True when inside.
 */
function inTile(x, y) {
  const r = ICON.background.radius;
  const cx = Math.min(Math.max(x, r), CANVAS - r);
  const cy = Math.min(Math.max(y, r), CANVAS - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/**
 * Whether a point lies inside a circle.
 * @param {number} x Horizontal position.
 * @param {number} y Vertical position.
 * @param {{cx: number, cy: number, r: number}} circle The circle.
 * @returns {boolean} True when inside.
 */
function inCircle(x, y, circle) {
  return (x - circle.cx) ** 2 + (y - circle.cy) ** 2 <= circle.r * circle.r;
}

/**
 * Whether a point lies inside the cloud base, a horizontal capsule.
 * @param {number} x Horizontal position.
 * @param {number} y Vertical position.
 * @returns {boolean} True when inside.
 */
function inBase(x, y) {
  const { x0, x1, y: cy, radius } = ICON.base;
  const clampedX = Math.min(Math.max(x, x0 + radius), x1 - radius);
  return (x - clampedX) ** 2 + (y - cy) ** 2 <= radius * radius;
}

/**
 * Colour of one sample point, or null where the icon is transparent.
 * @param {number} x Horizontal position on the design canvas.
 * @param {number} y Vertical position on the design canvas.
 * @returns {[number, number, number]|null} Colour, or null outside the tile.
 */
function sample(x, y) {
  if (!inTile(x, y)) return null;

  let colour = ICON.background.color;
  if (inBase(x, y)) colour = ICON.base.color;
  for (const lobe of ICON.lobes) {
    if (inCircle(x, y, lobe)) colour = lobe.color;
  }

  const { cx, cy, r, inset } = ICON.highlight;
  const outer = inCircle(x, y, { cx, cy, r });
  const inner = inCircle(x, y, { cx, cy, r: r - inset });
  // Upper left arc only: a full ring would read as an outline rather than light.
  if (outer && !inner && x < cx && y < cy) colour = ICON.highlight.color;

  return rgb(colour);
}

/**
 * Render the icon into a raw RGBA buffer.
 * @param {number} size Output edge length in pixels.
 * @returns {Buffer} Raw RGBA pixels, row major.
 */
function render(size) {
  const scale = CANVAS / size;
  const step = scale / SUPERSAMPLE;
  const pixels = Buffer.alloc(size * size * 4);

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = (px * SUPERSAMPLE + sx + 0.5) * step;
          const y = (py * SUPERSAMPLE + sy + 0.5) * step;
          const hit = sample(x, y);
          if (!hit) continue;
          r += hit[0];
          g += hit[1];
          b += hit[2];
          covered += 1;
        }
      }
      const offset = (py * size + px) * 4;
      const total = SUPERSAMPLE * SUPERSAMPLE;
      if (covered === 0) continue; // transparent corner
      // Averaging over covered samples only keeps edge pixels at full colour
      // and puts the softness into the alpha channel, which is what avoids a
      // dark fringe when the icon sits on a light background.
      pixels[offset] = Math.round(r / covered);
      pixels[offset + 1] = Math.round(g / covered);
      pixels[offset + 2] = Math.round(b / covered);
      pixels[offset + 3] = Math.round((covered / total) * 255);
    }
  }
  return pixels;
}

/** CRC table for PNG chunk checksums, built once. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/**
 * CRC32 over a buffer, as PNG chunks require.
 * @param {Buffer} buf Data to checksum.
 * @returns {number} The checksum.
 */
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Build one PNG chunk.
 * @param {string} type Four character chunk type.
 * @param {Buffer} data Chunk payload.
 * @returns {Buffer} The complete chunk.
 */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * Encode raw RGBA pixels as a PNG file.
 * @param {Buffer} pixels Raw RGBA pixels, row major.
 * @param {number} size Edge length in pixels.
 * @returns {Buffer} The PNG file contents.
 */
function encodePng(pixels, size) {
  const stride = size * 4;
  // Each scanline is prefixed with its filter type; 0 means "none", which is
  // all this needs since zlib does the compression.
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const size = Number(process.argv[2] || 256);
const outFile = process.argv[3] || "unraid/onedrive-sync-station.png";
const png = encodePng(render(size), size);
writeFileSync(outFile, png);
console.log(`wrote ${outFile} (${size}x${size}, ${png.length} bytes)`);
