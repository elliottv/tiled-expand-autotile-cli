'use strict';

/**
 * Acceptance tests for the TMX intermediate writer (issue #4).
 *
 * Run with: node --test tests/tmx-writer.test.js   (Node >= 18, no deps)
 *
 * Well-formedness note: the project has zero third-party dependencies, so the
 * "open correctly in Tiled" check is implemented as a tiny regex/stack-based
 * tag-balance validator (see assertWellFormed below) rather than pulling in a
 * full XML parser. That choice is deliberate and documented in the PR.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { writeTmx, escapeXml, normalizeTransparentColor } = require('../tmx-writer.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal well-formedness check: every non-self-closing tag must be closed and
 * tags must nest correctly. Good enough to prove the document parses as XML for
 * the simple (escaping-aware) documents this writer produces.
 */
function assertWellFormed(xml) {
  const tagRe = /<\/?([A-Za-z][A-Za-z0-9]*)(?:\s[^>]*)?\/?>/g;
  const stack = [];
  let match;
  while ((match = tagRe.exec(xml)) !== null) {
    const full = match[0];
    const tagName = match[1];
    if (full.startsWith('</')) {
      assert.equal(
        stack.pop(),
        tagName,
        `mismatched closing tag </${tagName}> at index ${match.index}`
      );
    } else if (!full.endsWith('/>')) {
      stack.push(tagName);
    }
  }
  assert.deepEqual(stack, [], `unclosed tags: ${stack.join(', ')}`);
}

/** A small synthetic configuration reused across several tests. */
function syntheticParams(overrides = {}) {
  return {
    name: 'Cave',
    sourceImagePath: 'assets/cave.png',
    imageWidth: 48,
    imageHeight: 32,
    subtileWidth: 16,
    subtileHeight: 16,
    tilesetWidth: 3,
    tilesetHeight: 2,
    grid: [
      [0, 1, null, 2],
      [3, null, 4, 5],
    ],
    transparentColor: '#FF00AA',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Golden string: exact full-XML comparison on a small synthetic grid
// ---------------------------------------------------------------------------

test('writeTmx produces the exact expected TMX for a small synthetic grid', () => {
  const xml = writeTmx(syntheticParams());

  const expected = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<map version="1.10" tiledversion="1.10.2" orientation="orthogonal" renderorder="right-down" width="4" height="2" tilewidth="16" tileheight="16" infinite="0" nextlayerid="2" nextobjectid="1">',
    ' <tileset firstgid="1" name="Cave Subtiles" tilewidth="16" tileheight="16" tilecount="6" columns="3">',
    '  <image source="assets/cave.png" width="48" height="32" trans="#ff00aa"/>',
    ' </tileset>',
    ' <layer id="1" name="Cave Expanded" width="4" height="2">',
    '  <data encoding="csv">',
    '1,2,0,3,',
    '4,0,5,6,',
    '  </data>',
    ' </layer>',
    '</map>',
    '',
  ].join('\n');

  assert.equal(xml, expected);
});

// ---------------------------------------------------------------------------
// GID mapping
// ---------------------------------------------------------------------------

test('GID mapping: subtile index 0 -> 1 and empty cell -> 0', () => {
  const xml = writeTmx(
    syntheticParams({
      grid: [[0, null, 5, 0]],
      imageWidth: 96,
      imageHeight: 32,
      tilesetWidth: 6,
      tilesetHeight: 2,
    })
  );

  // Row of cells [0, null, 5, 0] -> GIDs [1, 0, 6, 1].
  assert.ok(xml.includes('\n1,0,6,1,\n'), 'CSV row must map subtile 0 -> 1 and null -> 0');
  assert.ok(!xml.includes('1,0,6,1,0,1,'), 'no spurious cells');
});

// ---------------------------------------------------------------------------
// trans attribute
// ---------------------------------------------------------------------------

test('trans attribute is present only when transparentColor is set', () => {
  const withTrans = writeTmx(syntheticParams());
  const withoutTrans = writeTmx(syntheticParams({ transparentColor: undefined }));

  assert.ok(withTrans.includes(' trans="#ff00aa"'), 'trans must be #ff00aa (lowercased)');
  assert.ok(!withoutTrans.includes('trans='), 'trans must be omitted when not set');
});

test('transparentColor is normalised to lowercase 6-digit #rrggbb', () => {
  // #RRGGBB (uppercase input) -> lowercase output.
  assert.equal(normalizeTransparentColor('#FF00AA'), '#ff00aa');
  // #RGB -> #RRGGBB.
  assert.equal(normalizeTransparentColor('#F0A'), '#ff00aa');
  // #AARRGGBB -> #RRGGBB (alpha dropped; Tiled trans has no alpha).
  assert.equal(normalizeTransparentColor('#80FF00AA'), '#ff00aa');
  // Leading '#' optional.
  assert.equal(normalizeTransparentColor('ff00aa'), '#ff00aa');
  // Empty / absent -> undefined (no attribute emitted).
  assert.equal(normalizeTransparentColor(undefined), undefined);
  assert.equal(normalizeTransparentColor(''), undefined);
});

test('normalizeTransparentColor rejects unrecognised values', () => {
  assert.throws(() => normalizeTransparentColor('#12345'), /Invalid transparentColor/);
  assert.throws(() => normalizeTransparentColor('nope'), /Invalid transparentColor/);
});

// ---------------------------------------------------------------------------
// XML escaping
// ---------------------------------------------------------------------------

test('XML escaping of a name and path containing & < > "', () => {
  const xml = writeTmx(
    syntheticParams({
      name: 'Rocks & <Lava> "Hot"',
      sourceImagePath: 'a&b<c>d"e.png',
    })
  );

  assert.ok(
    xml.includes('name="Rocks &amp; &lt;Lava&gt; &quot;Hot&quot; Subtiles"'),
    'tileset name must be escaped'
  );
  assert.ok(
    xml.includes('name="Rocks &amp; &lt;Lava&gt; &quot;Hot&quot; Expanded"'),
    'layer name must be escaped'
  );
  assert.ok(
    xml.includes('source="a&amp;b&lt;c&gt;d&quot;e.png"'),
    'source path must be escaped'
  );
  // Raw metacharacters must never survive into the document.
  assert.ok(!xml.includes('<Lava>'));
  assert.ok(!xml.includes('a&b'));
});

test('escapeXml escapes & < > " (and leaves ordinary text alone)', () => {
  assert.equal(escapeXml('A & B < C > D " E'), 'A &amp; B &lt; C &gt; D &quot; E');
  assert.equal(escapeXml('plain'), 'plain');
});

// ---------------------------------------------------------------------------
// Well-formedness
// ---------------------------------------------------------------------------

test('output passes a well-formedness check (balanced tags)', () => {
  assertWellFormed(writeTmx(syntheticParams()));
  assertWellFormed(
    writeTmx(
      syntheticParams({
        name: 'A&B<C> "D"',
        sourceImagePath: 'x&y<z>"q.png',
        transparentColor: '#F00',
      })
    )
  );
  // A real-ish grid (all cells filled) must also be balanced.
  const grid = Array.from({ length: 4 }, () => Array.from({ length: 6 }, (_, i) => i % 7));
  assertWellFormed(
    writeTmx(
      syntheticParams({
        grid,
        imageWidth: 112,
        imageHeight: 64,
        tilesetWidth: 7,
        tilesetHeight: 4,
      })
    )
  );
});
