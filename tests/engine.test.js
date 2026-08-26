'use strict';

/**
 * Acceptance tests for the autotile engine (issue #2).
 *
 * Run with: node --test tests/engine.test.js   (Node >= 18, no deps)
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../engine.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Independently recompute a layout's output dimensions from its tables using
 * the same rules as the original script (row width = sum of sublayout output
 * widths, row height = max of sublayout output heights, outputWidth = max row
 * width, outputHeight = sum of row heights). Used to cross-check the engine.
 */
function computeExpectedDims(layout) {
  const widths = [];
  let height = 0;
  for (let row = 0; row < layout.autotiles.length; ++row) {
    widths[row] = 0;
    let curHeight = 0;
    for (let sub = 0; sub < layout.autotiles[row].length; ++sub) {
      const sublayout = layout.autotiles[row][sub];
      widths[row] += sublayout.outputWidth;
      curHeight = Math.max(curHeight, sublayout.outputHeight);
    }
    height += curHeight;
  }
  return { outputWidth: Math.max(...widths), outputHeight: height };
}

// ---------------------------------------------------------------------------
// Table integrity guards
// ---------------------------------------------------------------------------

test('T has 49 combinations with entries 41 and 48 empty', () => {
  assert.equal(engine.T.combinations.length, 49);
  assert.deepEqual(engine.T.combinations[41], []);
  assert.deepEqual(engine.T.combinations[48], []);
  assert.equal(engine.T.inputWidth, 2);
  assert.equal(engine.T.inputHeight, 3);
  assert.equal(engine.T.outputWidth, 7);
  assert.equal(engine.T.outputHeight, 7);
});

test('every non-empty T combination is a 4-tuple of [x, y] pairs', () => {
  engine.T.combinations.forEach((def, i) => {
    if (i === 41 || i === 48) return;
    assert.equal(def.length, 4, `T combination ${i} must have 4 subtiles`);
    for (const pair of def) {
      assert.ok(Array.isArray(pair) && pair.length === 2, `T combination ${i} has a bad pair`);
      assert.ok(Number.isInteger(pair[0]) && Number.isInteger(pair[1]));
    }
  });
});

test('W has 16 combinations', () => {
  assert.equal(engine.W.combinations.length, 16);
  assert.equal(engine.W.inputWidth, 2);
  assert.equal(engine.W.inputHeight, 2);
  assert.equal(engine.W.outputWidth, 4);
  assert.equal(engine.W.outputHeight, 4);
});

test('U has 6 combinations', () => {
  assert.equal(engine.U.combinations.length, 6);
  assert.equal(engine.U.inputWidth, 2);
  assert.equal(engine.U.inputHeight, 3);
  assert.equal(engine.U.outputWidth, 2);
  assert.equal(engine.U.outputHeight, 3);
});

// ---------------------------------------------------------------------------
// Layout output dimensions
// ---------------------------------------------------------------------------

test('A2 output dims are 56x28 (grid 112x56)', () => {
  assert.equal(engine.LAYOUTS.A2.outputWidth, 56);
  assert.equal(engine.LAYOUTS.A2.outputHeight, 28);

  const grid = engine.expand(engine.LAYOUTS.A2, 32, 24);
  assert.equal(grid.length, engine.LAYOUTS.A2.outputHeight * 2); // 56
  assert.equal(grid[0].length, engine.LAYOUTS.A2.outputWidth * 2); // 112
});

test('A3 output dims are 32x16 (grid 64x32)', () => {
  assert.equal(engine.LAYOUTS.A3.outputWidth, 32);
  assert.equal(engine.LAYOUTS.A3.outputHeight, 16);

  const grid = engine.expand(engine.LAYOUTS.A3, 32, 16);
  assert.equal(grid.length, engine.LAYOUTS.A3.outputHeight * 2); // 32
  assert.equal(grid[0].length, engine.LAYOUTS.A3.outputWidth * 2); // 64
});

for (const name of ['A1', 'A2', 'A3', 'A4']) {
  test(`${name} output dims match an independent computation from the tables`, () => {
    const layout = engine.LAYOUTS[name];
    const expected = computeExpectedDims(layout);
    assert.equal(layout.outputWidth, expected.outputWidth, `${name} outputWidth`);
    assert.equal(layout.outputHeight, expected.outputHeight, `${name} outputHeight`);
  });
}

test('A1 output dims (grid == outputWidth*2 x outputHeight*2)', () => {
  const layout = engine.LAYOUTS.A1;
  // 7*T(7) + U(2) = 51 wide; four rows of height 7 = 28 tall.
  assert.equal(layout.outputWidth, 51);
  assert.equal(layout.outputHeight, 28);

  const grid = engine.expand(layout, 32, 24);
  assert.equal(grid.length, layout.outputHeight * 2); // 56
  assert.equal(grid[0].length, layout.outputWidth * 2); // 102
});

