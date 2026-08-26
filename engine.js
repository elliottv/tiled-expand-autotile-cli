'use strict';

/**
 * engine.js
 *
 * Pure-JS port of the RPG Maker autotile mapping logic from eishiya's
 * "Expand RPG Maker Tileset" script (ExpandRPGMTileset.js):
 *   https://github.com/eishiya/tiled-expand-autotile/blob/main/ExpandRPGMTileset.js
 *
 * The subtile -> tile combination tables originate from devium's Python script
 * (https://github.com/devium/tiled-autotile), so tilesets produced with this
 * engine are layout-compatible with tilesets produced by either of those tools.
 *
 * Story (issue #2): Autotile layout data & expansion engine.
 *
 * This module is deliberately pure: no I/O, no globals. It exports:
 *
 *   T, W, U                          - the sublayout combination tables
 *   LAYOUTS                          - A1/A2/A3/A4 layout definitions
 *   computeLayoutDimensions(layout)  - outputWidth/outputHeight of a layout
 *   detectLayout(w, h, arg)          - pick a layout from subtile dimensions
 *   expand(layout, tilesetW, tilesetH) - produce the expanded subtile grid
 *   subtileDimensions(imgW, imgH, tileW, tileH) - dimension helpers
 *
 * Terminology (as in the original script):
 *  - A "sublayout" (T/W/U) is a small autotile subsheet inside the source
 *    tileset. Its input is `inputWidth x inputHeight` FULL tiles, each full
 *    tile being 2x2 subtiles. Its output is `outputWidth x outputHeight`
 *    tiles in the expanded sheet, each output tile being 2x2 subtiles.
 *  - A "layout" (A1/A2/A3/A4) is a fixed grid of sublayouts arranged exactly
 *    as the RPG Maker source tileset is organised.
 */

// ---------------------------------------------------------------------------
// Sublayout combination tables
//
// Each combination is [tl, br, tr, bl]: the four subtile coordinates (x, y)
// within the sublayout's `inputWidth x inputHeight` subtile subsheet that make
// up one output tile. An empty [] means "this output tile produces nothing"
// and leaves a 2x2 gap in the expanded grid.
// These tables are ported EXACTLY from the original script - do not alter.
// ---------------------------------------------------------------------------

/** Terrain (water, ground, etc). 49 combinations, indices 41 and 48 empty. */
const T = {
  inputWidth: 2,
  inputHeight: 3,
  outputWidth: 7,
  outputHeight: 7,
  combinations: [
    [[0, 2], [1, 3], [1, 2], [0, 3]],
    [[2, 2], [1, 3], [1, 2], [2, 3]],
    [[2, 2], [3, 3], [3, 2], [2, 3]],
    [[0, 2], [3, 3], [3, 2], [0, 3]],
    [[2, 4], [3, 1], [1, 4], [2, 3]],
    [[2, 4], [3, 1], [1, 4], [2, 1]],
    [[2, 4], [1, 3], [1, 4], [2, 1]],
    [[0, 4], [1, 3], [1, 4], [0, 3]],
    [[2, 4], [1, 3], [1, 4], [2, 3]],
    [[2, 4], [3, 3], [3, 4], [2, 3]],
    [[0, 4], [3, 3], [3, 4], [0, 3]],
    [[2, 4], [3, 1], [3, 0], [2, 3]],
    [[2, 0], [3, 1], [3, 0], [2, 1]],
    [[2, 0], [1, 3], [1, 4], [2, 1]],
    [[0, 4], [1, 5], [1, 4], [0, 5]],
    [[2, 4], [1, 5], [1, 4], [2, 5]],
    [[2, 4], [3, 5], [3, 4], [2, 5]],
    [[0, 4], [3, 5], [3, 4], [0, 5]],
    [[2, 4], [1, 3], [3, 0], [2, 3]],
    [[2, 0], [1, 3], [3, 0], [2, 3]],
    [[2, 0], [1, 3], [1, 4], [2, 3]],
    [[0, 2], [1, 5], [1, 2], [0, 5]],
    [[2, 2], [1, 5], [1, 2], [2, 5]],
    [[2, 2], [3, 5], [3, 2], [2, 5]],
    [[0, 2], [3, 5], [3, 2], [0, 5]],
    [[2, 2], [3, 1], [1, 2], [2, 3]],
    [[2, 2], [3, 1], [1, 2], [2, 1]],
    [[2, 2], [1, 3], [1, 2], [2, 1]],
    [[0, 4], [3, 1], [1, 4], [0, 3]],
    [[2, 4], [3, 3], [3, 4], [2, 1]],
    [[2, 0], [3, 1], [1, 4], [2, 3]],
    [[2, 4], [1, 3], [3, 0], [2, 1]],
    [[2, 4], [1, 5], [3, 0], [2, 5]],
    [[2, 0], [1, 5], [3, 0], [2, 5]],
    [[2, 0], [1, 5], [1, 4], [2, 5]],
    [[0, 4], [3, 1], [3, 0], [0, 3]],
    [[2, 0], [3, 3], [3, 4], [2, 1]],
    [[0, 2], [3, 1], [1, 2], [0, 3]],
    [[2, 2], [3, 3], [3, 2], [2, 1]],
    [[2, 4], [3, 1], [3, 0], [2, 1]],
    [[2, 0], [3, 1], [1, 4], [2, 1]],
    [],
    [[0, 4], [1, 3], [3, 0], [0, 3]],
    [[2, 0], [3, 3], [3, 4], [2, 3]],
    [[0, 4], [1, 5], [3, 0], [0, 5]],
    [[2, 0], [3, 5], [3, 4], [2, 5]],
    [[2, 0], [3, 1], [3, 0], [2, 3]],
    [[2, 0], [1, 3], [3, 0], [2, 1]],
    [],
  ],
};

