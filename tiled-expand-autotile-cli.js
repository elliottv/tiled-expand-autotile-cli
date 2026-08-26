#!/usr/bin/env node
'use strict';

/**
 * tiled-expand-autotile-cli.js
 *
 * Command-line front-end for expanding RPG Maker autotile tilesets into
 * full Tiled tilesets.
 *
 * Story (issue #8) wires the whole pipeline together:
 *   1. parse/validate args (issue #6);
 *   2. decode the source PNG (png-decode.js, issue #7); on failure print a
 *      descriptive error and exit 1;
 *   3. compute subtile/tileset dimensions
 *      (subtileWidth = floor(tileWidth/2), etc.);
 *   4. margins/spacing guard replicating the original script's
 *      `tilesetWidth * tilesetHeight > tileCount` check;
 *   5. detect the autotile layout (engine.js, issue #2);
 *   6. expand the layout into the subtile grid (engine.js);
 *   7. write the intermediate TMX (tmx-writer.js, issue #4) or PNG
 *      (png-writer.js, issue #5);
 *   8. write the final TSX/TSJ tileset (tileset-writer.js, issue #3);
 *   9. print a concise summary to stdout and exit 0.
 *
 * The CLI is fully driven by command-line arguments: it never reads stdin,
 * so it can never block on an interactive prompt (the original script's
 * confirmations are each mapped to a flag; see OPTION_SPECS below).
 *
 * Design notes:
 *  - Zero third-party dependencies; Node built-ins only.
 *  - When executed directly (`require.main === module`) we call main().
 *    When required by tests we export the parse/validate helpers plus the
 *    pipeline pieces (runExpansion, cleanTileCount) for direct testing.
 *  - Repeated scalar options: last one wins (e.g. `--layout a1 --layout a3`
 *    results in layout === 'a3').
 */

const fs = require('node:fs');
const path = require('node:path');

const { decodePng } = require('./png-decode.js');
const { subtileDimensions, detectLayout, expand } = require('./engine.js');
const { writeTmx } = require('./tmx-writer.js');
const { renderExpandedImage, encodePng } = require('./png-writer.js');
const { writeTileset } = require('./tileset-writer.js');

// ---------------------------------------------------------------------------
// Option metadata (the frozen CLI contract, issue #6)
// ---------------------------------------------------------------------------

const OPTION_SPECS = [
  {
    long: '--source',
    short: '-i',
    key: 'source',
    hasArg: true,
    required: true,
    desc: 'Source RPG Maker tileset image (PNG); must exist and be a regular file.',
  },
  {
    long: '--tile-width',
    short: '-w',
    key: 'tileWidth',
    hasArg: true,
    required: true,
    desc: 'Full tile width; positive integer.',
  },
  {
    long: '--tile-height',
    short: '-h',
    key: 'tileHeight',
    hasArg: true,
    required: true,
    desc: 'Full tile height; positive integer.',
  },
  {
    long: '--output',
    short: '-o',
    key: 'output',
    hasArg: true,
    required: true,
    desc: 'Output path for the final tileset (.tsx/.xml or .tsj/.json).',
  },
  {
    long: '--name',
    short: '-n',
    key: 'name',
    hasArg: true,
    desc: 'Tileset name. Default: basename of --source (without extension).',
  },
  {
    long: '--layout',
    short: '-l',
    key: 'layout',
    hasArg: true,
    desc: 'Autotile layout. Default: auto.',
  },
  {
    long: '--intermediate-format',
    short: '-f',
    key: 'intermediateFormat',
    hasArg: true,
    desc: 'Intermediate output format. Default: tmx.',
  },
  {
    long: '--intermediate-output',
    key: 'intermediateOutput',
    hasArg: true,
    desc: 'Intermediate file path. Default: <dir of source>/<basename>.tmx or <basename>_expanded.png.',
  },
  {
    long: '--transparent-color',
    key: 'transparentColor',
    hasArg: true,
    desc: 'Enable transparency and set the colour (#RGB, #RRGGBB or #AARRGGBB).',
  },
  {
    long: '--force-overwrite',
    key: 'forceOverwrite',
    hasArg: false,
    desc: 'Overwrite an existing intermediate file instead of aborting.',
  },
  {
    long: '--allow-margins',
    key: 'allowMargins',
    hasArg: false,
    desc: 'Proceed even when non-zero margins/spacing are suspected.',
  },
  {
    long: '--tileset-format',
    key: 'tilesetFormat',
    hasArg: true,
    desc: 'Force final tileset format; default inferred from --output extension.',
  },
  {
    long: '--help',
    key: 'help',
    hasArg: false,
    desc: 'Print this usage and exit 0.',
  },
];

