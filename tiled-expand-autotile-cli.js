#!/usr/bin/env node
'use strict';

/**
 * tiled-expand-autotile-cli.js
 *
 * Command-line front-end for expanding RPG Maker autotile tilesets into
 * full Tiled tilesets.
 *
 * This story (issue #6) implements ONLY the argument parser and validation
 * contract. No image processing is performed here; later stories wire up the
 * actual expansion against this frozen contract.
 *
 * Design notes:
 *  - Zero third-party dependencies; Node built-ins only.
 *  - When executed directly (`require.main === module`) we call main().
 *    When required by tests we export the parse/validate helpers below.
 *  - Repeated scalar options: last one wins (e.g. `--layout a1 --layout a3`
 *    results in layout === 'a3').
 *  - The script never reads stdin, so it can never block on a prompt.
 */

const fs = require('node:fs');
const path = require('node:path');

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
    const dir = path.dirname(options.source);
    const base = path.basename(options.source, path.extname(options.source));

    if (options.name === undefined) options.name = base;

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

  const { options, errors } = resolveArgs(argv);

  // --help wins over everything else.
  if (options.help) {
    stdout.write(usage());
    doExit(0);
    return 0;
  }

  if (errors.length > 0) {
    for (const message of errors) {
      stderr.write(`Error: ${message}\n`);
    }
    stderr.write(`\n${ERROR_HINT}\n`);
    doExit(1);
    return 1;
  }

  // This story only validates the contract; actual expansion is added later.
  doExit(0);
  return 0;
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
};