/** Wall (top acts like terrain, bottom is static). 16 combinations. */
const W = {
  inputWidth: 2,
  inputHeight: 2,
  outputWidth: 4,
  outputHeight: 4,
  combinations: [
    [[0, 0], [1, 1], [1, 0], [0, 1]],
    [[2, 0], [1, 1], [1, 0], [2, 1]],
    [[2, 0], [3, 1], [3, 0], [2, 1]],
    [[0, 0], [3, 1], [3, 0], [0, 1]],
    [[0, 2], [1, 1], [1, 2], [0, 1]],
    [[2, 2], [1, 1], [1, 2], [2, 1]],
    [[2, 2], [3, 1], [3, 2], [2, 1]],
    [[0, 2], [3, 1], [3, 2], [0, 1]],
    [[0, 2], [1, 3], [1, 2], [0, 3]],
    [[2, 2], [1, 3], [1, 2], [2, 3]],
    [[2, 2], [3, 3], [3, 2], [2, 3]],
    [[0, 2], [3, 3], [3, 2], [0, 3]],
    [[0, 0], [1, 3], [1, 0], [0, 3]],
    [[2, 0], [1, 3], [1, 0], [2, 3]],
    [[2, 0], [3, 3], [3, 0], [2, 3]],
    [[0, 0], [3, 3], [3, 0], [0, 3]],
  ],
};

/**
 * Unchanged (animated A1 subsheets). The subtiles are simply copied through;
 * still expressed in terms of subtiles. 6 combinations.
 */
const U = {
  inputWidth: 2,
  inputHeight: 3,
  outputWidth: 2,
  outputHeight: 3,
  combinations: [
    [[0, 0], [1, 1], [1, 0], [0, 1]],
    [[2, 0], [3, 1], [3, 0], [2, 1]],
    [[0, 2], [1, 3], [1, 2], [0, 3]],
    [[2, 2], [3, 3], [3, 2], [2, 3]],
    [[0, 4], [1, 5], [1, 4], [0, 5]],
    [[2, 4], [3, 5], [3, 4], [2, 5]],
  ],
};

// ---------------------------------------------------------------------------
// Layouts
//
// A layout is a grid of sublayouts laid out exactly as the source RPG Maker
// tileset is organised. `outputWidth` / `outputHeight` are computed below and
// stored on each layout object (matching the original script's behaviour).
// ---------------------------------------------------------------------------

const LAYOUTS = {
  A1: {
    autotiles: [
      [T, T, T, T, T, T, T, U],
      [T, T, T, T, T, T, T, U],
      [T, T, T, U, T, T, T, U],
      [T, T, T, U, T, T, T, U],
    ],
    outputWidth: 0,
    outputHeight: 0,
  },
  A2: {
    autotiles: [
      [T, T, T, T, T, T, T, T],
      [T, T, T, T, T, T, T, T],
      [T, T, T, T, T, T, T, T],
      [T, T, T, T, T, T, T, T],
    ],
    outputWidth: 0,
    outputHeight: 0,
  },
  A3: {
    autotiles: [
      [W, W, W, W, W, W, W, W],
      [W, W, W, W, W, W, W, W],
      [W, W, W, W, W, W, W, W],
      [W, W, W, W, W, W, W, W],
    ],
    outputWidth: 0,
    outputHeight: 0,
  },
  A4: {
    autotiles: [
      [T, T, T, T, T, T, T, T],
      [W, W, W, W, W, W, W, W],
      [T, T, T, T, T, T, T, T],
      [W, W, W, W, W, W, W, W],
      [T, T, T, T, T, T, T, T],
      [W, W, W, W, W, W, W, W],
    ],
    outputWidth: 0,
    outputHeight: 0,
  },
};

// ---------------------------------------------------------------------------
// Layout dimension computation (identical to the original script)
// ---------------------------------------------------------------------------

