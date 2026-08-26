'use strict';

/**
 * png-decode.js
 *
 * Zero-dependency PNG decoder for tiled-expand-autotile-cli.
 *
 * The original Tiled script relied on Qt image loading; this CLI must decode
 * PNG natively using only Node built-ins (node:zlib). This module decodes a
 * source RPG Maker tileset image (PNG) into raw RGBA pixels.
 *
 * Story (issue #7): PNG image decoder for source tilesets.
 *
 * Supported:
 *  - colour types 0 (greyscale), 2 (RGB), 3 (palette), 4 (greyscale+alpha),
 *    6 (RGBA);
 *  - bit depth 8; bit depth 16 (downconverted to 8 by keeping the high byte);
 *  - tRNS transparency for colour types 0, 2 and 3;
 *  - all scanline filters (0 None, 1 Sub, 2 Up, 3 Average, 4 Paeth);
 *  - multiple IDAT chunks (concatenated before inflate via node:zlib).
 *
 * Rejected with a descriptive Error:
 *  - non-PNG input (bad signature) -> clear "unsupported format" error
 *    (bmp/gif/jpeg/jpg/xpm/qoi/svg/cur/webp are out of scope);
 *  - unsupported colour type / bit depth;
 *  - interlaced (Adam7) images (rejected explicitly);
 *  - corrupt / truncated PNG data.
 *
 * Exports:
 *   decodePng(buffer) -> { width, height, pixels }   (pixels: RGBA Uint8Array)
 *   getPixel(pixels, width, x, y) -> [r, g, b, a] | null
 */

const zlib = require('node:zlib');

/** 8-byte PNG file signature. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Colour type -> channels per pixel (before bit-depth scaling). */
const CHANNELS_PER_COLOUR_TYPE = {
  0: 1, // greyscale
  2: 3, // truecolour (RGB)
  3: 1, // indexed (palette index)
  4: 2, // greyscale + alpha
  6: 4, // truecolour + alpha (RGBA)
};

/** Bit depths we can decode (16 is downconverted to 8). */
const SUPPORTED_BIT_DEPTHS = new Set([8, 16]);

/** File formats the original Tiled file filter accepted but we deliberately do not. */
const OUT_OF_SCOPE_FORMATS = ['bmp', 'gif', 'jpeg', 'jpg', 'xpm', 'qoi', 'svg', 'cur', 'webp'];

// ---------------------------------------------------------------------------
// CRC-32 (PNG chunk checksums)
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

/** Compute the CRC-32 checksum of a buffer (PNG CRC covers chunk type + data). */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Chunk parsing
// ---------------------------------------------------------------------------

/**
 * Split a PNG buffer into its top-level chunks.
 *
 * Returns an array of `{ type, data }` objects. Throws a descriptive Error on
 * truncated or corrupt chunk framing (a chunk whose header/data/CRC runs past
 * the end of the file, or whose CRC does not match its contents).
 */
