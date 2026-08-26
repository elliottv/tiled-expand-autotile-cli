'use strict';

/**
 * tmx-writer.js
 *
 * Writes the intermediate TMX "metatileset" map produced when the CLI is asked
 * for `--intermediate-format tmx` (issue #4).
 *
 * The expanded subtile grid (from engine.expand) is serialised as a Tiled map
 * containing a single tile layer. Every cell in that layer carries a GID that
 * indexes into a Tileset whose image is the SOURCE image, so the resulting .tmx
 * opens directly in Tiled and can be used as the image source for the final
 * expanded Tileset. In other words this is the map representation of the
 * "expanded" image, with the source image standing in as the tileset image.
 *
 * This module is deliberately pure: `writeTmx` returns the XML as a single
 * string and never touches the filesystem.
 *
 * Output shape (Tiled 1.10/1.11 compatible):
 *
 *   <?xml version="1.0" encoding="UTF-8"?>
 *   <map version="1.10" tiledversion="1.10.2" orientation="orthogonal"
 *        renderorder="right-down" width="<gridW>" height="<gridH>"
 *        tilewidth="<subtileWidth>" tileheight="<subtileHeight>" infinite="0"
 *        nextlayerid="2" nextobjectid="1">
 *    <tileset firstgid="1" name="<name> Subtiles" tilewidth="<subtileWidth>"
 *             tileheight="<subtileHeight>" tilecount="<tilesetWidth*tilesetHeight>"
 *             columns="<tilesetWidth>">
 *     <image source="<sourceImagePath>" width="<imageWidth>"
 *            height="<imageHeight>" [trans="#rrggbb"]/>
 *    </tileset>
 *    <layer id="1" name="<name> Expanded" width="<gridW>" height="<gridH>">
 *     <data encoding="csv">
 *      1,2,0,3,
 *      4,0,5,6,
 *     </data>
 *    </layer>
 *   </map>
 *
 * GIDs are 1-based: a cell holding source subtile index `n` is written as
 * `n + 1`; an empty cell (null / undefined) is written as `0`. The CSV data
 * block uses Tiled's own layout: one line per row, each row ending with a
 * trailing comma and newline.
 */

/** Exported for direct unit testing; used internally by writeTmx. */
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
 * Normalise a user-supplied transparent colour to Tiled's `trans` form:
 * 6-digit lowercase `#rrggbb` (Tiled stores `trans` without an alpha channel).
 *
 * Accepts #RGB, #RRGGBB and #AARRGGBB (with or without the leading `#`).
 * Returns undefined for "no colour". Throws for anything unrecognisable so the
 * writer never emits a malformed `trans` attribute.
 *
 * Exported for direct unit testing.
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
 * Serialise the expanded subtile grid as an intermediate TMX map.
 *
 * @param {object} params
 * @param {string} params.name            - tileset name (used for tileset/layer
 *                                          names with " Subtiles"/" Expanded").
 * @param {string} params.sourceImagePath - path written verbatim into <image
 *                                          source="..."> (caller normalises).
 * @param {number} params.imageWidth      - source image width in pixels.
 * @param {number} params.imageHeight     - source image height in pixels.
 * @param {number} params.subtileWidth    - subtile width in pixels.
 * @param {number} params.subtileHeight   - subtile height in pixels.
 * @param {number} params.tilesetWidth    - source tileset width in subtiles.
 * @param {number} params.tilesetHeight   - source tileset height in subtiles.
 * @param {Array<Array<number|null>>} params.grid
 *   Row-major expanded subtile grid (grid[y][x]); each cell is a source
 *   subtile index or null where the combination was empty.
 * @param {string} [params.transparentColor] - #RGB / #RRGGBB / #AARRGGBB; when
 *   set the <image> gets a trans="#rrggbb" attribute (normalised lowercase).
 * @returns {string} the complete TMX document (with a trailing newline).
 */
function writeTmx({
  name,
  sourceImagePath,
  imageWidth,
  imageHeight,
  subtileWidth,
  subtileHeight,
  tilesetWidth,
  tilesetHeight,
  grid,
  transparentColor,
}) {
  const gridHeight = grid.length;
  const gridWidth = gridHeight > 0 ? grid[0].length : 0;

  const safeName = escapeXml(name);
  const safeSource = escapeXml(sourceImagePath);
  const trans = normalizeTransparentColor(transparentColor);

  const tileCount = tilesetWidth * tilesetHeight;
  const imageTag =
    `  <image source="${safeSource}" width="${imageWidth}" height="${imageHeight}"` +
    (trans ? ` trans="${trans}"/>` : '/>');

  // One line per row, trailing comma + newline after each row (Tiled's own
  // CSV layout). GID = subtileIndex + 1; empty cell -> 0.
  const rows = [];
  for (let y = 0; y < gridHeight; ++y) {
    const cells = [];
    for (let x = 0; x < gridWidth; ++x) {
      const subtileIndex = grid[y][x];
      cells.push(subtileIndex == null ? 0 : subtileIndex + 1);
    }
    rows.push(`${cells.join(',')},`);
  }

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<map version="1.10" tiledversion="1.10.2" orientation="orthogonal" renderorder="right-down" width="${gridWidth}" height="${gridHeight}" tilewidth="${subtileWidth}" tileheight="${subtileHeight}" infinite="0" nextlayerid="2" nextobjectid="1">`,
    ` <tileset firstgid="1" name="${safeName} Subtiles" tilewidth="${subtileWidth}" tileheight="${subtileHeight}" tilecount="${tileCount}" columns="${tilesetWidth}">`,
    imageTag,
    ' </tileset>',
    ` <layer id="1" name="${safeName} Expanded" width="${gridWidth}" height="${gridHeight}">`,
    '  <data encoding="csv">',
    rows.join('\n'),
    '  </data>',
    ' </layer>',
    '</map>',
    '', // trailing newline after </map>
  ];

  return lines.join('\n');
}

module.exports = {
  writeTmx,
  escapeXml,
  normalizeTransparentColor,
};