/**
 * Compute the expanded output dimensions of a layout.
 *
 * For each row of sublayouts the row width is the sum of the sublayouts'
 * outputWidth values and the row height is the MAX of their outputHeight
 * values. The layout's outputWidth is the maximum row width and its
 * outputHeight is the sum of the row heights.
 *
 * @param {{autotiles: Array<Array<object>>}} layoutDef - layout with `autotiles`.
 * @returns {{outputWidth: number, outputHeight: number}}
 */
function computeLayoutDimensions(layoutDef) {
  const widths = [];
  let height = 0;

  for (let row = 0; row < layoutDef.autotiles.length; ++row) {
    widths[row] = 0;
    let curHeight = 0;
    for (let sub = 0; sub < layoutDef.autotiles[row].length; ++sub) {
      const sublayout = layoutDef.autotiles[row][sub];
      widths[row] += sublayout.outputWidth;
      if (curHeight < sublayout.outputHeight) curHeight = sublayout.outputHeight;
    }
    height += curHeight;
  }

  return { outputWidth: Math.max(...widths), outputHeight: height };
}

// Bake the computed dimensions onto every layout (as the original does).
for (const key of Object.keys(LAYOUTS)) {
  const dims = computeLayoutDimensions(LAYOUTS[key]);
  LAYOUTS[key].outputWidth = dims.outputWidth;
  LAYOUTS[key].outputHeight = dims.outputHeight;
}

// ---------------------------------------------------------------------------
// Layout detection
// ---------------------------------------------------------------------------

/** Expected source subtile dimensions for each explicit layout choice. */
const EXPECTED_DIMENSIONS = {
  a1: { width: 32, height: 24, layout: 'A1' },
  a2: { width: 32, height: 24, layout: 'A2' },
  a3: { width: 32, height: 16, layout: 'A3' },
  a4: { width: 32, height: 30, layout: 'A4' },
};

/**
 * Pick the autotile layout for a source tileset given its size in SUBTILES.
 *
 * The original script prompted the user for the A1/A2 ambiguity; a CLI must
 * not prompt, so that case raises a descriptive Error instead.
 *
 * @param {number} subtileWidthCount  - tileset width in subtiles.
 * @param {number} subtileHeightCount - tileset height in subtiles.
 * @param {string} [layoutArg]        - 'auto' | 'a1' | 'a2' | 'a3' | 'a4'
 *                                      (case-insensitive, defaults to 'auto').
 * @returns {object} one of the LAYOUTS entries.
 * @throws {Error} on ambiguous / unsupported / mismatched dimensions.
 */