test('A4 output dims (grid == outputWidth*2 x outputHeight*2)', () => {
  const layout = engine.LAYOUTS.A4;
  // T rows are 56 wide / 7 tall, W rows are 32 wide / 4 tall.
  assert.equal(layout.outputWidth, 56);
  assert.equal(layout.outputHeight, 33); // 3*7 + 3*4

  const grid = engine.expand(layout, 32, 30);
  assert.equal(grid.length, layout.outputHeight * 2); // 66
  assert.equal(grid[0].length, layout.outputWidth * 2); // 112
});

// ---------------------------------------------------------------------------
// A2 expansion: exact subtile indices
// ---------------------------------------------------------------------------

test('A2 expansion yields exact subtile indices at known positions (32x24)', () => {
  const layout = engine.LAYOUTS.A2;
  const grid = engine.expand(layout, 32, 24);

  // Row 0, column 0 sublayout: source offset (0, 0) subtiles.
  // Output tile (0,0) uses T combo 0 = [[0,2],[1,3],[1,2],[0,3]]:
  assert.equal(grid[0][0], 64); // tl  = 0 + 0 + (0+2)*32
  assert.equal(grid[1][1], 97); // br  = 0 + 1 + (0+3)*32
  assert.equal(grid[1][0], 96); // bl  = 0 + 0 + (0+3)*32
  assert.equal(grid[0][1], 65); // tr  = 0 + 1 + (0+2)*32

  // Row 0, column 7 sublayout: sourceX = 7*2*2 = 28 subtiles, outputX = 98 cells.
  // Output tile (0,0) of that sublayout uses the same combo 0:
  assert.equal(grid[0][98], 92); // tl = 28 + 0 + 2*32
  assert.equal(grid[1][99], 125); // br = 28 + 1 + 3*32
  assert.equal(grid[1][98], 124); // bl = 28 + 0 + 3*32
  assert.equal(grid[0][99], 93); // tr = 28 + 1 + 2*32

  // Row 1, column 0 sublayout: sourceY = 3*2 = 6 subtiles, outputY = 14 cells.
  assert.equal(grid[14][0], 256); // tl = 0 + 0 + (6+2)*32
  assert.equal(grid[15][1], 289); // br = 0 + 1 + (6+3)*32
  assert.equal(grid[15][0], 288); // bl = 0 + 0 + (6+3)*32
  assert.equal(grid[14][1], 257); // tr = 0 + 1 + (6+2)*32
});

test('A2 empty-combo cells are null', () => {
  const grid = engine.expand(engine.LAYOUTS.A2, 32, 24);

  // T combo 41 is empty -> output tile (x=41%7=6, y=41/7=5) -> cells (12..13, 10..11).
  for (const y of [10, 11]) {
    for (const x of [12, 13]) {
      assert.equal(grid[y][x], null, `grid[${y}][${x}] should be null (empty combo 41)`);
    }
  }

  // T combo 48 is empty -> output tile (x=48%7=6, y=48/7=6) -> cells (12..13, 12..13).
  for (const y of [12, 13]) {
    for (const x of [12, 13]) {
      assert.equal(grid[y][x], null, `grid[${y}][${x}] should be null (empty combo 48)`);
    }
  }
});

// ---------------------------------------------------------------------------
// Layout detection
// ---------------------------------------------------------------------------

test('detectLayout auto: 32x16 -> A3, 32x30 -> A4', () => {
  assert.equal(engine.detectLayout(32, 16, 'auto'), engine.LAYOUTS.A3);
  assert.equal(engine.detectLayout(32, 30, 'auto'), engine.LAYOUTS.A4);
});

test('detectLayout auto: 32x24 raises the ambiguous-layout Error', () => {
  assert.throws(
    () => engine.detectLayout(32, 24, 'auto'),
    /Ambiguous layout: 32x24 subtiles can be A1 \(animated\) or A2 \(ground\)\. Re-run with --layout a1 or --layout a2\./
  );
});

test('detectLayout auto: unsupported dimensions raise Error', () => {
  assert.throws(
    () => engine.detectLayout(48, 40, 'auto'),
    /Unsupported tileset dimensions 48x40 subtiles \(expected 32x24, 32x16, or 32x30\)\./
  );
});

