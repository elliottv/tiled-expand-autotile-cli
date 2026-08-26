'use strict';

/**
 * Acceptance tests for the zero-dependency PNG writer / expanded-image
 * renderer (issue #5).
 *
 * Run with: node --test tests/png-writer.test.js   (Node >= 18, no deps)
 *
 * Covers:
 *  - encodePng -> decodePng round-trips (RGBA incl. transparency, 1x1,
 *    larger images);
 *  - PNG structure sanity (signature, IHDR dims/bit depth/colour type, IEND)
 *    plus a per-chunk CRC-32 check;
 *  - multiple IDAT chunks for large images;
 *  - renderExpandedImage against engine.expand for a real A2 layout
 *    (32x24 subtiles, 16px subtiles -> 1792x896) with expected colours at
 *    sampled positions;
 *  - empty (null) cells render fully transparent;
 *  - argument validation for both exported functions.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { encodePng, renderExpandedImage } = require('../png-writer.js');
const { decodePng } = require('../png-decode.js');
const { LAYOUTS, expand } = require('../engine.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 8-byte PNG file signature. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** CRC-32 table (mirrors png-writer.js / png-decode.js). */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Parse a PNG buffer into top-level chunks, validating each CRC.
 *
 * @returns {Array<{type: string, data: Buffer}>}
 */
function parseChunks(png) {
  const chunks = [];
  let offset = 8; // skip signature
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = png.readUInt32BE(offset + 8 + length);
    const actualCrc = crc32(png.subarray(offset + 4, offset + 8 + length));
    assert.equal(actualCrc, expectedCrc, `CRC mismatch in "${type}" chunk`);
    chunks.push({ type, data });
    offset += 12 + length;
  }
  return chunks;
}

/**
 * Deterministic per-subtile colour so a source tileset can be built with
 * unique-colour subtiles and the same formula reused in assertions.
 *
 * @param {number} sx - subtile column in the source tileset.
 * @param {number} sy - subtile row in the source tileset.
 * @returns {number[]} [r, g, b, a]
 */
function subtileColour(sx, sy) {
  return [(sx * 37 + sy * 11) & 0xff, (sx * 53 + sy * 17) & 0xff, (sx * 71 + sy * 23) & 0xff, 255];
}

/**
 * Build a synthetic source tileset image where every subtile is a solid,
 * unique colour.
 *
 * @param {number} tilesetWidth - tileset width in subtiles.
 * @param {number} tilesetHeight - tileset height in subtiles.
 * @param {number} subtileWidth - subtile width in pixels.
 * @param {number} subtileHeight - subtile height in pixels.
 * @returns {{ width: number, height: number, pixels: Uint8Array }}
 */
function makeTilesetImage(tilesetWidth, tilesetHeight, subtileWidth, subtileHeight) {
  const width = tilesetWidth * subtileWidth;
  const height = tilesetHeight * subtileHeight;
  const pixels = new Uint8Array(width * height * 4);

  for (let sy = 0; sy < tilesetHeight; sy++) {
    for (let sx = 0; sx < tilesetWidth; sx++) {
      const [r, g, b, a] = subtileColour(sx, sy);
      for (let dy = 0; dy < subtileHeight; dy++) {
        for (let dx = 0; dx < subtileWidth; dx++) {
          const o = ((sy * subtileHeight + dy) * width + (sx * subtileWidth + dx)) * 4;
          pixels[o] = r;
          pixels[o + 1] = g;
          pixels[o + 2] = b;
          pixels[o + 3] = a;
        }
      }
    }
  }
  return { width, height, pixels };
}

/** Read one RGBA pixel as [r, g, b, a] from a raw pixel buffer. */
function pixelAt(pixels, width, x, y) {
  const o = (y * width + x) * 4;
  return [pixels[o], pixels[o + 1], pixels[o + 2], pixels[o + 3]];
}

/**
 * Deterministic pseudo-random RGBA image of the given size (varied alpha).
 *
 * Uses the HIGH byte of the LCG state per sample, which is essentially
 * incompressible by zlib; this keeps the multiple-IDAT-chunks test honest
 * (a 200x200 image deflates to > 64 KiB and therefore spans > 1 chunk).
 */