/** Maps every accepted flag (long and short) to its spec. */
const OPTION_LOOKUP = new Map();
/** Maps a canonical option key back to its long flag (for error messages). */
const KEY_TO_LONG = new Map();
for (const spec of OPTION_SPECS) {
  OPTION_LOOKUP.set(spec.long, spec);
  if (spec.short) OPTION_LOOKUP.set(spec.short, spec);
  KEY_TO_LONG.set(spec.key, spec.long);
}

const LAYOUTS = ['auto', 'a1', 'a2', 'a3', 'a4'];
const INTERMEDIATE_FORMATS = ['tmx', 'png'];
const TILESET_FORMATS = ['tsx', 'tsj'];
const TILESET_OUTPUT_EXTENSIONS = ['.tsx', '.xml', '.tsj', '.json'];
/** Intermediate extension expected for each --intermediate-format value. */
const INTERMEDIATE_EXTENSIONS = { tmx: '.tmx', png: '.png' };
/** Accepts #RGB, #RRGGBB or #AARRGGBB (hex digits, case-insensitive). */
const TRANSPARENT_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const ERROR_HINT = `Run 'node tiled-expand-autotile-cli.js --help' for usage.`;

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse raw argv tokens into a flat options object.
 *
 * Supports:
 *  - `--opt value` and `--opt=value`
 *  - short aliases `-i -w -h -o -n -l -f` (also `-i=value`)
 *  - boolean flags (`--force-overwrite`, `--allow-margins`, `--help`)
 *  - repeated scalar options: the last occurrence wins
 *
 * Returns `{ options, errors }`. `options` holds raw string/boolean values;
 * `options.help === true` when `--help` was passed. This function is pure
 * (no filesystem access).
 */
function parseArgs(argv) {
  const options = {};
  const errors = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    // `--` ends option parsing; anything after it is positional and unsupported.
    if (token === '--') {
      for (const rest of argv.slice(i + 1)) {
        errors.push(`Unexpected argument: ${rest}`);
      }
      break;
    }

    // Split `--flag=value` / `-x=value` into flag + inline value.
    let flag = token;
    let inlineValue;
    if (token.startsWith('-') && token.length > 1) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        flag = token.slice(0, eq);
        inlineValue = token.slice(eq + 1);
      }
    } else {
      errors.push(`Unexpected argument: ${token}`);
      continue;
    }

    const spec = OPTION_LOOKUP.get(flag);
    if (!spec) {
      errors.push(`Unknown option: ${flag}`);
      continue;
    }

    if (!spec.hasArg) {
      if (inlineValue !== undefined) {
        errors.push(`Option ${flag} does not take a value`);
      }
      options[spec.key] = true;
      continue;
    }

    let value = inlineValue;
    if (value === undefined) {
      const next = argv[i + 1];
      // A following token that starts with '-' is normally another option (so
      // we report a missing value), EXCEPT when it looks like a negative
      // number (e.g. `-5`) — that is a legit value that validation will reject.
      const looksLikeNegativeNumber = next !== undefined && /^-\d/.test(next);
      if (
        next === undefined ||
        (next.startsWith('-') && next.length > 1 && !looksLikeNegativeNumber)
      ) {
        errors.push(`Option ${flag} requires a value`);
        continue;
      }
      value = next;
      i++; // consume the value token
    }

    // Repeated scalar options: last one wins.
    options[spec.key] = value;
  }

  return { options, errors };
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Fill in defaults for any option the user did not supply.
 *
 * Returns `{ options, provided }` where `provided` is a Set of option keys the
 * user explicitly supplied (used to distinguish "defaulted" from "user-set" so
 * that cross-field consistency checks only apply to user-provided values).
 */
