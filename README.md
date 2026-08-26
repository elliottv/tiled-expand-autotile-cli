# tiled-expand-autotile-cli

Expand RPG Maker autotile tilesets into full Tiled tilesets from the command line.

## CLI contract

```
node tiled-expand-autotile-cli.js --source <image> --tile-width <px> --tile-height <px> --output <path> [options]
```

### Required

| Option | Description |
| --- | --- |
| `-i, --source <path>` | Source RPG Maker tileset image (PNG). Must exist and be a regular file. |
| `-w, --tile-width <px>` | Full tile width, positive integer. |
| `-h, --tile-height <px>` | Full tile height, positive integer. |
| `-o, --output <path>` | Output path for the final tileset (`.tsx`/`.xml` or `.tsj`/`.json`). |

### Options

| Option | Description |
| --- | --- |
| `-n, --name <name>` | Tileset name. Default: basename of `--source` (without extension). |
| `-l, --layout <auto\|a1\|a2\|a3\|a4>` | Autotile layout. Default: `auto`. |
| `-f, --intermediate-format <tmx\|png>` | Intermediate output format. Default: `tmx`. |
| `--intermediate-output <path>` | Intermediate file path. Default: `<dir of source>/<basename>.tmx` or `<basename>_expanded.png`. |
| `--transparent-color <#RGB\|#RRGGBB\|#AARRGGBB>` | Enable transparency and set the colour. |
| `--force-overwrite` | Overwrite an existing intermediate file instead of aborting. |
| `--allow-margins` | Proceed even when non-zero margins/spacing are suspected. |
| `--tileset-format <tsx\|tsj>` | Force final tileset format; default inferred from `--output` extension. |
| `--help` | Print usage and exit 0. |

Options support both `--opt value` and `--opt=value` forms, plus the short
aliases `-i -w -h -o -n -l -f`. Repeated scalar options: last one wins.

Errors are printed to stderr as `Error: <message>` (plus a usage hint) with
exit code 1; `--help` prints usage to stdout and exits 0. The CLI never reads
stdin, so it can never block on an interactive prompt.

## Development

```sh
node --test tests/cli-args.test.js   # Node >= 18, no third-party dependencies
```
