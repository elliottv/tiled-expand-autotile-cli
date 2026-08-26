'use strict';

/**
 * png-writer.js
 *
 * Zero-dependency PNG writer + expanded-image renderer for
 * tiled-expand-autotile-cli.
 *
 * Story (issue #5): PNG expanded image writer (render + encode) - the
 * "Save intermediate as: Image" path of the original Tiled script, done with
 * only Node built-ins (node:zlib, no third-party packages).
 *
 * This module is pure (no I/O). It exports two functions:
 *
 *   encodePng({ width, height, pixels }) -> Buffer
 *     Serialises a raw RGBA pixel buffer as a PNG file (colour type 6
 *     truecolour+alpha, bit depth 8). Emits the 8-byte signature, IHDR, one
 *     or more IDAT chunks (the deflated scanlines are split into <= 64 KiB
 *     chunks) and IEND, each chunk carrying the correct CRC-32.
 *
 *   renderExpandedImage(sourceImage, grid, subtileWidth, subtileHeight,
 *                       tilesetWidth) -> { width, height, pixels }
 *     Rasterises the expanded subtile grid (as produced by engine.expand)
 *     into a raw RGBA image by copying each referenced subtile block out of
 *     the decoded source tileset image. Empty (null) grid cells become fully
 *     transparent (0, 0, 0, 0).
 *
 * `sourceImage` is the exact object returned by decodePng (png-decode.js,
 * story #7): { width, height, pixels } where `pixels` is a row-major RGBA
 * Uint8Array (4 bytes per pixel, top-to-bottom). Story 7 consumes both
 * functions here for the `--intermediate-format png` CLI path.
 */

const zlib = require('node:zlib');

/** 8-byte PNG file signature. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Maximum IDAT payload per chunk. The PNG spec allows chunks up to 2^31-1
 * bytes, but keeping each IDAT <= 64 KiB is a safe, conventional choice that
 * also satisfies the "one or more chunks" requirement without relying on the
 * whole compressed stream fitting in a single chunk.
 */
const MAX_IDAT_CHUNK_SIZE = 65536;

// ---------------------------------------------------------------------------
// CRC-32 (PNG chunk checksums) - the same table/algorithm as png-decode.js
// ---------------------------------------------------------------------------

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

/**
 * Compute the CRC-32 checksum of a buffer. A PNG chunk CRC covers the chunk
 * type (4 bytes) followed by the chunk data.
 *
 * @param {Buffer|Uint8Array} buf - bytes to checksum.
 * @returns {number} unsigned 32-bit CRC.
 */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// PNG chunk helper
// ---------------------------------------------------------------------------

/**
 * Build one complete PNG chunk: length + type + data + CRC32(type || data).
 *
 * @param {string} type - 4-character chunk type (e.g. 'IHDR').
 * @param {Buffer} data - chunk payload.
 * @returns {Buffer} the full chunk bytes.
 */
function makeChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);

  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

/**
 * Encode raw RGBA pixels as a PNG file.
 *
 * @param {{ width: number, height: number, pixels: Uint8Array|Buffer|number[] }} img
 *   `pixels` is row-major RGBA (4 bytes per pixel, top-to-bottom) and must
 *   be exactly width * height * 4 bytes long.
 * @returns {Buffer} complete PNG file bytes (signature + IHDR + IDAT(s) +
 *   IEND), ready to be written to disk.
 * @throws {TypeError|Error} on invalid dimensions or a pixel buffer whose
 *   length does not match width * height * 4.
 */
