'use strict';

/**
 * Acceptance tests for the zero-dependency PNG decoder (issue #7).
 *
 * Run with: node --test tests/png-decode.test.js   (Node >= 18, no deps)
 *
 * Fixtures are generated in-test by a small PNG builder (node:zlib + CRC32)
 * covering every colour type, every scanline filter, tRNS transparency,
 * 16-bit downconversion and multiple IDAT chunks, plus corruption/truncation
 * and getPixel bounds behaviour.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const { decodePng, getPixel } = require('../png-decode.js');

// ---------------------------------------------------------------------------
// Tiny PNG builder (node:zlib + CRC32) - used to generate test fixtures
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

/**
 * Build a complete PNG file.
 *
 * @param {object} opts
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {number} [opts.bitDepth=8]
 * @param {number} [opts.colorType=6]
 * @param {Buffer} [opts.scanlines] raw filtered scanlines (one filter byte per row)
 * @param {Buffer|number[]} [opts.palette] PLTE data
 * @param {Buffer|number[]} [opts.tRNS] tRNS data
 * @param {number} [opts.idatChunks=1] split the compressed IDAT stream this many ways
 * @param {number} [opts.interlace=0] interlace method byte for IHDR
 * @param {Buffer} [opts.idatData] override the (deflated) IDAT payload
 */
function makePng(opts) {
  const {
    width,
    height,
    bitDepth = 8,
    colorType = 6,
    scanlines = Buffer.from([0]),
    palette,
    tRNS,
    idatChunks = 1,
    interlace = 0,
    idatData,
  } = opts;

  const parts = [PNG_SIGNATURE];

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = interlace;
  parts.push(chunk('IHDR', ihdr));

  if (palette !== undefined) parts.push(chunk('PLTE', Buffer.from(palette)));
  if (tRNS !== undefined) parts.push(chunk('tRNS', Buffer.from(tRNS)));

  const compressed = idatData !== undefined ? Buffer.from(idatData) : zlib.deflateSync(scanlines);
  if (idatChunks <= 1) {
    parts.push(chunk('IDAT', compressed));
  } else {
    const size = Math.max(1, Math.ceil(compressed.length / idatChunks));
    for (let i = 0; i < compressed.length; i += size) {
      parts.push(chunk('IDAT', compressed.subarray(i, i + size)));
    }
  }

  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/** Channels per colour type (mirrors the decoder's understanding). */
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * Build unfiltered (filter 0) scanlines from pixel rows.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} colorType
 * @param {number} bitDepth
 * @param {Array<Array<Array<number>>>} rows rows[y][x][channel] channel values
 */
function rawScanlines(width, height, colorType, bitDepth, rows) {
  const channels = CHANNELS[colorType];
  const bytesPerSample = bitDepth / 8;
  const out = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * channels * bytesPerSample);
    row[0] = 0; // filter: None
    let p = 1;
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channels; c++) {
        const v = rows[y][x][c];
        if (bytesPerSample === 1) {
          row[p++] = v & 0xff;
        } else {
          row[p++] = (v >> 8) & 0xff; // high byte
          row[p++] = v & 0xff; // low byte
        }
      }
    }
    out.push(row);
  }
  return Buffer.concat(out);
}

/** Paeth predictor used to build filtered fixtures (mirrors the spec). */
function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Apply a single PNG scanline filter to unfiltered 8-bit row data.
 *
 * @param {number} width
 * @param {number} channels
 * @param {number} filterType 0..4
 * @param {Buffer[]} rows unfiltered row buffers (width*channels bytes each)
 * @returns {Buffer} concatenated filtered scanlines (filter byte per row)
 */