function parseChunks(buf) {
  const chunks = [];
  let offset = PNG_SIGNATURE.length; // skip signature

  while (offset < buf.length) {
    if (offset + 8 > buf.length) {
      throw new Error('Truncated PNG: chunk header extends past the end of the file');
    }

    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;

    if (dataEnd + 4 > buf.length) {
      throw new Error(
        `Truncated PNG: "${type}" chunk data (${length} bytes) extends past the end of the file`
      );
    }

    const data = buf.subarray(dataStart, dataEnd);
    const expectedCrc = buf.readUInt32BE(dataEnd);
    const actualCrc = crc32(buf.subarray(offset + 4, dataEnd));
    if (actualCrc !== expectedCrc) {
      throw new Error(`Corrupt PNG: CRC mismatch in "${type}" chunk`);
    }

    chunks.push({ type, data });
    offset = dataEnd + 4;

    // IEND must be the final chunk; stop there.
    if (type === 'IEND') break;
  }

  if (!chunks.some((c) => c.type === 'IEND')) {
    throw new Error('Truncated PNG: missing IEND chunk');
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Scanline unfiltering helpers
// ---------------------------------------------------------------------------

/** Paeth predictor from the PNG spec (used by filter type 4). */
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
 * Read a single sample from an unfiltered scanline.
 *
 * `start` is the byte offset of the first channel of the pixel. At bit depth 16
 * each channel occupies 2 bytes (big-endian) and we keep the high byte.
 */
function sampleAt(row, start, channel, bytesPerSample) {
  return bytesPerSample === 1 ? row[start + channel] : row[start + channel * 2];
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

/**
 * Decode a PNG image into raw RGBA pixels.
 *
 * @param {Buffer|Uint8Array} buffer - full PNG file contents.
 * @returns {{ width: number, height: number, pixels: Uint8Array }}
 *   `pixels` is a `Uint8Array` of RGBA (4 bytes/pixel, row-major, top-to-bottom).
 * @throws {Error} with a descriptive message for non-PNG input, unsupported
 *   colour types / bit depths, interlaced (Adam7) images, and corrupt or
 *   truncated data.
 */
function decodePng(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

  // --- Signature -----------------------------------------------------------
  if (
    buf.length < PNG_SIGNATURE.length ||
    !buf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    throw new Error(
      `Unsupported format: only PNG is currently supported ` +
        `(${OUT_OF_SCOPE_FORMATS.join('/')} are out of scope).`
    );
  }

  // --- Chunks ---------------------------------------------------------------
  const chunks = parseChunks(buf);

  // --- IHDR -----------------------------------------------------------------
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr) throw new Error('Not a valid PNG: missing IHDR chunk');
  if (ihdr.data.length !== 13) {
    throw new Error(`Corrupt PNG: IHDR chunk must be 13 bytes, got ${ihdr.data.length}`);
  }

  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colourType = ihdr.data[9];
  const compressionMethod = ihdr.data[10];
  const filterMethod = ihdr.data[11];
  const interlaceMethod = ihdr.data[12];

  if (width === 0 || height === 0) {
    throw new Error(`Invalid PNG: width and height must be positive (got ${width}x${height})`);
  }
  if (compressionMethod !== 0) {
    throw new Error(`Unsupported PNG: compression method ${compressionMethod} (only 0 is supported)`);
  }
  if (filterMethod !== 0) {
    throw new Error(`Unsupported PNG: filter method ${filterMethod} (only 0 is supported)`);
  }
  if (interlaceMethod !== 0) {
    throw new Error('Unsupported PNG: interlaced (Adam7) images are not supported');
  }
  if (!(colourType in CHANNELS_PER_COLOUR_TYPE)) {
    throw new Error(
      `Unsupported PNG: colour type ${colourType} is not supported (expected 0, 2, 3, 4 or 6)`
    );
  }
  if (!SUPPORTED_BIT_DEPTHS.has(bitDepth)) {
    throw new Error(
      `Unsupported PNG: bit depth ${bitDepth} is not supported (only 8 and 16 are supported)`
    );
  }
  // Palette images only exist at bit depths 1/2/4/8; we accept 8 only.
  if (colourType === 3 && bitDepth !== 8) {
    throw new Error('Unsupported PNG: palette (colour type 3) is only supported at bit depth 8');
  }

  const channels = CHANNELS_PER_COLOUR_TYPE[colourType];
  const bytesPerSample = bitDepth / 8; // 1 or 2
  const bpp = channels * bytesPerSample; // bytes per pixel in the scanline stream
  const rowBytes = width * channels * bytesPerSample;

  // --- PLTE (required for palette images) -----------------------------------
  let palette = null;
  const plte = chunks.find((c) => c.type === 'PLTE');
  if (colourType === 3) {
    if (!plte) throw new Error('Not a valid PNG: palette image is missing its PLTE chunk');
    if (plte.data.length === 0 || plte.data.length % 3 !== 0) {
      throw new Error(`Corrupt PNG: PLTE length must be a non-zero multiple of 3, got ${plte.data.length}`);
    }
    if (plte.data.length / 3 > 256) {
      throw new Error(`Corrupt PNG: PLTE has too many entries (${plte.data.length / 3} > 256)`);
    }
    palette = plte.data;
  }

  // --- tRNS (transparency) ---------------------------------------------------
  // For colour types 0 and 2 the transparent value is stored in the format of
  // the image data (1 byte/channel at bit depth 8, 2 bytes/channel at 16).
  // We compare against the 8-bit value after downconversion (the high byte).
  let greyTransparent = null; // colour type 0
  let rgbTransparent = null; // colour type 2: [r, g, b]
  let paletteAlpha = null; // colour type 3: alpha per palette entry
  const trns = chunks.find((c) => c.type === 'tRNS');
  if (trns) {
    if (colourType === 0) {
      if (trns.data.length < bytesPerSample) {
        throw new Error('Corrupt PNG: tRNS for a greyscale image has too few bytes');
      }
      greyTransparent = trns.data[0]; // high byte of the grey value
    } else if (colourType === 2) {
      if (trns.data.length < 3 * bytesPerSample) {
        throw new Error('Corrupt PNG: tRNS for an RGB image has too few bytes');
      }
      rgbTransparent = [
        trns.data[0],
        trns.data[bytesPerSample],
        trns.data[2 * bytesPerSample],
      ];
    } else if (colourType === 3) {
      if (trns.data.length > palette.length / 3) {
        throw new Error('Corrupt PNG: tRNS has more alpha entries than palette entries');
      }
      paletteAlpha = trns.data;
    }
    // Colour types 4/6 carry their own alpha; tRNS is not applicable and ignored.
  }

  // --- IDAT (concatenate, then inflate) ---------------------------------------
  const idats = chunks.filter((c) => c.type === 'IDAT');
  if (idats.length === 0) {
    throw new Error('Not a valid PNG: missing IDAT chunk (no image data)');
  }
  const idatData = Buffer.concat(idats.map((c) => c.data));

  let raw;
  try {
    raw = zlib.inflateSync(idatData);
  } catch (err) {
    throw new Error(`Corrupt PNG: failed to decompress image data (${err.message})`);
  }

  const expectedLen = height * (1 + rowBytes); // one filter byte per row
  if (raw.length !== expectedLen) {
    throw new Error(
      `Corrupt PNG: decompressed data is ${raw.length} bytes, expected ${expectedLen} ` +
        `for a ${width}x${height} image at bit depth ${bitDepth}, colour type ${colourType}`
    );
  }

  // --- Unfilter + convert to RGBA --------------------------------------------
  const pixels = new Uint8Array(width * height * 4);
  const prevRow = new Uint8Array(rowBytes); // previous (unfiltered) row
  const row = new Uint8Array(rowBytes); // current (unfiltered) row
  let src = 0;

  for (let y = 0; y < height; y++) {
    const filterType = raw[src];
    src++;
    if (filterType > 4) {
      throw new Error(`Corrupt PNG: unknown scanline filter type ${filterType} at row ${y}`);
    }

    // Reverse the per-row filter (all arithmetic is mod 256).
    for (let x = 0; x < rowBytes; x++) {
      const rawByte = raw[src + x];
      const left = x >= bpp ? row[x - bpp] : 0;
      const up = prevRow[x];
      const upperLeft = x >= bpp ? prevRow[x - bpp] : 0;

      let value;
      switch (filterType) {
        case 0: value = rawByte; break; // None
        case 1: value = rawByte + left; break; // Sub
        case 2: value = rawByte + up; break; // Up
        case 3: value = rawByte + ((left + up) >> 1); break; // Average
        case 4: value = rawByte + paethPredictor(left, up, upperLeft); break; // Paeth
        /* istanbul ignore next */ // filterType > 4 already rejected above
        default: value = rawByte; break;
      }
      row[x] = value & 0xff;
    }
    src += rowBytes;

    // Convert this row's samples to RGBA.
    for (let px = 0; px < width; px++) {
      const s = px * channels * bytesPerSample;
      const out = (y * width + px) * 4;

      switch (colourType) {
        case 0: {
          const g = sampleAt(row, s, 0, bytesPerSample);
          pixels[out] = g;
          pixels[out + 1] = g;
          pixels[out + 2] = g;
          pixels[out + 3] = greyTransparent !== null && g === greyTransparent ? 0 : 255;
          break;
        }
        case 2: {
          const r = sampleAt(row, s, 0, bytesPerSample);
          const g = sampleAt(row, s, 1, bytesPerSample);
          const b = sampleAt(row, s, 2, bytesPerSample);
          pixels[out] = r;
          pixels[out + 1] = g;
          pixels[out + 2] = b;
          pixels[out + 3] =
            rgbTransparent !== null &&
            r === rgbTransparent[0] &&
            g === rgbTransparent[1] &&
            b === rgbTransparent[2]
              ? 0
              : 255;
          break;
        }
        case 3: {
          const index = sampleAt(row, s, 0, bytesPerSample);
          const p = index * 3;
          pixels[out] = palette[p];
          pixels[out + 1] = palette[p + 1];
          pixels[out + 2] = palette[p + 2];
          pixels[out + 3] =
            paletteAlpha !== null ? (index < paletteAlpha.length ? paletteAlpha[index] : 255) : 255;
          break;
        }
        case 4: {
          const g = sampleAt(row, s, 0, bytesPerSample);
          const a = sampleAt(row, s, 1, bytesPerSample);
          pixels[out] = g;
          pixels[out + 1] = g;
          pixels[out + 2] = g;
          pixels[out + 3] = a;
          break;
        }
        case 6: {
          pixels[out] = sampleAt(row, s, 0, bytesPerSample);
          pixels[out + 1] = sampleAt(row, s, 1, bytesPerSample);
          pixels[out + 2] = sampleAt(row, s, 2, bytesPerSample);
          pixels[out + 3] = sampleAt(row, s, 3, bytesPerSample);
          break;
        }
        /* istanbul ignore next */ // colourType validated above
        default:
          throw new Error(`Unsupported PNG: colour type ${colourType}`);
      }
    }

    prevRow.set(row);
  }

  return { width, height, pixels };
}

// ---------------------------------------------------------------------------
// Pixel access helper
// ---------------------------------------------------------------------------

/**
 * Read a single RGBA pixel from a decoded pixel buffer.
 *
 * @param {Uint8Array} pixels - RGBA data as produced by decodePng.
 * @param {number} width - image width in pixels. The height is derived from the
 *   buffer length (pixels.length must be width*height*4).
 * @param {number} x - column (0-based).
 * @param {number} y - row (0-based).
 * @returns {number[]|null} `[r, g, b, a]` or `null` when the coordinate is out
 *   of bounds (negative, non-integer, or beyond the image edges).
 */
function getPixel(pixels, width, x, y) {
  if (!(pixels instanceof Uint8Array) || !Number.isInteger(width) || width <= 0) {
    throw new TypeError('getPixel expects a Uint8Array of RGBA pixels and a positive integer width');
  }
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) {
    return null;
  }

  const stride = width * 4;
  if (pixels.length % stride !== 0) {
    throw new Error(`getPixel: pixels length (${pixels.length}) must be a multiple of width*4 (${stride})`);
  }
  const height = pixels.length / stride;

  if (x >= width || y >= height) return null;

  const offset = (y * width + x) * 4;
  return [pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]];
}

module.exports = {
  decodePng,
  getPixel,
};