function applyDefaults(raw) {
  const provided = new Set(
    Object.keys(raw).filter((key) => raw[key] !== undefined)
  );

  const options = { ...raw };

  // Simple defaults (independent of --source).
  if (options.layout === undefined) options.layout = 'auto';
  if (options.intermediateFormat === undefined) options.intermediateFormat = 'tmx';

  // Defaults derived from --source.
  if (options.source !== undefined) {
    const dir = path.resolve(path.dirname(options.source));
    const base = path.basename(options.source, path.extname(options.source));

    if (options.name === undefined) options.name = base;

    // Default intermediate path uses the ABSOLUTE directory of the source
    // (issue #8 requirement; the original script saves next to the source).
    if (options.intermediateOutput === undefined) {
      options.intermediateOutput =
        options.intermediateFormat === 'png'
          ? path.join(dir, `${base}_expanded.png`)
          : path.join(dir, `${base}.tmx`);
    }
  }

  // Default --tileset-format inferred from the --output extension.
  if (options.tilesetFormat === undefined && options.output !== undefined) {
    const ext = path.extname(options.output).toLowerCase();
    if (ext === '.tsx' || ext === '.xml') options.tilesetFormat = 'tsx';
    else if (ext === '.tsj' || ext === '.json') options.tilesetFormat = 'tsj';
  }

  return { options, provided };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** True when the value is a string of one or more digits forming an integer > 0. */
function isPositiveInteger(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return false;
  const n = Number(text);
  return Number.isSafeInteger(n) && n > 0;
}

/**
 * Validate a normalized options object (output of applyDefaults).
 *
 * `provided` is the Set returned by applyDefaults; consistency checks that
 * only make sense for user-supplied values consult it.
 *
 * Returns an array of human-readable error messages (empty when valid).
 */
function validateOptions(options, provided) {
  const errors = [];

  // Required options.
  for (const spec of OPTION_SPECS) {
    if (spec.required && options[spec.key] === undefined) {
      errors.push(`Missing required option: ${spec.long}`);
    }
  }

  // --source must exist and be a regular file.
  if (options.source !== undefined) {
    let stat;
    try {
      stat = fs.statSync(options.source);
    } catch (err) {
      errors.push(
        `Cannot access --source file "${options.source}": ${err.code || err.message}`
      );
    }
    if (stat && !stat.isFile()) {
      errors.push(`--source "${options.source}" is not a regular file`);
    }
  }

  // --tile-width / --tile-height must be positive integers.
  if (options.tileWidth !== undefined && !isPositiveInteger(options.tileWidth)) {
    errors.push(`--tile-width must be a positive integer, got "${options.tileWidth}"`);
  }
  if (options.tileHeight !== undefined && !isPositiveInteger(options.tileHeight)) {
    errors.push(`--tile-height must be a positive integer, got "${options.tileHeight}"`);
  }

  // Enumerated options.
  if (options.layout !== undefined && !LAYOUTS.includes(options.layout)) {
    errors.push(`--layout must be one of: ${LAYOUTS.join(', ')}; got "${options.layout}"`);
  }
  if (
    options.intermediateFormat !== undefined &&
    !INTERMEDIATE_FORMATS.includes(options.intermediateFormat)
  ) {
    errors.push(
      `--intermediate-format must be one of: ${INTERMEDIATE_FORMATS.join(', ')}; got "${options.intermediateFormat}"`
    );
  }
  if (options.tilesetFormat !== undefined && !TILESET_FORMATS.includes(options.tilesetFormat)) {
    errors.push(`--tileset-format must be one of: ${TILESET_FORMATS.join(', ')}; got "${options.tilesetFormat}"`);
  }

  // --transparent-color must be #RGB / #RRGGBB / #AARRGGBB.
  if (
    options.transparentColor !== undefined &&
    !TRANSPARENT_COLOR_RE.test(options.transparentColor)
  ) {
    errors.push(
      `--transparent-color must match #RGB, #RRGGBB or #AARRGGBB; got "${options.transparentColor}"`
    );
  }

  // --output extension must be a known tileset extension UNLESS --tileset-format
  // was explicitly supplied (then the forced format is authoritative).
  if (options.output !== undefined && !provided.has('tilesetFormat')) {
    const ext = path.extname(options.output).toLowerCase();
    if (!TILESET_OUTPUT_EXTENSIONS.includes(ext)) {
      errors.push(
        `--output must end with one of: ${TILESET_OUTPUT_EXTENSIONS.join(', ')} (or pass --tileset-format); got "${options.output}"`
      );
    }
  }

  // --intermediate-output extension must match --intermediate-format when BOTH
  // were supplied by the user (defaults are consistent by construction).
  if (provided.has('intermediateOutput') && provided.has('intermediateFormat')) {
    const expectedExt = INTERMEDIATE_EXTENSIONS[options.intermediateFormat];
    const ext = path.extname(options.intermediateOutput).toLowerCase();
    if (ext !== expectedExt) {
      errors.push(
        `--intermediate-output must end with "${expectedExt}" when --intermediate-format is ${options.intermediateFormat}; got "${options.intermediateOutput}"`
      );
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Combined entry points
// ---------------------------------------------------------------------------

/**
 * Parse + apply defaults + validate in one step.
 * Returns `{ options, errors, provided }`.
 */
function resolveArgs(argv) {
  const { options, errors: parseErrors } = parseArgs(argv);

  // `--help` short-circuits everything: usage is printed and the process
  // exits 0 regardless of any other (missing/invalid) arguments.
  if (options.help) {
    return { options, errors: [], provided: new Set() };
  }

  const errors = [...parseErrors];

  // Even when parse errors exist we still apply defaults and validate so a
  // single run reports as many problems as possible.
  const { options: normalized, provided } = applyDefaults(options);
  errors.push(...validateOptions(normalized, provided));

  return { options: normalized, errors, provided };
}

// ---------------------------------------------------------------------------
// Expansion pipeline (issue #8)
// ---------------------------------------------------------------------------

/**
 * Number of subtiles a CLEAN image of the given size would contain.
 *
 * The original script created its intermediate tileset with subtile size and
 * compared the naive subtile-grid count (`tilesetWidth * tilesetHeight`) with
 * the tileset's real `tileCount`; when margins/spacing were present the real
 * count was smaller and the check `tilesetWidth * tilesetHeight > tileCount`
 * fired. The CLI has no Tiled metadata, so it derives the "clean" count from
 * the full-tile grid: each full `tileWidth x tileHeight` tile holds exactly
 * 2x2 subtiles, so a clean image contains
 *   floor(imageWidth / tileWidth) * floor(imageHeight / tileHeight) * 4
 * subtiles. For a clean image (even tile size, exact multiples) this equals
 * `tilesetWidth * tilesetHeight`; leftover margin/spacing pixels make the
 * naive count larger and the guard fires.
 *
 * Exported for direct unit testing.
 *
 * @returns {number} the clean-image subtile count.
 */
function cleanTileCount(imageWidth, imageHeight, tileWidth, tileHeight) {
  return (
    Math.floor(imageWidth / tileWidth) *
    Math.floor(imageHeight / tileHeight) *
    4
  );
}

/**
 * Run the full expansion pipeline for already-validated options.
 *
 * This is the "meat" of `main`. It performs all file I/O and calls into the
 * pure library modules (png-decode, engine, tmx-writer, png-writer,
 * tileset-writer). It returns exit code 0 on success and THROWS an Error on
 * any failure so that `main` can consistently print `Error: <message>` to
 * stderr and exit 1.
 *
 * @param {object} options - normalized options (output of resolveArgs).
 * @param {object} stdout - writable stream for the success summary.
 * @param {object} stderr - writable stream for warnings.
 * @returns {number} 0 on success.
 */
function runExpansion(options, stdout, stderr) {
  // --- Load + decode the source image --------------------------------------
  const sourcePath = path.normalize(options.source);
  let sourceBuffer;
  try {
    sourceBuffer = fs.readFileSync(sourcePath);
  } catch (err) {
    throw new Error(
      `Cannot read --source file "${sourcePath}": ${err.code || err.message}`
    );
  }

  let sourceImage;
  try {
    sourceImage = decodePng(sourceBuffer);
  } catch (err) {
    throw new Error(
      `Failed to decode source image "${sourcePath}": ${err.message}`
    );
  }
  const imageWidth = sourceImage.width;
  const imageHeight = sourceImage.height;

  // --- Dimensions ------------------------------------------------------------
  const tileWidth = Number(options.tileWidth);
  const tileHeight = Number(options.tileHeight);
  const { subtileWidth, subtileHeight, tilesetWidth, tilesetHeight } =
    subtileDimensions(imageWidth, imageHeight, tileWidth, tileHeight);

  // --- Margins/spacing guard --------------------------------------------------
  // Replicates the original script's `tilesetWidth * tilesetHeight > tileCount`
  // check (which fired when margins/spacing were present). The original asked
  // the user "Continue anyway?"; the CLI aborts unless --allow-margins is given.
  const tileCount = cleanTileCount(imageWidth, imageHeight, tileWidth, tileHeight);
  if (tilesetWidth * tilesetHeight > tileCount) {
    const warning =
      `This tileset appears to have non-zero margins and/or spacing ` +
      `(naive subtile grid ${tilesetWidth}x${tilesetHeight}=` +
      `${tilesetWidth * tilesetHeight} exceeds the clean tile count ${tileCount}); ` +
      `this is unusual and may produce incorrect results.`;
    if (!options.allowMargins) {
      throw new Error(
        `${warning} Aborting. Re-run with --allow-margins to proceed anyway.`
      );
    }
    stderr.write(
      `Warning: ${warning} Proceeding because --allow-margins was supplied.\n`
    );
  }

  // --- Detect layout + expand the subtile grid --------------------------------
  const layout = detectLayout(tilesetWidth, tilesetHeight, options.layout);
  const grid = expand(layout, tilesetWidth, tilesetHeight);

  // --- Intermediate path + overwrite guard -------------------------------------
  const intermediatePath = options.intermediateOutput;
  if (fs.existsSync(intermediatePath) && !options.forceOverwrite) {
    throw new Error(
      `Intermediate file "${intermediatePath}" already exists. ` +
        'Re-run with --force-overwrite to overwrite it.'
    );
  }

  // --- Write the intermediate (TMX or PNG) --------------------------------------
  if (options.intermediateFormat === 'tmx') {
    const tmx = writeTmx({
      name: options.name,
      sourceImagePath: sourcePath, // written as provided (normalized)
      imageWidth,
      imageHeight,
      subtileWidth,
      subtileHeight,
      tilesetWidth,
      tilesetHeight,
      grid,
      transparentColor: options.transparentColor,
    });
    fs.writeFileSync(intermediatePath, tmx);
  } else {
    const rendered = renderExpandedImage(
      sourceImage,
      grid,
      subtileWidth,
      subtileHeight,
      tilesetWidth
    );
    fs.writeFileSync(intermediatePath, encodePng(rendered));
  }

  // Pixel dimensions of the expanded tileset (what Tiled shows for the
  // intermediate TMX rendered as an image, and exactly what the PNG renderer
  // produced). The final tileset uses these for its <image> width/height.
  const expandedWidth = grid[0].length * subtileWidth;
  const expandedHeight = grid.length * subtileHeight;

  // --- Write the final tileset (TSX/TSJ) -----------------------------------------
  const tilesetPath = path.normalize(options.output);
  const tileset = writeTileset({
    name: options.name,
    tileWidth,
    tileHeight,
    imagePath: intermediatePath, // the intermediate path as written
    imageWidth: expandedWidth,
    imageHeight: expandedHeight,
    transparentColor: options.transparentColor,
    format: options.tilesetFormat,
  });
  fs.writeFileSync(tilesetPath, tileset);

  // --- Success summary ------------------------------------------------------------
  stdout.write(`Intermediate: ${intermediatePath}\n`);
  stdout.write(`Tileset: ${tilesetPath}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// Usage / main
// ---------------------------------------------------------------------------

/** Human-readable usage text (also printed by --help). */
function usage() {
  return [
    'Usage: node tiled-expand-autotile-cli.js --source <image> --tile-width <px> --tile-height <px> --output <path> [options]',
    '',
    'Expand an RPG Maker autotile tileset into a full Tiled tileset.',
    '',
    'Required:',
    '  -i, --source <path>                 Source RPG Maker tileset image (PNG); must exist and be a regular file.',
    '  -w, --tile-width <px>               Full tile width; positive integer.',
    '  -h, --tile-height <px>              Full tile height; positive integer.',
    '  -o, --output <path>                 Output path for the final tileset (.tsx/.xml or .tsj/.json).',
    '',
    'Options:',
    '  -n, --name <name>                   Tileset name. Default: basename of --source (without extension).',
    '  -l, --layout <auto|a1|a2|a3|a4>     Autotile layout. Default: auto.',
    '  -f, --intermediate-format <tmx|png> Intermediate output format. Default: tmx.',
    '      --intermediate-output <path>    Intermediate file path. Default: <dir of source>/<basename>.tmx or <basename>_expanded.png.',
    '      --transparent-color <#RGB|#RRGGBB|#AARRGGBB>  Enable transparency and set the colour.',
    '      --force-overwrite               Overwrite an existing intermediate file instead of aborting.',
    '      --allow-margins                 Proceed even when non-zero margins/spacing are suspected.',
    '      --tileset-format <tsx|tsj>      Force final tileset format; default inferred from --output extension.',
    '      --help                          Print this usage and exit 0.',
    '',
  ].join('\n');
}

/**
 * CLI entry point.
 *
 * `io` is optional and used for testability:
 *   io.stdout / io.stderr — writable streams (default: process.stdout/stderr)
 *   io.exit(code)          — exit hook (default: sets process.exitCode)
 *
 * Returns the exit code (0 for help/success, 1 for errors).
 */
function main(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const doExit = io.exit || ((code) => { process.exitCode = code; });
  const writeError = (message) => stderr.write(`Error: ${message}\n`);

  const { options, errors } = resolveArgs(argv);

  // --help wins over everything else.
  if (options.help) {
    stdout.write(usage());
    doExit(0);
    return 0;
  }

  if (errors.length > 0) {
    for (const message of errors) {
      writeError(message);
    }
    stderr.write(`\n${ERROR_HINT}\n`);
    doExit(1);
    return 1;
  }

  // Run the full expansion pipeline. Any Error becomes a clean
  // "Error: <message>" on stderr with exit code 1.
  try {
    const code = runExpansion(options, stdout, stderr);
    doExit(code);
    return code;
  } catch (err) {
    writeError(err && err.message ? err.message : String(err));
    doExit(1);
    return 1;
  }
}

// Run directly: `node tiled-expand-autotile-cli.js [arguments...]`
if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  OPTION_SPECS,
  LAYOUTS,
  INTERMEDIATE_FORMATS,
  TILESET_FORMATS,
  ERROR_HINT,
  parseArgs,
  applyDefaults,
  validateOptions,
  resolveArgs,
  isPositiveInteger,
  usage,
  main,
  cleanTileCount,
  runExpansion,
};
