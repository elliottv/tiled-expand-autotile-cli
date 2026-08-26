'use strict';

/**
 * tileset-writer.js
 *
 * Writes the FINAL Tiled tileset file — the "Save Tileset As" output of the
 * original script (story / issue #3). The tileset references the intermediate
 * expanded image (the TMX or PNG produced by an earlier step) as its image
 * source, so it opens directly in Tiled and shows the expanded tiles.
 *
 * This module is deliberately pure: `writeTileset` returns the file contents
 * as a single string and never touches the filesystem.
 *
 * Two formats are supported, selected by the `format` parameter:
 *
 *   tsx (XML) — Tiled's classic tileset format:
 *     <?xml version="1.0" encoding="UTF-8"?>
 *     <tileset version="1.10" tiledversion="1.10.2" name="<name>"
 *              tilewidth="<tileWidth>" tileheight="<tileHeight>"
 *              tilecount="<columns*rows>" columns="<columns>">
 *      <image source="<imagePath>" width="<imageWidth>"
 *             height="<imageHeight>" [trans="#rrggbb"]/>
 *     </tileset>
 *
 *   tsj (JSON) — Tiled's JSON tileset format (same fields Tiled writes for
 *     image-based tilesets):
 *     {
 *       "type": "tileset",
 *       "name": "<name>",
 *       "tilewidth": <tileWidth>,
 *       "tileheight": <tileHeight>,
 *       "tilecount": <columns*rows>,
 *       "columns": <columns>,
 *       "image": "<imagePath>",
 *       "imagewidth": <imageWidth>,
 *       "imageheight": <imageHeight>,
 *       "transparentcolor": "#rrggbb",   // only when transparentColor is set
 *       "tiles": []
 *     }
 *
 * columns  = floor(imageWidth  / tileWidth)
 * rows     = floor(imageHeight / tileHeight)
 * tilecount = columns * rows
 *
 * The `trans` / `transparentcolor` value is always normalised to a 6-digit
 * lowercase `#rrggbb` (from #RGB / #RRGGBB / #AARRGGBB), mirroring how the TMX
 * intermediate writer (tmx-writer.js) normalises its trans attribute so both
 * outputs stay consistent.
 *
 * Story #7 wires the format selection (from --output / --tileset-format); this
 * module only accepts a `format` parameter as specified in issue #3.
 */

/**
 * Escape the XML metacharacters `& < > "` in an attribute value or text node.
 *
 * Mirrors the helper in tmx-writer.js; kept local so this module stays a
 * self-contained single file (the project keeps every writer independent).
 * Exported for direct unit testing.
 */
function escapeXml(value) {
  return String(value).replace(/[&<>"]/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      /* istanbul ignore next -- unreachable, the regex only matches above */
      default:
        return ch;
    }
  });
}

/**
 * Normalise a user-supplied transparent colour to Tiled's form:
 * 6-digit lowercase `#rrggbb` (Tiled stores `trans` / `transparentcolor`
 * without an alpha channel).
 *
 * Accepts #RGB, #RRGGBB and #AARRGGBB (with or without the leading `#`).
 * Returns undefined for "no colour". Throws for anything unrecognisable so the
 * writer never emits a malformed trans value.
 *
 * Mirrors the helper in tmx-writer.js; kept local so this module stays a
 * self-contained single file. Exported for direct unit testing.
 */