test('detectLayout explicit layouts return the matching layout', () => {
  assert.equal(engine.detectLayout(32, 24, 'a1'), engine.LAYOUTS.A1);
  assert.equal(engine.detectLayout(32, 24, 'a2'), engine.LAYOUTS.A2);
  assert.equal(engine.detectLayout(32, 16, 'a3'), engine.LAYOUTS.A3);
  assert.equal(engine.detectLayout(32, 30, 'a4'), engine.LAYOUTS.A4);
});

test('detectLayout explicit layouts are case-insensitive', () => {
  assert.equal(engine.detectLayout(32, 24, 'A1'), engine.LAYOUTS.A1);
  assert.equal(engine.detectLayout(32, 30, 'A4'), engine.LAYOUTS.A4);
});

test('detectLayout explicit mismatch raises Error listing expected dimensions', () => {
  assert.throws(() => engine.detectLayout(48, 40, 'a1'), /32x24/);
  assert.throws(() => engine.detectLayout(48, 40, 'a2'), /32x24/);
  assert.throws(() => engine.detectLayout(48, 40, 'a3'), /32x16/);
  assert.throws(() => engine.detectLayout(48, 40, 'a4'), /32x30/);
  // Correct dims with the wrong explicit layout are still rejected.
  assert.throws(() => engine.detectLayout(32, 16, 'a1'), /32x24/);
});

test('detectLayout rejects unknown layout args', () => {
  assert.throws(() => engine.detectLayout(32, 24, 'bogus'), /Unknown layout/);
});

// ---------------------------------------------------------------------------
// A1 U sublayout placement
// ---------------------------------------------------------------------------

test('A1 uses U sublayouts in the expected columns (U region spot-check)', () => {
  const layout = engine.LAYOUTS.A1;
  const grid = engine.expand(layout, 32, 24);

  // Row 0, U sublayout is column 7: source offset (28, 0) subtiles, output
  // cells x = 98..99, y = 0..5 (U is only 3 output tiles tall).
  // U combo 0 = [[0,0],[1,1],[1,0],[0,1]]:
  assert.equal(grid[0][98], 28); // tl = 28 + 0 + (0+0)*32
  assert.equal(grid[1][99], 61); // br = 28 + 1 + (0+1)*32
  assert.equal(grid[1][98], 60); // bl = 28 + 0 + (0+1)*32
  assert.equal(grid[0][99], 29); // tr = 28 + 1 + (0+0)*32

  // Row 1, U sublayout: source offset (28, 6) subtiles, output y = 14.
  assert.equal(grid[14][98], 220); // tl = 28 + 0 + (6+0)*32
  assert.equal(grid[15][99], 253); // br = 28 + 1 + (6+1)*32
  assert.equal(grid[15][98], 252); // bl = 28 + 0 + (6+1)*32
  assert.equal(grid[14][99], 221); // tr = 28 + 1 + (6+0)*32

  // The U sublayout only fills the top 6 cells of its 14-cell-tall row; the
  // cells below it in the same column stay null (matching the original).
  assert.equal(grid[6][98], null);
  assert.equal(grid[6][99], null);
  assert.equal(grid[13][98], null);
  assert.equal(grid[13][99], null);

  // Row 2 has U at column 3 (T,T,T,U,...): outputX = 3*7*2 = 42 cells,
  // sourceX = 3 T sublayouts * 2 full tiles * 2 subtiles = 12 subtiles,
  // sourceY = 2 rows * 3 full tiles * 2 subtiles = 12 subtiles.
  assert.equal(grid[28][42], 396); // tl = 12 + 0 + (12+0)*32
  assert.equal(grid[29][43], 429); // br = 12 + 1 + (12+1)*32
  assert.equal(grid[28][43], 397); // tr = 12 + 1 + (12+0)*32
  assert.equal(grid[29][42], 428); // bl = 12 + 0 + (12+1)*32
});

// ---------------------------------------------------------------------------
// Dimension helpers
// ---------------------------------------------------------------------------

test('subtileDimensions derives subtile counts from pixel sizes', () => {
  const d = engine.subtileDimensions(512, 384, 32, 32);
  assert.deepEqual(d, {
    subtileWidth: 16,
    subtileHeight: 16,
    tilesetWidth: 32,
    tilesetHeight: 24,
  });

  const d2 = engine.subtileDimensions(512, 256, 32, 32);
  assert.deepEqual(d2, {
    subtileWidth: 16,
    subtileHeight: 16,
    tilesetWidth: 32,
    tilesetHeight: 16,
  });
});

test('subtileDimensions rejects tile sizes that cannot contain subtiles', () => {
  assert.throws(() => engine.subtileDimensions(100, 100, 1, 1), /at least 2x2/);
  assert.throws(() => engine.subtileDimensions(100, 100, 16, 1), /at least 2x2/);
});