function applyFilter(width, channels, filterType, rows) {
  const bpp = channels;
  const out = [];
  let prev = Buffer.alloc(width * channels);
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    const filtered = Buffer.alloc(1 + row.length);
    filtered[0] = filterType;
    for (let i = 0; i < row.length; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let val;
      switch (filterType) {
        case 0: val = row[i]; break;
        case 1: val = row[i] - a; break;
        case 2: val = row[i] - b; break;
        case 3: val = row[i] - Math.floor((a + b) / 2); break;
        case 4: val = row[i] - paethPredictor(a, b, c); break;
        default: throw new Error(`bad filter type ${filterType}`);
      }
      filtered[1 + i] = val & 0xff;
    }
    out.push(filtered);
    prev = row;
  }
  return Buffer.concat(out);
}

/** Flatten pixel rows (rows[y][x][c]) into a flat channel-value array. */
function flatten(rows) {
  return rows.flat(2);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertPixel(pixels, width, x, y, expected) {
  const offset = (y * width + x) * 4;
  assert.deepEqual(
    [pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]],
    expected,
    `pixel (${x}, ${y})`
  );
}

/** Decode and verify every pixel of a simple (filter-0) image. */
function assertDecodes(width, height, colorType, bitDepth, rows, expectedRows) {
  const scanlines = rawScanlines(width, height, colorType, bitDepth, rows);
  const png = makePng({ width, height, colorType, bitDepth, scanlines });
  const { pixels } = decodePng(png);

  assert.equal(pixels.length, width * height * 4, 'pixels length is width*height*4');
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      assertPixel(pixels, width, x, y, expectedRows[y][x]);
    }
  }
  return { png, pixels };
}

// ---------------------------------------------------------------------------
// Colour types 0 / 2 / 3 / 4 / 6 (bit depth 8)
// ---------------------------------------------------------------------------

test('decodes colour type 0 (greyscale, 8-bit) with alpha 255', () => {
  const rows = [
    [[10], [20]],
    [[30], [40]],
  ];
  const expected = [
    [[10, 10, 10, 255], [20, 20, 20, 255]],
    [[30, 30, 30, 255], [40, 40, 40, 255]],
  ];
  assertDecodes(2, 2, 0, 8, rows, expected);
});

test('decodes colour type 2 (RGB, 8-bit) with alpha 255', () => {
  const rows = [
    [[255, 0, 0], [0, 255, 0]],
    [[0, 0, 255], [255, 255, 255]],
  ];
  const expected = [
    [[255, 0, 0, 255], [0, 255, 0, 255]],
    [[0, 0, 255, 255], [255, 255, 255, 255]],
  ];
  assertDecodes(2, 2, 2, 8, rows, expected);
});

test('decodes colour type 3 (palette, 8-bit) with opaque alpha', () => {
  const palette = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
  const rows = [
    [[0], [1], [2]],
    [[3], [0], [1]],
  ];
  const expected = [
    [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]],
    [[255, 255, 0, 255], [255, 0, 0, 255], [0, 255, 0, 255]],
  ];
  const scanlines = rawScanlines(3, 2, 3, 8, rows);
  const png = makePng({ width: 3, height: 2, colorType: 3, bitDepth: 8, scanlines, palette: palette.flat() });
  const { pixels } = decodePng(png);
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 3; x++) {
      assertPixel(pixels, 3, x, y, expected[y][x]);
    }
  }
});

test('decodes colour type 4 (greyscale+alpha, 8-bit)', () => {
  const rows = [
    [[10, 255], [20, 128]],
    [[30, 64], [40, 0]],
  ];
  const expected = [
    [[10, 10, 10, 255], [20, 20, 20, 128]],
    [[30, 30, 30, 64], [40, 40, 40, 0]],
  ];
  assertDecodes(2, 2, 4, 8, rows, expected);
});

test('decodes colour type 6 (RGBA, 8-bit) including alpha', () => {
  const rows = [
    [[255, 0, 0, 255], [0, 255, 0, 128]],
    [[0, 0, 255, 64], [255, 255, 255, 0]],
  ];
  const expected = [
    [[255, 0, 0, 255], [0, 255, 0, 128]],
    [[0, 0, 255, 64], [255, 255, 255, 0]],
  ];
  assertDecodes(2, 2, 6, 8, rows, expected);
});

