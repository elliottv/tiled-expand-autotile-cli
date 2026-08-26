'use strict';

/**
 * End-to-end acceptance tests for the fully wired CLI (issue #8).
 *
 * These tests run the real `tiled-expand-autotile-cli.js` as a subprocess with
 * stdin CLOSED (so they also prove the CLI never blocks on an interactive
 * prompt) and assert on the actual files it writes: the intermediate
 * TMX/PNG and the final TSX/TSJ tileset.
 *
 * Synthetic fixtures are built in-test with UNIQUE-colour 16px subtiles using
 * the story-5 encoder, so we can verify both the CSV GIDs (against the
 * story-3 engine's expand() output) and, for the PNG intermediate path, the
 * actual sampled output pixels map back to the correct source subtiles.
 *
 * Run with: node --test tests/e2e.test.js   (Node >= 18, no third-party deps)
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cliPath = path.join(__dirname, '..', 'tiled-expand-autotile-cli.js');
const { encodePng } = require('../png-writer.js');
const { decodePng, getPixel } = require('../png-decode.js');
const { LAYOUTS, expand } = require('../engine.js');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Every fixture subtile is 16px (the story-5 encoder's example size). */
const SUBTILE = 16;

/** A2 needs 32x24 subtiles -> 512x384 px source image. */
const A2_SUB_W = 32;
const A2_SUB_H = 24;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run the CLI in a subprocess with stdin CLOSED; capture stdout/stderr/status. */
function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'], // stdin closed, stdout/stderr piped
    timeout: 15000,
  });
}

/** Create a fresh, empty temporary directory for one test's files. */
function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tiled-expand-autotile-e2e-'));
}

/**
 * Build a synthetic source image: `subtilesW x subtilesH` subtiles, each
 * `subtileSize` px, every subtile filled with a UNIQUE opaque colour so an
 * expanded output pixel can always be traced back to the source subtile that
 * produced it. Encoded with the story-5 encoder.
 */
function makeSourceImage(subtilesW, subtilesH, subtileSize = SUBTILE) {
  const width = subtilesW * subtileSize;
  const height = subtilesH * subtileSize;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.floor(x / subtileSize);
      const sy = Math.floor(y / subtileSize);
      const idx = sy * subtilesW + sx;
      const o = (y * width + x) * 4;
      pixels[o] = idx % 256; // unique within each 256-subtile band...
      pixels[o + 1] = Math.floor(idx / 256); // ...unique across bands
      pixels[o + 2] = 0;
      pixels[o + 3] = 255;
    }
  }
  return { width, height, pixels };
}

/** Write a synthetic source PNG into `dir` and return its absolute path. */
function makeSourceFile(dir, subtilesW, subtilesH, name = 'tileset.png', subtileSize = SUBTILE) {
  const file = path.join(dir, name);
  const img = makeSourceImage(subtilesW, subtilesH, subtileSize);
  fs.writeFileSync(file, encodePng(img));
  return file;
}

/** Extract a single attribute value from the first matching tag in `xml`. */
function attr(xml, tagName, attrName) {
  const re = new RegExp(`<${tagName}\\b[^>]*\\b${attrName}="([^"]*)"`);
  const m = xml.match(re);
  return m === null ? undefined : m[1];
}

/** Parse the CSV GID block of a TMX into a 2D array of numbers. */
function parseCsv(tmx) {
  const m = tmx.match(/<data[^>]*>\n([\s\S]*?)\n\s*<\/data>/);
  assert.ok(m, 'TMX should contain a <data> CSV block');
  return m[1]
    .trim()
    .split('\n')
    .map((line) =>
      line
        .split(',')
        .filter((cell) => cell !== '')
        .map(Number)
    );
}

/**
 * Assert a TMX CSV block exactly matches the story-3 engine's expanded grid:
 * GID = source subtile index + 1, empty (null) cells become 0.
 */