function encodePng({ width, height, pixels }) {
  // --- Validate -------------------------------------------------------------
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new TypeError(`encodePng expects positive integer dimensions, got ${width}x${height}`);
  }
  if (pixels === undefined || pixels === null || typeof pixels.length !== 'number') {
    throw new TypeError('encodePng expects a pixels buffer (Uint8Array, Buffer or number[])');
  }
  if (pixels.length !== width * height * 4) {
    throw new Error(
      `encodePng: pixels length (${pixels.length}) must equal width*height*4 ` +
        `(${width * height * 4})`
    );
  }

  const pixelBuf = Buffer.isBuffer(pixels) ? pixels : Buffer.from(pixels);

  // --- IHDR -----------------------------------------------------------------
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth: 8 bits per channel
  ihdr[9] = 6; // colour type: truecolour + alpha (RGBA)
  ihdr[10] = 0; // compression method (deflate)
  ihdr[11] = 0; // filter method (adaptive per scanline)
  ihdr[12] = 0; // interlace method: none (Adam7 out of scope)

  // --- Raw scanlines ----------------------------------------------------------
  // Each scanline is one filter byte followed by width*4 RGBA bytes. Filter 0
  // (None) is always valid and keeps the encoder simple and obviously correct;
  // png-decode.js handles every filter type, so round-trips are exact.
  const stride = width * 4;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + stride);
    raw[rowStart] = 0; // filter: None
    pixelBuf.copy(raw, rowStart + 1, y * stride, (y + 1) * stride);
  }

  // --- IDAT (deflate, split into <= 64 KiB chunks) -----------------------------
  const compressed = zlib.deflateSync(raw);
  const idatChunks = [];
  for (let i = 0; i < compressed.length; i += MAX_IDAT_CHUNK_SIZE) {
    idatChunks.push(makeChunk('IDAT', compressed.subarray(i, i + MAX_IDAT_CHUNK_SIZE)));
  }

  // --- Assemble ---------------------------------------------------------------
  return Buffer.concat([
    PNG_SIGNATURE,
    makeChunk('IHDR', ihdr),
    ...idatChunks,
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Expanded-image renderer
// ---------------------------------------------------------------------------

/** Validate a positive-integer dimension argument, throwing a descriptive error. */
function assertPositiveInt(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer, got ${value}`);
  }
}

/**
 * Render the expanded subtile grid into a raw RGBA image.
 *
 * The `grid` is the structure produced by engine.expand():
 * `grid[y][x]` where y ranges over grid rows and x over grid columns. Each
 * cell holds a source subtile index (row-major across the source tileset,
 * which is `tilesetWidth` subtiles wide) or `null` for an empty cell.
 *
 * The output image is gridW*subtileWidth pixels wide and gridH*subtileHeight
 * pixels tall. For a cell with index `idx`, the source subtile lives at
 * `sx = idx % tilesetWidth`, `sy = floor(idx / tilesetWidth)` and its
 * subtileWidth x subtileHeight pixel block is copied to the output at
 * (cellX*subtileWidth, cellY*subtileHeight). Empty cells stay fully
 * transparent (0, 0, 0, 0).
 *
 * @param {{ width: number, height: number, pixels: Uint8Array }} sourceImage
 *   decoded source tileset, exactly as returned by decodePng.
 * @param {Array<Array<number|null>>} grid - expanded subtile grid.
 * @param {number} subtileWidth - width of one subtile in pixels.
 * @param {number} subtileHeight - height of one subtile in pixels.
 * @param {number} tilesetWidth - source tileset width in subtiles.
 * @returns {{ width: number, height: number, pixels: Uint8Array }}
 *   raw RGBA image of the expanded tileset.
 * @throws {TypeError|Error} on malformed arguments.
 */
function renderExpandedImage(sourceImage, grid, subtileWidth, subtileHeight, tilesetWidth) {
  // --- Validate ---------------------------------------------------------------
  if (
    sourceImage === undefined ||
    sourceImage === null ||
    !Number.isInteger(sourceImage.width) ||
    !Number.isInteger(sourceImage.height) ||
    sourceImage.width <= 0 ||
    sourceImage.height <= 0
  ) {
    throw new TypeError(
      'renderExpandedImage expects a sourceImage with positive integer width and height'
    );
  }
  const srcPixels = sourceImage.pixels;
  if (!(srcPixels instanceof Uint8Array)) {
    throw new TypeError('renderExpandedImage: sourceImage.pixels must be a Uint8Array');
  }
  if (srcPixels.length !== sourceImage.width * sourceImage.height * 4) {
    throw new Error(
      `renderExpandedImage: sourceImage.pixels length (${srcPixels.length}) does not match ` +
        `width*height*4 (${sourceImage.width * sourceImage.height * 4})`
    );
  }
  if (!Array.isArray(grid) || grid.length === 0 || !Array.isArray(grid[0])) {
    throw new TypeError('renderExpandedImage expects a non-empty 2D grid array');
  }
  assertPositiveInt(subtileWidth, 'subtileWidth');
  assertPositiveInt(subtileHeight, 'subtileHeight');
  assertPositiveInt(tilesetWidth, 'tilesetWidth');

  const gridHeight = grid.length;
  const gridWidth = grid[0].length;
  const outWidth = gridWidth * subtileWidth;
  const outHeight = gridHeight * subtileHeight;

  // Zero-filled => every cell starts fully transparent (0, 0, 0, 0); empty
  // (null) cells are simply never written to.
  const pixels = new Uint8Array(outWidth * outHeight * 4);

  const srcStride = sourceImage.width * 4;
  const outStride = outWidth * 4;

  for (let cellY = 0; cellY < gridHeight; cellY++) {
    const row = grid[cellY];
    if (!Array.isArray(row) || row.length !== gridWidth) {
      throw new TypeError(
        `renderExpandedImage: grid row ${cellY} must be an array of ${gridWidth} cells`
      );
    }

    for (let cellX = 0; cellX < gridWidth; cellX++) {
      const idx = row[cellX];
      if (idx === null || idx === undefined) {
        continue; // leave the region transparent
      }
      if (!Number.isInteger(idx) || idx < 0) {
        throw new TypeError(
          `renderExpandedImage: grid[${cellY}][${cellX}] must be a non-negative integer ` +
            `subtile index or null, got ${idx}`
        );
      }

      const sx = idx % tilesetWidth;
      const sy = Math.floor(idx / tilesetWidth);
      const srcX = sx * subtileWidth;
      const srcY = sy * subtileHeight;
      const dstX = cellX * subtileWidth;
      const dstY = cellY * subtileHeight;

      // Copy the subtile block row by row.
      for (let dy = 0; dy < subtileHeight; dy++) {
        const srcStart = (srcY + dy) * srcStride + srcX * 4;
        const dstStart = (dstY + dy) * outStride + dstX * 4;
        pixels.set(srcPixels.subarray(srcStart, srcStart + subtileWidth * 4), dstStart);
      }
    }
  }

  return { width: outWidth, height: outHeight, pixels };
}

module.exports = {
  encodePng,
  renderExpandedImage,
};