// ---------------------------------------------------------------------------
// Scanline filters 0-4
// ---------------------------------------------------------------------------

test('decodes every scanline filter type (0-4)', async (t) => {
  const rows = [
    [
      [255, 0, 128], [1, 2, 3], [200, 100, 50], [7, 8, 9],
    ],
    [
      [10, 20, 30], [40, 50, 60], [70, 80, 90], [100, 110, 120],
    ],
    [
      [9, 8, 7], [6, 5, 4], [3, 2, 1], [255, 255, 255],
    ],
  ];
  const width = 4;
  const height = 3;

  // Unfiltered row buffers for the filter builder.
  const rowBuffers = rows.map((row) => {
    const buf = Buffer.alloc(width * 3);
    row.forEach((px, i) => {
      buf[i * 3] = px[0];
      buf[i * 3 + 1] = px[1];
      buf[i * 3 + 2] = px[2];
    });
    return buf;
  });

  for (let filterType = 0; filterType <= 4; filterType++) {
    await t.test(`filter type ${filterType}`, () => {
      const scanlines = applyFilter(width, 3, filterType, rowBuffers);
      const png = makePng({ width, height, colorType: 2, bitDepth: 8, scanlines });
      const { pixels } = decodePng(png);

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          assertPixel(pixels, width, x, y, [...rows[y][x], 255]);
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// tRNS transparency
// ---------------------------------------------------------------------------

test('applies tRNS alpha per entry for palette images (colour type 3)', () => {
  const palette = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];
  const tRNS = [0, 128, 255];
  const rows = [[[0], [1], [2]]];
  const scanlines = rawScanlines(3, 1, 3, 8, rows);
  const png = makePng({ width: 3, height: 1, colorType: 3, bitDepth: 8, scanlines, palette: palette.flat(), tRNS });
  const { pixels } = decodePng(png);

  assertPixel(pixels, 3, 0, 0, [255, 0, 0, 0]);
  assertPixel(pixels, 3, 1, 0, [0, 255, 0, 128]);
  assertPixel(pixels, 3, 2, 0, [0, 0, 255, 255]);
});

test('applies tRNS single grey value for greyscale images (colour type 0)', () => {
  const rows = [[[10], [20]]];
  const scanlines = rawScanlines(2, 1, 0, 8, rows);
  // 8-bit greyscale tRNS stores the grey value in 1 byte.
  const png = makePng({ width: 2, height: 1, colorType: 0, bitDepth: 8, scanlines, tRNS: [20] });
  const { pixels } = decodePng(png);

  assertPixel(pixels, 2, 0, 0, [10, 10, 10, 255]);
  assertPixel(pixels, 2, 1, 0, [20, 20, 20, 0]);
});

test('applies tRNS single colour value for RGB images (colour type 2)', () => {
  const rows = [[[10, 20, 30], [40, 50, 60]]];
  const scanlines = rawScanlines(2, 1, 2, 8, rows);
  // 8-bit truecolour tRNS stores one byte per channel.
  const png = makePng({ width: 2, height: 1, colorType: 2, bitDepth: 8, scanlines, tRNS: [40, 50, 60] });
  const { pixels } = decodePng(png);

  assertPixel(pixels, 2, 0, 0, [10, 20, 30, 255]);
  assertPixel(pixels, 2, 1, 0, [40, 50, 60, 0]);
});

test('applies tRNS matching the high byte for 16-bit greyscale (downconversion)', () => {
  // 16-bit grey values: pixel 0 = 0xFF00 (high byte 0xFF), pixel 1 = 0xFE00 (high byte 0xFE).
  // tRNS grey = 0xFFFF (high byte 0xFF) -> only pixel 0 becomes transparent.
  const rows = [[[0xff00], [0xfe00]]];
  const scanlines = rawScanlines(2, 1, 0, 16, rows);
  const png = makePng({ width: 2, height: 1, colorType: 0, bitDepth: 16, scanlines, tRNS: [0xff, 0xff] });
  const { pixels } = decodePng(png);

  assertPixel(pixels, 2, 0, 0, [0xff, 0xff, 0xff, 0]);
  assertPixel(pixels, 2, 1, 0, [0xfe, 0xfe, 0xfe, 255]);
});

// ---------------------------------------------------------------------------
// 16-bit downconversion (keep high byte)
// ---------------------------------------------------------------------------

test('downconverts 16-bit RGBA to 8-bit keeping the high byte', () => {
  const rows = [
    [[0xff00, 0x1234, 0xabcd, 0x00ff]],
    [[0x0001, 0x8000, 0x00ff, 0x8080]],
  ];
  const expected = [
    [[0xff, 0x12, 0xab, 0x00]],
    [[0x00, 0x80, 0x00, 0x80]],
  ];
  assertDecodes(1, 2, 6, 16, rows, expected);
});

test('downconverts 16-bit greyscale to 8-bit keeping the high byte', () => {
  const rows = [[[0xab00], [0x00cd]]];
  const expected = [[[0xab, 0xab, 0xab, 255], [0x00, 0x00, 0x00, 255]]];
  assertDecodes(2, 1, 0, 16, rows, expected);
});

// ---------------------------------------------------------------------------
// Multiple IDAT chunks
// ---------------------------------------------------------------------------

test('concatenates multiple IDAT chunks before inflating', () => {
  const rows = [
    [[255, 0, 0, 255], [0, 255, 0, 128]],
    [[0, 0, 255, 64], [255, 255, 255, 0]],
  ];
  const scanlines = rawScanlines(2, 2, 6, 8, rows);
  const png = makePng({ width: 2, height: 2, colorType: 6, bitDepth: 8, scanlines, idatChunks: 3 });
  const { pixels } = decodePng(png);

  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 2; x++) {
      assertPixel(pixels, 2, x, y, rows[y][x]);
    }
  }
});

// ---------------------------------------------------------------------------
// getPixel helper
// ---------------------------------------------------------------------------

test('getPixel returns correct values at corners, edges and centre', () => {
  const rows = [
    [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]],
    [[13, 14, 15, 16], [17, 18, 19, 20], [21, 22, 23, 24]],
  ];
  const scanlines = rawScanlines(3, 2, 6, 8, rows);
  const png = makePng({ width: 3, height: 2, colorType: 6, bitDepth: 8, scanlines });
  const { width, pixels } = decodePng(png);

  assert.deepEqual(getPixel(pixels, width, 0, 0), [1, 2, 3, 4]); // top-left
  assert.deepEqual(getPixel(pixels, width, 2, 0), [9, 10, 11, 12]); // top-right
  assert.deepEqual(getPixel(pixels, width, 0, 1), [13, 14, 15, 16]); // bottom-left
  assert.deepEqual(getPixel(pixels, width, 2, 1), [21, 22, 23, 24]); // bottom-right
  assert.deepEqual(getPixel(pixels, width, 1, 0), [5, 6, 7, 8]); // top edge
  assert.deepEqual(getPixel(pixels, width, 1, 1), [17, 18, 19, 20]); // centre
});

test('getPixel returns null out of bounds (documented convention)', () => {
  const scanlines = rawScanlines(3, 2, 6, 8, [
    [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]],
    [[13, 14, 15, 16], [17, 18, 19, 20], [21, 22, 23, 24]],
  ]);
  const png = makePng({ width: 3, height: 2, colorType: 6, bitDepth: 8, scanlines });
  const { width, pixels } = decodePng(png);

  assert.equal(getPixel(pixels, width, -1, 0), null); // left of image
  assert.equal(getPixel(pixels, width, 3, 0), null); // right of image
  assert.equal(getPixel(pixels, width, 0, -1), null); // above image
  assert.equal(getPixel(pixels, width, 0, 2), null); // below image
  assert.equal(getPixel(pixels, width, 1.5, 0), null); // non-integer x
  assert.equal(getPixel(pixels, width, 0, 0.5), null); // non-integer y
});

