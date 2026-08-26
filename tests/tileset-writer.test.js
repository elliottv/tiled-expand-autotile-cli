'use strict';

/**
 * Acceptance tests for the final tileset writer (issue #3).
 *
 * Run with: node --test tests/tileset-writer.test.js   (Node >= 18, no deps)
 *
 * Well-formedness note: the project has zero third-party dependencies, so the
 * XML check is a tiny regex/stack-based tag-balance validator (same approach
 * as tests/tmx-writer.test.js) rather than a full XML parser. JSON is checked
 * by round-tripping through JSON.parse.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  writeTileset,
  escapeXml,
  normalizeTransparentColor,
} = require('../tileset-writer.js');

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

/** A synthetic configuration reused across several tests. */
function syntheticParams(overrides = {}) {
  return {
    name: 'Cave',
    tileWidth: 32,
    tileHeight: 32,
    imagePath: 'expanded/cave.png',
    imageWidth: 1792,
    imageHeight: 896,
    transparentColor: '#FF00AA',
    format: 'tsx',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Golden strings
// ---------------------------------------------------------------------------

test('writeTileset produces the exact expected TSX for known inputs', () => {
  const tsx = writeTileset(syntheticParams());

  const expected = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<tileset version="1.10" tiledversion="1.10.2" name="Cave" tilewidth="32" tileheight="32" tilecount="1568" columns="56">',
    ' <image source="expanded/cave.png" width="1792" height="896" trans="#ff00aa"/>',
    '</tileset>',
    '',
  ].join('\n');

  assert.equal(tsx, expected);
});

test('writeTileset produces the exact expected TSJ (golden string + parse)', () => {
  const tsj = writeTileset(syntheticParams({ format: 'tsj' }));

  const expected = [
    '{',
    '  "type": "tileset",',
    '  "name": "Cave",',
    '  "tilewidth": 32,',
    '  "tileheight": 32,',
    '  "tilecount": 1568,',
    '  "columns": 56,',
    '  "image": "expanded/cave.png",',
    '  "imagewidth": 1792,',
    '  "imageheight": 896,',
    '  "transparentcolor": "#ff00aa",',
    '  "tiles": []',
    '}',
    '',
  ].join('\n');

  assert.equal(tsj, expected);

  // The string must round-trip through JSON.parse with every field intact.
  assert.deepEqual(JSON.parse(tsj), {
    type: 'tileset',
    name: 'Cave',
    tilewidth: 32,
    tileheight: 32,
    tilecount: 1568,
    columns: 56,
    image: 'expanded/cave.png',
    imagewidth: 1792,
    imageheight: 896,
    transparentcolor: '#ff00aa',
    tiles: [],
  });
});

// ---------------------------------------------------------------------------
// trans / transparentcolor
// ---------------------------------------------------------------------------

test('trans / transparentcolor present only when set and always lowercase #rrggbb', () => {
  const withTrans = writeTileset(syntheticParams());
  const withoutTrans = writeTileset(syntheticParams({ transparentColor: undefined }));

  assert.ok(withTrans.includes(' trans="#ff00aa"'), 'TSX trans must be #ff00aa (lowercased)');
  assert.ok(!withoutTrans.includes('trans='), 'TSX trans must be omitted when not set');

  const withTsj = JSON.parse(writeTileset(syntheticParams({ format: 'tsj' })));
  const withoutTsj = JSON.parse(
    writeTileset(syntheticParams({ format: 'tsj', transparentColor: undefined }))
  );
  assert.equal(withTsj.transparentcolor, '#ff00aa');
  assert.ok(
    !('transparentcolor' in withoutTsj),
    'TSJ transparentcolor must be omitted when not set'
  );
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
  // Empty / absent -> undefined (no attribute/key emitted).
  assert.equal(normalizeTransparentColor(undefined), undefined);
  assert.equal(normalizeTransparentColor(''), undefined);
});

test('normalizeTransparentColor rejects unrecognised values', () => {
  assert.throws(() => normalizeTransparentColor('#12345'), /Invalid transparentColor/);
  assert.throws(() => normalizeTransparentColor('nope'), /Invalid transparentColor/);
});

// ---------------------------------------------------------------------------
// tilecount / columns for non-square images
// ---------------------------------------------------------------------------

test('tilecount/columns computed for non-square image (1792x896 @ 32px tiles)', () => {
  // columns = floor(1792/32) = 56, rows = floor(896/32) = 28,
  // tilecount = 56 * 28 = 1568.
  const tsx = writeTileset(syntheticParams());
  assert.ok(tsx.includes('columns="56"'), 'TSX must carry columns="56"');
  assert.ok(tsx.includes('tilecount="1568"'), 'TSX must carry tilecount="1568"');

  const tsj = JSON.parse(writeTileset(syntheticParams({ format: 'tsj' })));
  assert.equal(tsj.columns, 56);
  assert.equal(tsj.tilecount, 1568);
});

// ---------------------------------------------------------------------------
// XML escaping
// ---------------------------------------------------------------------------

test('XML escaping of a name and path containing & < > " (TSX)', () => {
  const tsx = writeTileset(
    syntheticParams({
      name: 'Rocks & <Lava> "Hot"',
      imagePath: 'a&b<c>d"e.png',
    })
  );

  assert.ok(
    tsx.includes('name="Rocks &amp; &lt;Lava&gt; &quot;Hot&quot;"'),
    'tileset name must be escaped'
  );
  assert.ok(
    tsx.includes('source="a&amp;b&lt;c&gt;d&quot;e.png"'),
    'image source path must be escaped'
  );
  // Raw metacharacters must never survive into the document.
  assert.ok(!tsx.includes('<Lava>'));
  assert.ok(!tsx.includes('a&b'));
});

test('escapeXml escapes & < > " (and leaves ordinary text alone)', () => {
  assert.equal(escapeXml('A & B < C > D " E'), 'A &amp; B &lt; C &gt; D &quot; E');
  assert.equal(escapeXml('plain'), 'plain');
});

// ---------------------------------------------------------------------------
// Format selection / validation
// ---------------------------------------------------------------------------

test('format is case-insensitive (tsx/tsj and TSX/TSJ produce identical output)', () => {
  assert.equal(
    writeTileset(syntheticParams({ format: 'TSX' })),
    writeTileset(syntheticParams({ format: 'tsx' }))
  );
  assert.equal(
    writeTileset(syntheticParams({ format: 'TSJ' })),
    writeTileset(syntheticParams({ format: 'tsj' }))
  );
});

test('writeTileset rejects unknown or missing formats', () => {
  assert.throws(
    () => writeTileset(syntheticParams({ format: 'nope' })),
    /format must be "tsx" or "tsj"/
  );
  assert.throws(
    () => writeTileset(syntheticParams({ format: undefined })),
    /format must be "tsx" or "tsj"/
  );
});

test('writeTileset rejects non-positive dimensions', () => {
  assert.throws(
    () => writeTileset(syntheticParams({ tileWidth: 0 })),
    /tileWidth must be a positive integer/
  );
  assert.throws(
    () => writeTileset(syntheticParams({ imageHeight: -4 })),
    /imageHeight must be a positive integer/
  );
});

// ---------------------------------------------------------------------------
// Well-formedness
// ---------------------------------------------------------------------------

test('TSX output passes a well-formedness check (balanced tags)', () => {
  assertWellFormed(writeTileset(syntheticParams()));
  assertWellFormed(
    writeTileset(
      syntheticParams({
        name: 'A&B<C> "D"',
        imagePath: 'x&y<z>"q.png',
        transparentColor: '#F00',
      })
    )
  );
});

test('TSJ output is parseable JSON for a range of inputs', () => {
  for (const params of [
    syntheticParams({ format: 'tsj' }),
    syntheticParams({ format: 'tsj', transparentColor: undefined }),
    syntheticParams({ format: 'tsj', name: 'A "quoted" & <name>' }),
  ]) {
    const obj = JSON.parse(writeTileset(params)); // must not throw
    assert.equal(obj.type, 'tileset');
    assert.ok(Array.isArray(obj.tiles));
  }
});