function makeRandomRgba(width, height, seed) {
  const pixels = new Uint8Array(width * height * 4);
  let state = seed >>> 0;
  for (let i = 0; i < pixels.length; i++) {
    // Simple LCG (Numerical Recipes constants); high byte is well-mixed.
    state = (state * 1664525 + 1013904223) >>> 0;
    pixels[i] = (state >>> 24) & 0xff;
  }
  return { width, height, pixels };
}

// ---------------------------------------------------------------------------
// encodePng: round-trip
// ---------------------------------------------------------------------------

test('encodePng round-trips RGBA pixels through decodePng (varied alpha)', () => {
  const img = makeRandomRgba(17, 9, 0xc0ffee);
  const { pixels } = decodePng(encodePng(img));

  assert.equal(pixels.length, img.pixels.length);
  assert.deepEqual(Array.from(pixels), Array.from(img.pixels));
});

test('encodePng round-trips a fully transparent 1x1 image', () => {
  const img = { width: 1, height: 1, pixels: new Uint8Array([0, 0, 0, 0]) };
  const decoded = decodePng(encodePng(img));

  assert.equal(decoded.width, 1);
  assert.equal(decoded.height, 1);
  assert.deepEqual(Array.from(decoded.pixels), [0, 0, 0, 0]);
});

test('encodePng round-trips an image with explicit transparent regions', () => {
  // A 4x3 image: row 0 solid, row 1 half-alpha, row 2 fully transparent.
  const width = 4;
  const height = 3;
  const pixels = new Uint8Array(width * height * 4);
  for (let x = 0; x < width; x++) {
    const o = x * 4;
    pixels[o] = 255;
    pixels[o + 1] = 0;
    pixels[o + 2] = 0;
    pixels[o + 3] = 255;
  }
  for (let x = 0; x < width; x++) {
    const o = (width + x) * 4;
    pixels[o] = 0;
    pixels[o + 1] = 255;
    pixels[o + 2] = 0;
    pixels[o + 3] = 128;
  }
  // Row 2 left as all-zero (fully transparent).

  const decoded = decodePng(encodePng({ width, height, pixels }));
  assert.deepEqual(Array.from(decoded.pixels), Array.from(pixels));
});

// ---------------------------------------------------------------------------
// encodePng: structure sanity
// ---------------------------------------------------------------------------

test('encodePng emits valid PNG structure (signature, IHDR, IEND, chunk CRCs)', () => {
  const img = { width: 7, height: 5, pixels: makeRandomRgba(7, 5, 1).pixels };
  const png = encodePng(img);

  // Signature.
  assert.deepEqual(Array.from(png.subarray(0, 8)), PNG_SIGNATURE);

  const chunks = parseChunks(png);

  // IHDR must be first.
  assert.equal(chunks[0].type, 'IHDR');
  const ihdr = chunks[0].data;
  assert.equal(ihdr.length, 13);
  assert.equal(ihdr.readUInt32BE(0), img.width);
  assert.equal(ihdr.readUInt32BE(4), img.height);
  assert.equal(ihdr[8], 8, 'bit depth must be 8');
  assert.equal(ihdr[9], 6, 'colour type must be 6 (RGBA)');
  assert.equal(ihdr[10], 0, 'compression method must be 0');
  assert.equal(ihdr[11], 0, 'filter method must be 0');
  assert.equal(ihdr[12], 0, 'interlace method must be 0');

  // At least one IDAT.
  const idats = chunks.filter((c) => c.type === 'IDAT');
  assert.ok(idats.length >= 1, 'expected at least one IDAT chunk');

  // IEND must be last with empty data.
  assert.equal(chunks[chunks.length - 1].type, 'IEND');
  assert.equal(chunks[chunks.length - 1].data.length, 0);
});