test('getPixel validates its arguments', () => {
  const scanlines = rawScanlines(1, 1, 6, 8, [[[1, 2, 3, 4]]]);
  const png = makePng({ width: 1, height: 1, colorType: 6, bitDepth: 8, scanlines });
  const { width, pixels } = decodePng(png);

  assert.throws(() => getPixel('nope', width, 0, 0), /Uint8Array/);
  assert.throws(() => getPixel(pixels, 0, 0, 0), /positive integer width/);
  // A width that does not divide the pixel buffer evenly is structurally invalid.
  assert.throws(() => getPixel(pixels, 3, 0, 0), /multiple of width\*4/);
});

// ---------------------------------------------------------------------------
// Unsupported / invalid input
// ---------------------------------------------------------------------------

test('rejects non-PNG input with a clear unsupported-format error (never a crash)', () => {
  const nonPngInputs = [
    Buffer.from('not a png at all, just text'),
    Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), // "GIF89a"
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]), // JPEG SOI marker
    Buffer.from('BM'), // BMP
    Buffer.alloc(0), // empty
  ];
  for (const input of nonPngInputs) {
    assert.throws(
      () => decodePng(input),
      /only PNG is currently supported/,
      `expected unsupported-format error for ${input.length} bytes`
    );
    assert.throws(() => decodePng(input), /Unsupported format/);
  }
});