function normalizeTransparentColor(color) {
  if (color === undefined || color === null || color === '') return undefined;

  let c = String(color).trim();
  if (c[0] !== '#') c = `#${c}`;

  // #AARRGGBB -> #RRGGBB (drop the alpha prefix).
  if (/^#[0-9a-fA-F]{8}$/.test(c)) c = `#${c.slice(3)}`;
  // #RGB -> #RRGGBB (double each nibble).
  if (/^#[0-9a-fA-F]{3}$/.test(c)) {
    c = `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  }

  if (!/^#[0-9a-fA-F]{6}$/.test(c)) {
    throw new Error(
      `Invalid transparentColor "${color}" (expected #RGB, #RRGGBB or #AARRGGBB).`
    );
  }

  return c.toLowerCase();
}

/**
 * Serialise the tileset as Tiled's TSX (XML) format.
 */
function writeTsx({
  name,
  tileWidth,
  tileHeight,
  imagePath,
  imageWidth,
  imageHeight,
  columns,
  tileCount,
  trans,
}) {
  const safeName = escapeXml(name);
  const safeSource = escapeXml(imagePath);

  // The trans attribute is emitted only when a (normalised) colour exists.
  const imageTag =
    ` <image source="${safeSource}" width="${imageWidth}" height="${imageHeight}"` +
    (trans ? ` trans="${trans}"/>` : '/>');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<tileset version="1.10" tiledversion="1.10.2" name="${safeName}" tilewidth="${tileWidth}" tileheight="${tileHeight}" tilecount="${tileCount}" columns="${columns}">`,
    imageTag,
    '</tileset>',
    '', // trailing newline after </tileset>
  ].join('\n');
}

/**
 * Serialise the tileset as Tiled's TSJ (JSON) format.
 *
 * Object keys are inserted in the order Tiled writes them for image-based
 * tilesets (type, name, tilewidth, tileheight, tilecount, columns, image,
 * imagewidth, imageheight, [transparentcolor], tiles), so JSON.stringify
 * preserves that order. Indentation is a consistent 2 spaces.
 */
function writeTsj({
  name,
  tileWidth,
  tileHeight,
  imagePath,
  imageWidth,
  imageHeight,
  columns,
  tileCount,
  trans,
}) {
  const tileset = {
    type: 'tileset',
    name,
    tilewidth: tileWidth,
    tileheight: tileHeight,
    tilecount: tileCount,
    columns,
    image: imagePath,
    imagewidth: imageWidth,
    imageheight: imageHeight,
  };

  // transparentcolor is omitted entirely when no colour was supplied.
  if (trans !== undefined) tileset.transparentcolor = trans;

  tileset.tiles = [];

  return `${JSON.stringify(tileset, null, 2)}\n`;
}

/**
 * Write the final Tiled tileset document as a string.
 *
 * @param {object} params
 * @param {string} params.name            - tileset name.
 * @param {number} params.tileWidth       - tile width in pixels.
 * @param {number} params.tileHeight      - tile height in pixels.
 * @param {string} params.imagePath       - path to the intermediate image
 *                                          (TMX/PNG), written verbatim.
 * @param {number} params.imageWidth      - image width in pixels.
 * @param {number} params.imageHeight     - image height in pixels.
 * @param {string} [params.transparentColor] - #RGB / #RRGGBB / #AARRGGBB;
 *   when set the TSX <image> gets trans="#rrggbb" and the TSJ gets
 *   "transparentcolor": "#rrggbb" (normalised lowercase).
 * @param {string} params.format          - 'tsx' or 'tsj' (case-insensitive).
 * @returns {string} the complete tileset document (with a trailing newline).
 * @throws {TypeError} on an unknown format or non-positive dimensions.
 */
function writeTileset({
  name,
  tileWidth,
  tileHeight,
  imagePath,
  imageWidth,
  imageHeight,
  transparentColor,
  format,
}) {
  const fmt = String(format).toLowerCase();
  if (fmt !== 'tsx' && fmt !== 'tsj') {
    throw new TypeError(`writeTileset: format must be "tsx" or "tsj", got "${format}"`);
  }

  // Guard the inputs columns/rows are derived from so tilecount is always a
  // finite, meaningful count (never Infinity or negative).
  for (const [key, value] of Object.entries({
    tileWidth,
    tileHeight,
    imageWidth,
    imageHeight,
  })) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new TypeError(`writeTileset: ${key} must be a positive integer, got ${value}`);
    }
  }

  const columns = Math.floor(imageWidth / tileWidth);
  const rows = Math.floor(imageHeight / tileHeight);
  const tileCount = columns * rows;
  const trans = normalizeTransparentColor(transparentColor);

  if (fmt === 'tsx') {
    return writeTsx({
      name,
      tileWidth,
      tileHeight,
      imagePath,
      imageWidth,
      imageHeight,
      columns,
      tileCount,
      trans,
    });
  }
  return writeTsj({
    name,
    tileWidth,
    tileHeight,
    imagePath,
    imageWidth,
    imageHeight,
    columns,
    tileCount,
    trans,
  });
}

module.exports = {
  writeTileset,
  escapeXml,
  normalizeTransparentColor,
};