test('encodePng splits large IDAT data into multiple chunks', () => {
  // ~160 KB of incompressible RGBA data: deflate keeps it well above 64 KiB,
  // so the encoder must split the IDAT stream into several chunks.
  const img = makeRandomRgba(200, 200, 0x12345678);
  const png = encodePng(img);
  const chunks = parseChunks(png);
  const idats = chunks.filter((c) => c.type === 'IDAT');

  assert.ok(idats.length > 1, `expected multiple IDAT chunks, got ${idats.length}`);

  // The concatenated IDAT payload must still decode to the original pixels.
  const decoded = decodePng(png);
  assert.deepEqual(Array.from(decoded.pixels), Array.from(img.pixels));
});

test('encodePng validates its arguments', () => {
  assert.throws(() => encodePng({ width: 0, height: 1, pixels: new Uint8Array(4) }), /positive integer dimensions/);
  assert.throws(() => encodePng({ width: 1.5, height: 1, pixels: new Uint8Array(4) }), /positive integer dimensions/);
  assert.throws(() => encodePng({ width: 1, height: 1, pixels: null }), /pixels buffer/);
  // Wrong pixel buffer length.
  assert.throws(() => encodePng({ width: 2, height: 2, pixels: new Uint8Array(10) }), /must equal width\*height\*4/);
});

// ---------------------------------------------------------------------------
// renderExpandedImage
// ---------------------------------------------------------------------------

test('renderExpandedImage: A2 layout (32x24 subtiles, 16px) renders 1792x896 with correct colours', () => {
  const subtileWidth = 16;
  const subtileHeight = 16;
  const tilesetWidth = 32;
  const tilesetHeight = 24;

  const sourceImage = makeTilesetImage(tilesetWidth, tilesetHeight, subtileWidth, subtileHeight);
  const grid = expand(LAYOUTS.A2, tilesetWidth, tilesetHeight);

  // Sanity-check the fixture: the first A2 cell references subtile (0, 2).
  assert.equal(grid[0][0], 0 + (0 + 2) * tilesetWidth);

  const out = renderExpandedImage(sourceImage, grid, subtileWidth, subtileHeight, tilesetWidth);

  // A2 expanded grid is 112x56 subtiles -> 1792x896 px at 16px subtiles.
  assert.equal(grid[0].length, 112);
  assert.equal(grid.length, 56);
  assert.equal(out.width, 1792);
  assert.equal(out.height, 896);
  assert.equal(out.pixels.length, 1792 * 896 * 4);

  // Sample a spread of cells whose subtile is copied from a known source region.
  const samples = [
    [0, 0],
    [7, 0],
    [40, 20],
    [60, 28],
    [111, 55],
    [100, 7],
  ];
  let checked = 0;
  for (const [cellX, cellY] of samples) {
    const idx = grid[cellY][cellX];
    if (idx === null) continue; // A2 contains a couple of empty T combinations
    const sx = idx % tilesetWidth;
    const sy = Math.floor(idx / tilesetWidth);
    const expected = subtileColour(sx, sy);

    for (const [dx, dy] of [
      [0, 0], // top-left of the subtile
      [subtileWidth - 1, subtileHeight - 1], // bottom-right
      [5, 10], // somewhere in the middle
    ]) {
      const x = cellX * subtileWidth + dx;
      const y = cellY * subtileHeight + dy;
      assert.deepEqual(
        pixelAt(out.pixels, out.width, x, y),
        expected,
        `cell (${cellX},${cellY}) idx ${idx} subtile (${sx},${sy}) pixel (${x},${y})`
      );
    }
    checked++;
  }
  assert.ok(checked > 0, 'expected at least one sampled cell to be non-empty');
});