test('rejects a buffer that is shorter than the PNG signature', () => {
  assert.throws(() => decodePng(Buffer.from([0x89, 0x50])), /only PNG is currently supported/);
});

test('rejects unsupported colour types with a descriptive error', () => {
  // Colour type 5 is not a valid PNG colour type and must be rejected.
  const png = makePng({ width: 1, height: 1, colorType: 5, bitDepth: 8, scanlines: Buffer.from([0, 0]) });
  assert.throws(() => decodePng(png), /colour type 5 is not supported/);
});

test('rejects unsupported bit depths with a descriptive error', () => {
  // Bit depth 2 is a legal PNG for greyscale, but out of our supported set.
  const png = makePng({ width: 1, height: 1, colorType: 0, bitDepth: 2, scanlines: Buffer.from([0, 0]) });
  assert.throws(() => decodePng(png), /bit depth 2 is not supported/);
});

test('rejects interlaced (Adam7) images with a descriptive error', () => {
  const scanlines = rawScanlines(1, 1, 6, 8, [[[1, 2, 3, 4]]]);
  const png = makePng({ width: 1, height: 1, colorType: 6, bitDepth: 8, scanlines, interlace: 1 });
  assert.throws(() => decodePng(png), /interlaced \(Adam7\) images are not supported/);
});

test('rejects palette images at unsupported bit depths (colour type 3, bit depth 16)', () => {
  const png = makePng({ width: 1, height: 1, colorType: 3, bitDepth: 16, scanlines: Buffer.from([0, 0]) });
  assert.throws(() => decodePng(png), /palette \(colour type 3\) is only supported at bit depth 8/);
});

// ---------------------------------------------------------------------------
// Corrupt / truncated input
// ---------------------------------------------------------------------------

test('rejects truncated input with a descriptive error', () => {
  const scanlines = rawScanlines(2, 2, 6, 8, [
    [[1, 2, 3, 4], [5, 6, 7, 8]],
    [[9, 10, 11, 12], [13, 14, 15, 16]],
  ]);
  const png = makePng({ width: 2, height: 2, colorType: 6, bitDepth: 8, scanlines });

  // Truncate off the trailing chunks (IEND / tail of IDAT).
  assert.throws(() => decodePng(png.subarray(0, png.length - 10)), /Truncated PNG/);
  assert.throws(() => decodePng(png.subarray(0, Math.floor(png.length / 2))), /Truncated PNG/);
});