function assertCsvMatchesEngine(tmx, layout, tilesetWidth, tilesetHeight) {
  const grid = expand(layout, tilesetWidth, tilesetHeight);
  const csv = parseCsv(tmx);
  assert.equal(csv.length, grid.length, 'CSV row count should match grid height');
  for (let y = 0; y < grid.length; y++) {
    assert.equal(csv[y].length, grid[y].length, `CSV row ${y} should have grid width cells`);
    for (let x = 0; x < grid[y].length; x++) {
      const expected = grid[y][x] == null ? 0 : grid[y][x] + 1;
      assert.equal(csv[y][x], expected, `GID at grid (${x},${y}) should match the engine`);
    }
  }
}

/**
 * Assert that the centre pixel of every non-empty expanded output cell equals
 * the centre pixel of the source subtile the grid says it came from.
 */
function assertSampledPixelsMatchSource(
  outputPngPath,
  sourcePngPath,
  layout,
  tilesetWidth,
  tilesetHeight,
  subtileSize = SUBTILE
) {
  const out = decodePng(fs.readFileSync(outputPngPath));
  const src = decodePng(fs.readFileSync(sourcePngPath));
  const grid = expand(layout, tilesetWidth, tilesetHeight);
  const half = Math.floor(subtileSize / 2);

  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[y].length; x++) {
      const idx = grid[y][x];
      if (idx === null || idx === undefined) continue; // empty cell -> transparent
      const sx = idx % tilesetWidth;
      const sy = Math.floor(idx / tilesetWidth);
      const expected = getPixel(
        src.pixels,
        src.width,
        sx * subtileSize + half,
        sy * subtileSize + half
      );
      const actual = getPixel(
        out.pixels,
        out.width,
        x * subtileSize + half,
        y * subtileSize + half
      );
      assert.deepEqual(
        actual,
        expected,
        `centre pixel at expanded (${x},${y}) should match source subtile ${idx}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// A2 -> intermediate TMX
// ---------------------------------------------------------------------------

test('A2 32x24 subtiles: intermediate TMX (map 112x56) + final TSX (32/32)', (t) => {
  const dir = makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const src = makeSourceFile(dir, A2_SUB_W, A2_SUB_H); // 512x384 px
  const out = path.join(dir, 'out.tsx');
  const result = runCli([
    '--source', src,
    '--tile-width', '32',
    '--tile-height', '32',
    '--output', out,
    '--layout', 'a2',
    '--intermediate-format', 'tmx',
  ]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);

  // Concise success summary on stdout: intermediate path + final tileset path.
  const intermediate = path.join(dir, 'tileset.tmx'); // default path next to source
  assert.ok(result.stdout.includes(`Intermediate: ${intermediate}`), result.stdout);
  assert.ok(result.stdout.includes(`Tileset: ${out}`), result.stdout);

  // Intermediate TMX exists with map dims 112x56.
  assert.ok(fs.existsSync(intermediate), 'intermediate TMX should exist');
  const tmx = fs.readFileSync(intermediate, 'utf8');
  assert.equal(attr(tmx, 'map', 'width'), '112');
  assert.equal(attr(tmx, 'map', 'height'), '56');

  // Correct <image> attrs: source path as provided (normalized) + source dims.
  assert.equal(attr(tmx, 'image', 'source'), path.normalize(src));
  assert.equal(attr(tmx, 'image', 'width'), '512');
  assert.equal(attr(tmx, 'image', 'height'), '384');

  // CSV GIDs match the story-3 engine output exactly.
  assertCsvMatchesEngine(tmx, LAYOUTS.A2, A2_SUB_W, A2_SUB_H);

  // Final TSX: tilewidth/tileheight 32/32 and references the intermediate.
  assert.ok(fs.existsSync(out), 'final TSX should exist');
  const tsx = fs.readFileSync(out, 'utf8');
  assert.equal(attr(tsx, 'tileset', 'tilewidth'), '32');
  assert.equal(attr(tsx, 'tileset', 'tileheight'), '32');
  assert.equal(attr(tsx, 'image', 'source'), intermediate);
  assert.equal(attr(tsx, 'image', 'width'), '1792');
  assert.equal(attr(tsx, 'image', 'height'), '896');
});

// ---------------------------------------------------------------------------
// A2 -> intermediate PNG
// ---------------------------------------------------------------------------

test('A2 32x24 subtiles: intermediate PNG (1792x896) with correct sampled pixels', (t) => {
  const dir = makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const src = makeSourceFile(dir, A2_SUB_W, A2_SUB_H); // 512x384 px
  const out = path.join(dir, 'out.tsx');
  const result = runCli([
    '--source', src,
    '--tile-width', '32',
    '--tile-height', '32',
    '--output', out,
    '--layout', 'a2',
    '--intermediate-format', 'png',
  ]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);

  const intermediate = path.join(dir, 'tileset_expanded.png'); // default PNG path
  assert.ok(fs.existsSync(intermediate), 'intermediate PNG should exist');

  const decoded = decodePng(fs.readFileSync(intermediate));
  assert.equal(decoded.width, 1792);
  assert.equal(decoded.height, 896);

  // Every non-empty expanded cell must sample back to the right source subtile.
  assertSampledPixelsMatchSource(intermediate, src, LAYOUTS.A2, A2_SUB_W, A2_SUB_H);

  // Final TSX references the PNG.
  const tsx = fs.readFileSync(out, 'utf8');
  assert.equal(attr(tsx, 'image', 'source'), intermediate);
  assert.equal(attr(tsx, 'image', 'width'), '1792');
  assert.equal(attr(tsx, 'image', 'height'), '896');
});

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

test('default --name is the source basename; explicit --name is honoured everywhere', (t) => {
  // Default name: source 'tileset.png' -> 'tileset'.
  const dirA = makeTempDir();
  t.after(() => fs.rmSync(dirA, { recursive: true, force: true }));
  const srcA = makeSourceFile(dirA, A2_SUB_W, A2_SUB_H);
  let result = runCli([
    '--source', srcA,
    '--tile-width', '32',
    '--tile-height', '32',
    '--output', path.join(dirA, 'out.tsx'),
    '--layout', 'a2',
  ]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  let tmx = fs.readFileSync(path.join(dirA, 'tileset.tmx'), 'utf8');
  let tsx = fs.readFileSync(path.join(dirA, 'out.tsx'), 'utf8');
  assert.equal(attr(tsx, 'tileset', 'name'), 'tileset');
  assert.equal(attr(tmx, 'tileset', 'name'), 'tileset Subtiles');
  assert.equal(attr(tmx, 'layer', 'name'), 'tileset Expanded');

  // Explicit name: 'MySet' appears in the TSX name and the TMX tileset/layer.
  const dirB = makeTempDir();
  t.after(() => fs.rmSync(dirB, { recursive: true, force: true }));
  const srcB = makeSourceFile(dirB, A2_SUB_W, A2_SUB_H);
  result = runCli([
    '--source', srcB,
    '--tile-width', '32',
    '--tile-height', '32',
    '--output', path.join(dirB, 'out.tsx'),
    '--layout', 'a2',
    '--name', 'MySet',
  ]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  tmx = fs.readFileSync(path.join(dirB, 'tileset.tmx'), 'utf8');
  tsx = fs.readFileSync(path.join(dirB, 'out.tsx'), 'utf8');
  assert.equal(attr(tsx, 'tileset', 'name'), 'MySet');
  assert.equal(attr(tmx, 'tileset', 'name'), 'MySet Subtiles');
  assert.equal(attr(tmx, 'layer', 'name'), 'MySet Expanded');
});

// ---------------------------------------------------------------------------
// Transparent colour
// ---------------------------------------------------------------------------

test('--transparent-color emits trans/transparentcolor; absent otherwise', (t) => {
  const dir = makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // --- With the colour: TSX + TMX carry trans="#00ff00"; TSJ carries the JSON field.
  const colored = makeSourceFile(dir, A2_SUB_W, A2_SUB_H, 'colored.png');
  let result = runCli([
    '--source', colored,
    '--tile-width', '32',
    '--tile-height', '32',
    '--output', path.join(dir, 'colored.tsx'),
    '--layout', 'a2',
    '--transparent-color', '#00ff00',
  ]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.ok(
    fs.readFileSync(path.join(dir, 'colored.tsx'), 'utf8').includes('trans="#00ff00"')
  );
  assert.ok(
    fs.readFileSync(path.join(dir, 'colored.tmx'), 'utf8').includes('trans="#00ff00"')
  );

  result = runCli([
    '--source', colored,
    '--tile-width', '32',
    '--tile-height', '32',
    '--output', path.join(dir, 'colored.tsj'),
    '--layout', 'a2',
    '--transparent-color', '#00ff00',
    '--force-overwrite', // same source -> same default intermediate; allow reuse
  ]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const coloredTsj = JSON.parse(fs.readFileSync(path.join(dir, 'colored.tsj'), 'utf8'));
  assert.equal(coloredTsj.transparentcolor, '#00ff00');

  // --- Without the colour: no trans attribute and no transparentcolor field.
  const plain = makeSourceFile(dir, A2_SUB_W, A2_SUB_H, 'plain.png');
  result = runCli([
    '--source', plain,
    '--tile-width', '32',
    '--tile-height', '32',
    '--output', path.join(dir, 'plain.tsx'),
    '--layout', 'a2',
  ]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const plainTsx = fs.readFileSync(path.join(dir, 'plain.tsx'), 'utf8');
  const plainTmx = fs.readFileSync(path.join(dir, 'plain.tmx'), 'utf8');
  assert.ok(!plainTsx.includes('trans='), 'TSX should not contain a trans attribute');
  assert.ok(!plainTmx.includes('trans='), 'TMX should not contain a trans attribute');

  result = runCli([
    '--source', plain,
    '--tile-width', '32',
    '--tile-height', '32',
    '--output', path.join(dir, 'plain.tsj'),
    '--layout', 'a2',
    '--force-overwrite', // same source -> same default intermediate; allow reuse
  ]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const plainTsj = JSON.parse(fs.readFileSync(path.join(dir, 'plain.tsj'), 'utf8'));
  assert.ok(
    !('transparentcolor' in plainTsj),
    'TSJ should not contain a transparentcolor field'
  );
});

// ---------------------------------------------------------------------------
// Overwrite guard
// ---------------------------------------------------------------------------

test('overwrite guard: second run without --force-overwrite exits 1; with it succeeds', (t) => {
  const dir = makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const src = makeSourceFile(dir, A2_SUB_W, A2_SUB_H);
  const out = path.join(dir, 'out.tsx');
  const args = [
    '--source', src,
    '--tile-width', '32',
    '--tile-height', '32',
    '--output', out,
    '--layout', 'a2',
  ];

  const first = runCli(args);
  assert.equal(first.status, 0, `stderr: ${first.stderr}`);

  const second = runCli(args);
  assert.equal(second.status, 1);
  assert.ok(second.stderr.includes('Error:'));
  assert.ok(second.stderr.includes('already exists'));

  const third = runCli([...args, '--force-overwrite']);
  assert.equal(third.status, 0, `stderr: ${third.stderr}`);
});

// ---------------------------------------------------------------------------
// Layout selection
// ---------------------------------------------------------------------------

test('--layout a2 works on 32x24 subtiles', (t) => {
  const dir = makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = makeSourceFile(dir, A2_SUB_W, A2_SUB_H);
  const out = path.join(dir, 'out.tsx');
  const result = runCli([
    '--source', src,
    '--tile-width', '32',
    '--tile-height', '32',
    '--output', out,
    '--layout', 'a2',
  ]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.ok(fs.existsSync(out), 'final TSX should be written');
});

test('--layout a1 on 32x16 subtiles fails with a dimension mismatch', (t) => {
  const dir = makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = makeSourceFile(dir, 32, 16); // 512x256 px
  const result = runCli([
    '--source', src,
    '--tile-width', '32',
    '--tile-height', '32',
    '--output', path.join(dir, 'out.tsx'),
    '--layout', 'a1',
  ]);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes('Error:'));
  assert.ok(
    result.stderr.includes('Layout a1 requires 32x24 subtiles, got 32x16 subtiles')
  );
});

test('auto layout on 32x24 subtiles fails with the ambiguity message', (t) => {
  const dir = makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = makeSourceFile(dir, A2_SUB_W, A2_SUB_H);
  const result = runCli([
    '--source', src,
    '--tile-width', '32',
    '--tile-height', '32',
    '--output', path.join(dir, 'out.tsx'),
    // no --layout -> auto
  ]);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes('Error:'));
  assert.ok(result.stderr.includes('Ambiguous layout'));
  assert.ok(result.stderr.includes('--layout a1 or --layout a2'));
});

test('unsupported subtile dimensions (48x40) fail with exit 1', (t) => {
  const dir = makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = makeSourceFile(dir, 48, 40); // 768x640 px
  const result = runCli([
    '--source', src,
    '--tile-width', '32',
    '--tile-height', '32',
    '--output', path.join(dir, 'out.tsx'),
  ]);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes('Error:'));
  assert.ok(
    result.stderr.includes('Unsupported tileset dimensions 48x40 subtiles')
  );
});

// ---------------------------------------------------------------------------
// Source errors and help
// ---------------------------------------------------------------------------

test('missing/inexistent --source exits 1 with a descriptive error', () => {
  const result = runCli([
    '--source', path.join(os.tmpdir(), 'definitely-not-here-98765.png'),
    '--tile-width', '32',
    '--tile-height', '32',
    '--output', 'out.tsx',
  ]);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes('Error:'));
  assert.ok(result.stderr.includes('Cannot access --source'));
});

test('--help prints usage to stdout and exits 0', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes('Usage: node tiled-expand-autotile-cli.js'));
});

// ---------------------------------------------------------------------------
// Margins / spacing guard
// ---------------------------------------------------------------------------

test('margins guard aborts without --allow-margins and proceeds with it', (t) => {
  const dir = makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Construct a "margins" case: a clean 512x384 image (32x24 subtiles) whose
  // full tiles are declared 33x33, so floor(imageW/33)*floor(imageH/33)*4 is
  // smaller than the naive 32x24 subtile grid -> the guard fires (exactly like
  // the original `tilesetWidth * tilesetHeight > tileCount` check).
  const src = makeSourceFile(dir, A2_SUB_W, A2_SUB_H);
  const out = path.join(dir, 'out.tsx');
  const base = [
    '--source', src,
    '--tile-width', '33',
    '--tile-height', '33',
    '--output', out,
    '--layout', 'a2',
  ];

  const blocked = runCli(base);
  assert.equal(blocked.status, 1);
  assert.ok(blocked.stderr.includes('Error:'));
  assert.ok(blocked.stderr.includes('margins and/or spacing'));
  assert.ok(blocked.stderr.includes('Aborting'));
  assert.ok(!fs.existsSync(out), 'no output should be written when aborted');

  const allowed = runCli([...base, '--allow-margins']);
  assert.equal(allowed.status, 0, `stderr: ${allowed.stderr}`);
  assert.ok(allowed.stderr.includes('Warning:'));
  assert.ok(allowed.stderr.includes('--allow-margins'));
  assert.ok(fs.existsSync(out), 'output should be written with --allow-margins');
});