test('renderExpandedImage: empty (null) cells render fully transparent', () => {
  const subtileWidth = 8;
  const subtileHeight = 8;
  const tilesetWidth = 4;

  const sourceImage = makeTilesetImage(tilesetWidth, 4, subtileWidth, subtileHeight);
  // 3x3 grid: centre and two edges are empty; the rest reference subtiles.
  const grid = [
    [0, null, 3],
    [null, 5, null],
    [9, null, 2],
  ];

  const out = renderExpandedImage(sourceImage, grid, subtileWidth, subtileHeight, tilesetWidth);
  assert.equal(out.width, 3 * subtileWidth);
  assert.equal(out.height, 3 * subtileHeight);

  // Every pixel of a null cell must be fully transparent.
  for (const [cellX, cellY] of [
    [1, 0],
    [0, 1],
    [2, 1],
    [1, 2],
  ]) {
    for (let dy = 0; dy < subtileHeight; dy++) {
      for (let dx = 0; dx < subtileWidth; dx++) {
        assert.deepEqual(
          pixelAt(out.pixels, out.width, cellX * subtileWidth + dx, cellY * subtileHeight + dy),
          [0, 0, 0, 0],
          `null cell (${cellX},${cellY}) pixel (${dx},${dy})`
        );
      }
    }
  }

  // Non-null cells carry their source subtile colour.
  const cases = [
    [0, 0, 0],
    [2, 0, 3],
    [1, 1, 5],
    [0, 2, 9],
    [2, 2, 2],
  ];
  for (const [cellX, cellY, idx] of cases) {
    const sx = idx % tilesetWidth;
    const sy = Math.floor(idx / tilesetWidth);
    assert.deepEqual(
      pixelAt(out.pixels, out.width, cellX * subtileWidth, cellY * subtileHeight),
      subtileColour(sx, sy),
      `filled cell (${cellX},${cellY})`
    );
  }
});

test('renderExpandedImage: arbitrary grid dimensions and full-image round-trip', () => {
  const subtileWidth = 4;
  const subtileHeight = 6;
  const tilesetWidth = 5;

  const sourceImage = makeTilesetImage(tilesetWidth, 5, subtileWidth, subtileHeight);
  // 4x2 grid (rows x cols) exercising a non-square subtile.
  const grid = [
    [1, 2, 3, null],
    [null, 12, 20, 24],
  ];

  const out = renderExpandedImage(sourceImage, grid, subtileWidth, subtileHeight, tilesetWidth);
  assert.equal(out.width, 4 * subtileWidth);
  assert.equal(out.height, 2 * subtileHeight);

  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const cellX = Math.floor(x / subtileWidth);
      const cellY = Math.floor(y / subtileHeight);
      const dx = x % subtileWidth;
      const dy = y % subtileHeight;
      const idx = grid[cellY][cellX];
      const expected =
        idx === null ? [0, 0, 0, 0] : subtileColour(idx % tilesetWidth, Math.floor(idx / tilesetWidth));
      assert.deepEqual(pixelAt(out.pixels, out.width, x, y), expected, `pixel (${x},${y})`);
    }
  }

  // The rendered image must itself survive a PNG round-trip exactly.
  const decoded = decodePng(encodePng(out));
  assert.deepEqual(Array.from(decoded.pixels), Array.from(out.pixels));
});

test('renderExpandedImage validates its arguments', () => {
  const sourceImage = makeTilesetImage(4, 4, 8, 8);
  const grid = [[0, null], [1, 2]];

  assert.throws(() => renderExpandedImage(null, grid, 8, 8, 4), /sourceImage with positive integer width and height/);
  assert.throws(() => renderExpandedImage({ ...sourceImage, pixels: [1, 2, 3] }, grid, 8, 8, 4), /pixels must be a Uint8Array/);
  assert.throws(() => renderExpandedImage(sourceImage, [], 8, 8, 4), /non-empty 2D grid array/);
  assert.throws(() => renderExpandedImage(sourceImage, grid, 0, 8, 4), /subtileWidth must be a positive integer/);
  assert.throws(() => renderExpandedImage(sourceImage, grid, 8, 8, 0), /tilesetWidth must be a positive integer/);
  // A negative / non-integer subtile index must be rejected.
  assert.throws(() => renderExpandedImage(sourceImage, [[-1]], 8, 8, 4), /non-negative integer subtile index/);
  // A ragged grid row must be rejected.
  assert.throws(() => renderExpandedImage(sourceImage, [[0, 1], [2]], 8, 8, 4), /grid row 1 must be an array/);
});