test('rejects data with a corrupted IDAT payload (CRC mismatch)', () => {
  const scanlines = rawScanlines(2, 2, 6, 8, [
    [[1, 2, 3, 4], [5, 6, 7, 8]],
    [[9, 10, 11, 12], [13, 14, 15, 16]],
  ]);
  const png = makePng({ width: 2, height: 2, colorType: 6, bitDepth: 8, scanlines });

  // Flip a byte inside the IDAT payload while leaving the (now stale) CRC intact.
  const corrupted = Buffer.from(png);
  const idatPos = corrupted.indexOf(Buffer.from('IDAT'));
  corrupted[idatPos + 9] ^= 0xff; // inside IDAT data
  assert.throws(() => decodePng(corrupted), /CRC mismatch in "IDAT"/);
});

test('rejects a corrupt IDAT stream that fails to inflate', () => {
  // Valid framing/CRC, but the payload is not a zlib stream.
  const png = makePng({ width: 1, height: 1, colorType: 6, bitDepth: 8, idatData: Buffer.from('this is not zlib data') });
  assert.throws(() => decodePng(png), /failed to decompress image data/);
});

test('rejects a PNG with a mismatched decompressed size', () => {
  // Declared 2x2 but only enough scanline data for 1 row.
  const scanlines = rawScanlines(2, 1, 6, 8, [[[1, 2, 3, 4], [5, 6, 7, 8]]]);
  const png = makePng({ width: 2, height: 2, colorType: 6, bitDepth: 8, scanlines });
  assert.throws(() => decodePng(png), /decompressed data is \d+ bytes, expected \d+/);
});

test('rejects a PNG missing its IDAT chunk', () => {
  // Build a PNG then drop the IDAT chunk by rebuilding without scanlines data.
  const scanlines = rawScanlines(1, 1, 6, 8, [[[1, 2, 3, 4]]]);
  const full = makePng({ width: 1, height: 1, colorType: 6, bitDepth: 8, scanlines });
  // Remove every IDAT chunk by re-parsing: simplest is to hand-build without IDAT.
  const parts = [PNG_SIGNATURE];
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  parts.push(chunk('IHDR', ihdr));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  assert.throws(() => decodePng(Buffer.concat(parts)), /missing IDAT chunk/);
  void full;
});

test('rejects a PNG with an unknown scanline filter type', () => {
  // One row, filter byte 7 (invalid) followed by pixel bytes.
  const png = makePng({ width: 1, height: 1, colorType: 6, bitDepth: 8, scanlines: Buffer.from([7, 1, 2, 3, 4]) });
  assert.throws(() => decodePng(png), /unknown scanline filter type 7/);
});

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

test('decodePng accepts a plain Uint8Array (not just a Buffer)', () => {
  const scanlines = rawScanlines(1, 1, 6, 8, [[[1, 2, 3, 4]]]);
  const png = makePng({ width: 1, height: 1, colorType: 6, bitDepth: 8, scanlines });
  const { width, height, pixels } = decodePng(new Uint8Array(png));
  assert.equal(width, 1);
  assert.equal(height, 1);
  assert.deepEqual(Array.from(pixels), [1, 2, 3, 4]);
});

test('exports decodePng and getPixel as functions', () => {
  assert.equal(typeof decodePng, 'function');
  assert.equal(typeof getPixel, 'function');
});

test('round-trips a decoded image through getPixel for every pixel', () => {
  const rows = [
    [[255, 0, 0, 255], [0, 255, 0, 128]],
    [[0, 0, 255, 64], [255, 255, 255, 0]],
  ];
  const scanlines = rawScanlines(2, 2, 6, 8, rows);
  const png = makePng({ width: 2, height: 2, colorType: 6, bitDepth: 8, scanlines });
  const { width, pixels } = decodePng(png);
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 2; x++) {
      assert.deepEqual(getPixel(pixels, width, x, y), rows[y][x]);
    }
  }
});
