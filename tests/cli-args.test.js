'use strict';

/**
 * Acceptance tests for the CLI argument parser & validation (issue #6).
 *
 * Since story #8 wired the full expansion pipeline into main(), the
 * end-to-end (subprocess) tests in this file must use a REAL PNG source and a
 * valid layout so the whole pipeline succeeds. The pure parser/validation
 * tests are unchanged.
 *
 * Run with: node --test tests/cli-args.test.js   (Node >= 18, no deps)
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cliPath = path.join(__dirname, '..', 'tiled-expand-autotile-cli.js');
const cli = require(cliPath);
const { encodePng } = require('../png-writer.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run the CLI in a subprocess with stdin CLOSED ('ignore') so we can prove the
 * script never blocks on a prompt, and capture stdout/stderr/exit code.
 */
function runCli(args, options = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'], // stdin closed, stdout/stderr piped
    timeout: options.timeout || 10000,
  });
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tiled-expand-autotile-'));
}

/**
 * Create a real source image file so --source validation passes AND the full
 * pipeline can decode it. A 512x384 PNG = 32x24 subtiles of 16px (a valid A2
 * layout when --layout a2 is passed; auto would be ambiguous on 32x24).
 */
function makeSourceFile(dir, name = 'tileset.png') {
  const file = path.join(dir, name);
  const width = 512;
  const height = 384;
  const pixels = new Uint8Array(width * height * 4).fill(255); // opaque white
  fs.writeFileSync(file, encodePng({ width, height, pixels }));
  return file;
}

// ---------------------------------------------------------------------------
// Parser: option forms
// ---------------------------------------------------------------------------

test('parses every required/optional option (long form, space-separated)', () => {
  const { options, errors } = cli.parseArgs([
    '--source', 'a.png',
    '--tile-width', '32',
    '--tile-height', '24',
    '--output', 'out.tsx',
    '--name', 'MySet',
    '--layout', 'a1',
    '--intermediate-format', 'png',
    '--intermediate-output', 'mid.png',
    '--transparent-color', '#FF00FF',
    '--force-overwrite',
    '--allow-margins',
    '--tileset-format', 'tsj',
  ]);

  assert.deepEqual(errors, []);
  assert.equal(options.source, 'a.png');
  assert.equal(options.tileWidth, '32');
  assert.equal(options.tileHeight, '24');
  assert.equal(options.output, 'out.tsx');
  assert.equal(options.name, 'MySet');
  assert.equal(options.layout, 'a1');
  assert.equal(options.intermediateFormat, 'png');
  assert.equal(options.intermediateOutput, 'mid.png');
  assert.equal(options.transparentColor, '#FF00FF');
  assert.equal(options.forceOverwrite, true);
  assert.equal(options.allowMargins, true);
  assert.equal(options.tilesetFormat, 'tsj');
});

test('supports the --opt=value form for every scalar option', () => {
  const { options, errors } = cli.parseArgs([
    '--source=a.png',
    '--tile-width=32',
    '--tile-height=24',
    '--output=out.tsj',
    '--name=Set',
    '--layout=a2',
    '--intermediate-format=tmx',
    '--intermediate-output=mid.tmx',
    '--transparent-color=#FFF',
    '--tileset-format=tsj',
  ]);

  assert.deepEqual(errors, []);
  assert.equal(options.source, 'a.png');
  assert.equal(options.tileWidth, '32');
  assert.equal(options.tileHeight, '24');
  assert.equal(options.output, 'out.tsj');
  assert.equal(options.name, 'Set');
  assert.equal(options.layout, 'a2');
  assert.equal(options.intermediateFormat, 'tmx');
  assert.equal(options.intermediateOutput, 'mid.tmx');
  assert.equal(options.transparentColor, '#FFF');
  assert.equal(options.tilesetFormat, 'tsj');
});

test('supports short aliases (-i -w -h -o -n -l -f)', () => {
  const { options, errors } = cli.parseArgs([
    '-i', 'a.png',
    '-w', '32',
    '-h', '24',
    '-o', 'out.tsx',
    '-n', 'Set',
    '-l', 'a2',
    '-f', 'png',
  ]);

  assert.deepEqual(errors, []);
  assert.equal(options.source, 'a.png');
  assert.equal(options.tileWidth, '32');
  assert.equal(options.tileHeight, '24');
  assert.equal(options.output, 'out.tsx');
  assert.equal(options.name, 'Set');
  assert.equal(options.layout, 'a2');
  assert.equal(options.intermediateFormat, 'png');
});