function detectLayout(subtileWidthCount, subtileHeightCount, layoutArg) {
  const arg = String(layoutArg === undefined ? 'auto' : layoutArg).toLowerCase();

  if (arg === 'auto') {
    if (subtileWidthCount === 32 && subtileHeightCount === 16) return LAYOUTS.A3;
    if (subtileWidthCount === 32 && subtileHeightCount === 30) return LAYOUTS.A4;
    if (subtileWidthCount === 32 && subtileHeightCount === 24) {
      throw new Error(
        'Ambiguous layout: 32x24 subtiles can be A1 (animated) or A2 (ground). ' +
          'Re-run with --layout a1 or --layout a2.'
      );
    }
    throw new Error(
      `Unsupported tileset dimensions ${subtileWidthCount}x${subtileHeightCount} subtiles ` +
        '(expected 32x24, 32x16, or 32x30).'
    );
  }

  const expected = EXPECTED_DIMENSIONS[arg];
  if (!expected) {
    throw new Error(
      `Unknown layout "${layoutArg}" (expected auto, a1, a2, a3 or a4).`
    );
  }
  if (subtileWidthCount !== expected.width || subtileHeightCount !== expected.height) {
    throw new Error(
      `Layout ${arg} requires ${expected.width}x${expected.height} subtiles, ` +
        `got ${subtileWidthCount}x${subtileHeightCount} subtiles.`
    );
  }
  return LAYOUTS[expected.layout];
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

/**
 * Expand one sublayout into a region of the output grid.
 *
 * Mirrors the original `expandAutotile` exactly: each output tile defined by
 * `[tl, br, tr, bl]` writes four cells of the grid:
 *   (x*2,   y*2)   = tl  (top-left)
 *   (x*2+1, y*2+1) = br  (bottom-right)
 *   (x*2+1, y*2)   = tr  (top-right)
 *   (x*2,   y*2+1) = bl  (bottom-left)
 *
 * The subtile index is `sourceX + def[i][0] + (sourceY + def[i][1]) *
 * tilesetWidth`. Empty `[]` combinations leave their 2x2 region null.
 *
 * @returns {number} the number of output cells this sublayout spans
 *   (outputWidth * 2), matching the original's return value.
 */
function expandAutotile(autotile, grid, targetX, targetY, sourceX, sourceY, tilesetWidth) {
  for (let x = 0; x < autotile.outputWidth; ++x) {
    for (let y = 0; y < autotile.outputHeight; ++y) {
      const tileDef = autotile.combinations[x + y * autotile.outputWidth];
      if (tileDef.length > 3) {
        grid[targetY + y * 2][targetX + x * 2] =
          sourceX + tileDef[0][0] + (sourceY + tileDef[0][1]) * tilesetWidth; // top-left
        grid[targetY + y * 2 + 1][targetX + x * 2 + 1] =
          sourceX + tileDef[1][0] + (sourceY + tileDef[1][1]) * tilesetWidth; // bottom-right
        grid[targetY + y * 2][targetX + x * 2 + 1] =
          sourceX + tileDef[2][0] + (sourceY + tileDef[2][1]) * tilesetWidth; // top-right
        grid[targetY + y * 2 + 1][targetX + x * 2] =
          sourceX + tileDef[3][0] + (sourceY + tileDef[3][1]) * tilesetWidth; // bottom-left
      }
      // Empty combinations leave the 2x2 region as null (the grid starts null).
    }
  }
  return autotile.outputWidth * 2;
}

/**
 * Expand a whole layout into the full output subtile grid.
 *
 * @param {object} layout - a LAYOUTS entry (with `autotiles`, `outputWidth`,
 *   `outputHeight`).
 * @param {number} tilesetWidth  - source tileset width in subtiles.
 * @param {number} tilesetHeight - source tileset height in subtiles (kept for
 *   API parity with the original; the index math only needs tilesetWidth).
 * @returns {Array<Array<number|null>>} `grid[y][x]`, size
 *   `outputHeight*2 x outputWidth*2`. Each cell is a source subtile index or
 *   `null` where a combination was empty (or a U sublayout simply does not
 *   fill the full row height, exactly as the original behaves).
 */
function expand(layout, tilesetWidth, tilesetHeight) {
  const gridWidth = layout.outputWidth * 2;
  const gridHeight = layout.outputHeight * 2;

  const grid = new Array(gridHeight);
  for (let y = 0; y < gridHeight; ++y) {
    grid[y] = new Array(gridWidth).fill(null);
  }

  let outputX = 0;
  let outputY = 0;
  let inputX = 0;
  let inputY = 0;
  let outputRowHeight = 0; // cells tall the current output row is
  let inputRowHeight = 0; // full tiles tall the current input row is

  for (let autotileRow = 0; autotileRow < layout.autotiles.length; ++autotileRow) {
    outputX = 0;
    inputX = 0;
    outputY += outputRowHeight;
    inputY += inputRowHeight;
    outputRowHeight = 0;
    inputRowHeight = 0;

    for (let autotileCol = 0; autotileCol < layout.autotiles[autotileRow].length; ++autotileCol) {
      const autotileDef = layout.autotiles[autotileRow][autotileCol];
      outputX += expandAutotile(
        autotileDef,
        grid,
        outputX,
        outputY,
        inputX * 2,
        inputY * 2,
        tilesetWidth
      );
      inputX += autotileDef.inputWidth;
      outputRowHeight = Math.max(outputRowHeight, autotileDef.outputHeight * 2);
      inputRowHeight = Math.max(inputRowHeight, autotileDef.inputHeight);
    }
  }

  return grid;
}

// ---------------------------------------------------------------------------
// Dimension helpers
// ---------------------------------------------------------------------------

/**
 * Derive subtile/tileset dimensions from pixel sizes, exactly like the
 * original script:
 *   subtileWidth  = floor(tileWidth  / 2)
 *   subtileHeight = floor(tileHeight / 2)
 *   tilesetWidth  = floor(imageWidth  / subtileWidth)
 *   tilesetHeight = floor(imageHeight / subtileHeight)
 *
 * @returns {{subtileWidth: number, subtileHeight: number,
 *            tilesetWidth: number, tilesetHeight: number}}
 */
function subtileDimensions(imageWidth, imageHeight, tileWidth, tileHeight) {
  const subtileWidth = Math.floor(tileWidth / 2);
  const subtileHeight = Math.floor(tileHeight / 2);

  if (subtileWidth === 0 || subtileHeight === 0) {
    throw new Error(
      `Tile size must be at least 2x2 pixels to contain subtiles, got ${tileWidth}x${tileHeight}.`
    );
  }

  return {
    subtileWidth,
    subtileHeight,
    tilesetWidth: Math.floor(imageWidth / subtileWidth),
    tilesetHeight: Math.floor(imageHeight / subtileHeight),
  };
}

module.exports = {
  T,
  W,
  U,
  LAYOUTS,
  computeLayoutDimensions,
  detectLayout,
  expand,
  subtileDimensions,
};