test('supports short alias with =value (-i=value)', () => {
  const { options, errors } = cli.parseArgs(['-i=a.png', '-w=32', '-h=24', '-o=out.tsx']);
  assert.deepEqual(errors, []);
  assert.equal(options.source, 'a.png');
  assert.equal(options.tileWidth, '32');
  assert.equal(options.tileHeight, '24');
  assert.equal(options.output, 'out.tsx');
});

test('boolean flags parse to true', () => {
  const { options, errors } = cli.parseArgs([
    '--source', 'a.png', '--tile-width', '32', '--tile-height', '24', '--output', 'o.tsx',
    '--force-overwrite', '--allow-margins', '--help',
  ]);
  assert.deepEqual(errors, []);
  assert.equal(options.forceOverwrite, true);
  assert.equal(options.allowMargins, true);
  assert.equal(options.help, true);
});

test('repeated scalar options: last wins', () => {
  const { options, errors } = cli.parseArgs([
    '--layout', 'a1', '--layout', 'a3',
    '--name', 'First', '--name', 'Second',
  ]);
  assert.deepEqual(errors, []);
  assert.equal(options.layout, 'a3');
  assert.equal(options.name, 'Second');
});

// ---------------------------------------------------------------------------
// Parser: errors
// ---------------------------------------------------------------------------

test('unknown option is reported as an error', () => {
  const { errors } = cli.parseArgs(['--bogus', 'x']);
  assert.ok(errors.some((e) => e.includes('Unknown option: --bogus')));
});

test('unknown short option is reported as an error', () => {
  const { errors } = cli.parseArgs(['-z']);
  assert.ok(errors.some((e) => e.includes('Unknown option: -z')));
});

test('scalar option missing its value is an error', () => {
  const { errors } = cli.parseArgs(['--output']);
  assert.ok(errors.some((e) => e.includes('Option --output requires a value')));
});

test('unexpected positional argument is an error', () => {
  const { errors } = cli.parseArgs(['plain-file.png']);
  assert.ok(errors.some((e) => e.includes('Unexpected argument: plain-file.png')));
});

test('boolean flag with a value is an error', () => {
  const { errors } = cli.parseArgs(['--force-overwrite=yes']);
  assert.ok(errors.some((e) => e.includes('--force-overwrite does not take a value')));
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

test('applies defaults: name from source basename, layout auto, format tmx', () => {
  const dir = makeTempDir();
  const src = makeSourceFile(dir, 'my_tileset.png');
  const { options, errors, provided } = cli.resolveArgs([
    '--source', src,
    '--tile-width', '32',
    '--tile-height', '24',
    '--output', path.join(dir, 'out.tsx'),
  ]);

  assert.deepEqual(errors, []);
  assert.equal(options.name, 'my_tileset');
  assert.equal(options.layout, 'auto');
  assert.equal(options.intermediateFormat, 'tmx');
  assert.equal(options.intermediateOutput, path.join(dir, 'my_tileset.tmx'));
  assert.equal(options.tilesetFormat, 'tsx'); // inferred from out.tsx
  assert.equal(provided.has('name'), false); // defaulted, not user-set
  assert.equal(provided.has('tilesetFormat'), false); // inferred, not user-set
});

test('intermediate default for png is <basename>_expanded.png in the source dir', () => {
  const dir = makeTempDir();
  const src = makeSourceFile(dir, 't.png');
  const { options, errors } = cli.resolveArgs([
    '--source', src,
    '--tile-width', '16',
    '--tile-height', '16',
    '--output', path.join(dir, 'o.tsx'),
    '--intermediate-format', 'png',
  ]);
  assert.deepEqual(errors, []);
  assert.equal(options.intermediateOutput, path.join(dir, 't_expanded.png'));
});

test('tileset-format inferred from .json/.tsj output', () => {
  const { options } = cli.resolveArgs([
    '--source', 'a.png', '--tile-width', '32', '--tile-height', '24', '--output', 'out.tsj',
  ]);
  assert.equal(options.tilesetFormat, 'tsj');
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('missing required args produce errors', () => {
  const { errors } = cli.resolveArgs(['--tile-width', '32']);
  assert.ok(errors.some((e) => e.includes('--source')));
  assert.ok(errors.some((e) => e.includes('--tile-height')));
  assert.ok(errors.some((e) => e.includes('--output')));
  assert.ok(!errors.some((e) => e.includes('--tile-width'))); // it was supplied
});

test('--source must exist', () => {
  const { errors } = cli.resolveArgs([
    '--source', path.join(os.tmpdir(), `definitely-missing-${Date.now()}.png`),
    '--tile-width', '32', '--tile-height', '24', '--output', 'out.tsx',
  ]);
  assert.ok(errors.some((e) => e.includes('Cannot access --source')));
});

test('--source must be a regular file (directories rejected)', () => {
  const dir = makeTempDir();
  const { errors } = cli.resolveArgs([
    '--source', dir, '--tile-width', '32', '--tile-height', '24', '--output', 'out.tsx',
  ]);
  assert.ok(errors.some((e) => e.includes('not a regular file')));
});

for (const bad of ['0', '-5', 'abc', '1.5', '']) {
  test(`tile-width ${JSON.stringify(bad)} is rejected`, () => {
    const { errors } = cli.resolveArgs([
      '--source', 'a.png', '--tile-width', bad, '--tile-height', '24', '--output', 'out.tsx',
    ]);
    assert.ok(errors.some((e) => e.includes('--tile-width must be a positive integer')));
  });
}

test('valid tile sizes are accepted', () => {
  const dir = makeTempDir();
  const src = makeSourceFile(dir);
  const { errors } = cli.resolveArgs([
    '--source', src, '--tile-width', '32', '--tile-height', '24', '--output', path.join(dir, 'out.tsx'),
  ]);
  assert.deepEqual(errors, []);
});

test('invalid layout is rejected', () => {
  const { errors } = cli.resolveArgs([
    '--source', 'a.png', '--tile-width', '32', '--tile-height', '24', '--output', 'o.tsx', '--layout', 'bogus',
  ]);
  assert.ok(errors.some((e) => e.includes('--layout must be one of')));
});

test('invalid intermediate-format is rejected', () => {
  const { errors } = cli.resolveArgs([
    '--source', 'a.png', '--tile-width', '32', '--tile-height', '24', '--output', 'o.tsx', '--intermediate-format', 'jpeg',
  ]);
  assert.ok(errors.some((e) => e.includes('--intermediate-format must be one of')));
});

test('invalid tileset-format is rejected', () => {
  const { errors } = cli.resolveArgs([
    '--source', 'a.png', '--tile-width', '32', '--tile-height', '24', '--output', 'o.tsx', '--tileset-format', 'foo',
  ]);
  assert.ok(errors.some((e) => e.includes('--tileset-format must be one of')));
});

test('transparent-color accepts #RGB / #RRGGBB / #AARRGGBB', () => {
  const dir = makeTempDir();
  const src = makeSourceFile(dir);
  for (const color of ['#FFF', '#ff00ff', '#80FF00FF']) {
    const { errors } = cli.resolveArgs([
      '--source', src, '--tile-width', '32', '--tile-height', '24', '--output', path.join(dir, 'o.tsx'), '--transparent-color', color,
    ]);
    assert.deepEqual(errors, [], `color ${color} should be valid`);
  }
});

test('transparent-color rejects malformed values', () => {
  for (const color of ['FFF', '#GGG', '#FFFF', '#12345', 'red']) {
    const { errors } = cli.resolveArgs([
      '--source', 'a.png', '--tile-width', '32', '--tile-height', '24', '--output', 'o.tsx', '--transparent-color', color,
    ]);
    assert.ok(errors.some((e) => e.includes('--transparent-color')), `color ${color} should be invalid`);
  }
});

test('output extension must be .tsx/.xml/.tsj/.json unless --tileset-format is given', () => {
  const dir = makeTempDir();
  const src = makeSourceFile(dir);
  for (const out of ['out.tsx', 'out.xml', 'out.tsj', 'out.json']) {
    const { errors } = cli.resolveArgs([
      '--source', src, '--tile-width', '32', '--tile-height', '24', '--output', path.join(dir, out),
    ]);
    assert.deepEqual(errors, [], `${out} should be valid`);
  }

  const bad = cli.resolveArgs([
    '--source', src, '--tile-width', '32', '--tile-height', '24', '--output', path.join(dir, 'out.txt'),
  ]);
  assert.ok(bad.errors.some((e) => e.includes('--output must end with')));

  // With --tileset-format supplied the extension check is skipped.
  const forced = cli.resolveArgs([
    '--source', src, '--tile-width', '32', '--tile-height', '24', '--output', path.join(dir, 'out.whatever'), '--tileset-format', 'tsx',
  ]);
  assert.deepEqual(forced.errors, []);
});

test('intermediate-output extension must match intermediate-format when both given', () => {
  const dir = makeTempDir();
  const src = makeSourceFile(dir);

  const bad = cli.resolveArgs([
    '--source', src, '--tile-width', '32', '--tile-height', '24', '--output', path.join(dir, 'o.tsx'),
    '--intermediate-format', 'tmx', '--intermediate-output', path.join(dir, 'foo.png'),
  ]);
  assert.ok(bad.errors.some((e) => e.includes('--intermediate-output must end with')));

  const goodTmx = cli.resolveArgs([
    '--source', src, '--tile-width', '32', '--tile-height', '24', '--output', path.join(dir, 'o.tsx'),
    '--intermediate-format', 'tmx', '--intermediate-output', path.join(dir, 'foo.tmx'),
  ]);
  assert.deepEqual(goodTmx.errors, []);

  const goodPng = cli.resolveArgs([
    '--source', src, '--tile-width', '32', '--tile-height', '24', '--output', path.join(dir, 'o.tsx'),
    '--intermediate-format', 'png', '--intermediate-output', path.join(dir, 'foo.png'),
  ]);
  assert.deepEqual(goodPng.errors, []);
});

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

test('--help is recognized and is not an error', () => {
  const { options, errors } = cli.resolveArgs(['--help']);
  assert.equal(options.help, true);
  assert.deepEqual(errors, []);
  assert.ok(cli.usage().includes('Usage: node tiled-expand-autotile-cli.js'));
});

test('main prints usage and returns 0 on --help', () => {
  let out = '';
  const io = {
    stdout: { write: (s) => { out += s; } },
    stderr: { write: () => {} },
    exit: () => {},
  };
  const code = cli.main(['--help'], io);
  assert.equal(code, 0);
  assert.ok(out.includes('Usage:'));
});

// ---------------------------------------------------------------------------
// main() behaviour
// ---------------------------------------------------------------------------

test('main returns 1 and writes Error + hint to stderr on invalid args', () => {
  let errOut = '';
  const io = {
    stdout: { write: () => {} },
    stderr: { write: (s) => { errOut += s; } },
    exit: () => {},
  };
  const code = cli.main(
    ['--source', 'missing.png', '--tile-width', '0', '--tile-height', '24', '--output', 'o.txt'],
    io
  );
  assert.equal(code, 1);
  assert.ok(errOut.includes('Error: --tile-width must be a positive integer'));
  assert.ok(errOut.includes("Run 'node tiled-expand-autotile-cli.js --help'"));
});

// ---------------------------------------------------------------------------
// End-to-end (subprocess)
// ---------------------------------------------------------------------------

test('valid invocation exits 0 with stdin closed (no prompt)', () => {
  const dir = makeTempDir();
  const src = makeSourceFile(dir);
  const out = path.join(dir, 'result.tsx');
  const result = runCli(['--source', src, '--tile-width', '32', '--tile-height', '32', '--output', out, '--layout', 'a2']);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
});

test('short aliases work end-to-end', () => {
  const dir = makeTempDir();
  const src = makeSourceFile(dir);
  const out = path.join(dir, 'result.tsx');
  const result = runCli(['-i', src, '-w', '32', '-h', '32', '-o', out, '-l', 'a2']);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
});

test('missing required arg exits 1 with Error on stderr', () => {
  const result = runCli(['--tile-width', '32']);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes('Error:'));
  assert.ok(result.stderr.includes('--source'));
});

test('invalid value exits 1 with Error on stderr', () => {
  const dir = makeTempDir();
  const src = makeSourceFile(dir);
  const result = runCli(['--source', src, '--tile-width', '0', '--tile-height', '24', '--output', 'o.tsx']);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes('Error:'));
});

test('--help prints usage to stdout and exits 0', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes('Usage: node tiled-expand-autotile-cli.js'));
});

test('invocation with stdin closed returns promptly (proves no prompt)', () => {
  const dir = makeTempDir();
  const src = makeSourceFile(dir);
  const out = path.join(dir, 'out.tsx');
  const start = Date.now();
  const result = runCli(['--source', src, '--tile-width', '32', '--tile-height', '32', '--output', out, '--layout', 'a2'], {
    timeout: 5000,
  });
  const elapsed = Date.now() - start;
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.ok(elapsed < 5000, `process did not return promptly (${elapsed}ms)`);
});
