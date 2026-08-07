# Depot convention

A depot is a folder of textures that describes itself. Anything that can read
JSON and concatenate a URL can consume one — this document is the whole
contract, and a consumer needs **no dependency on depot-tools**.

The tool builds depots; the library reads them. Neither imports the other.

## Layout

```
my-depot/
  depot.json           written by you
  packs/
    <packname>/
      pack.json        written by you
      *.png            lossless sources — whatever you have
  manifest.json        generated
  dist/                generated
```

### depot.json

```json
{
  "id": "fernantastic-public",
  "baseUrl": "https://assets.fernantastic.dev/v1",
  "public": true
}
```

`baseUrl` is where `dist/` will be served from. `public: true` asserts that
everything here may be redistributed, and makes the build **refuse** on any pack
whose licence is `UNKNOWN`, `PRIVATE` or `PROPRIETARY`.

### pack.json

```json
{
  "title": "Luke's Generic Textures",
  "author": "Luke Vincent",
  "url": "https://lukewasthefish.itch.io/lukes-generic-textures",
  "license": "CC0-1.0",
  "tags": ["texture", "photo"],
  "requiresNotice": "optional — text that must ship alongside the files"
}
```

`tags` say what the pixels *are*; the build turns them into formats, sizes and
colour space. Everything else is provenance and travels into the manifest so a
consumer can render attribution without a second fetch.

## Keys

```
<packname>/<filename>.png
```

The pack folder name is the namespace. Keys always end `.png` regardless of the
real source extension — the key is an identifier, not a filename.

## manifest.json

```json
{
  "id": "fernantastic-public",
  "baseUrl": "https://assets.fernantastic.dev/v1",
  "public": true,
  "packs": {
    "novashader": { "title": "…", "author": "…", "license": "MIT", "tags": ["color"] }
  },
  "assets": {
    "novashader/tex_eff_aura02.png": {
      "pack": "novashader",
      "w": 600, "h": 600, "depth": 8, "alpha": true,
      "colorSpace": "srgb", "tiling": false, "master": true,
      "sha256": "…",
      "variants": {
        "avif": [{ "w": 512, "path": "avif/novashader/tex_eff_aura02@512.avif" }],
        "webp": [{ "w": 512, "path": "webp/novashader/tex_eff_aura02@512.webp" }]
      }
    }
  }
}
```

Resolving is one line:

```js
url = manifest.baseUrl + "/" + variant.path
```

### Fields a consumer should honour

| field | why it matters |
|---|---|
| `colorSpace` | `"data"` must be sampled raw — no sRGB decode. Getting this wrong looks like "my noise is washed out". |
| `tiling` | `REPEAT` vs `CLAMP_TO_EDGE` |
| `alpha` | whether to premultiply on upload |
| `depth` | `16` means only the PNG variant carries full precision |
| `master` | `false` = the source was already lossy; do not re-encode lossily |

## Loading

A consumer takes a list of depots — a URL or a local path — fetches
`manifest.json` from each, and merges the `assets` maps. Earlier depots win on a
key collision.

Depots are independent: a missing one degrades to "those textures do not load",
never to a hard failure, so a machine without the private depot still runs.

## CORS

Textures served cross-origin **must** send `Access-Control-Allow-Origin`, and
the consumer must set `img.crossOrigin = "anonymous"`. Without both, every
textured canvas is tainted and `toDataURL` / `toBlob` / `readPixels` throw —
which breaks screenshot and video export, silently, at export time rather than
at load time.

## Building

```bash
npx depot path/to/my-depot
npx depot path/to/my-depot --dry --only novashader
```

See [ENCODERS.md](ENCODERS.md) for the measurements behind the format rules —
notably why the lossless path is WebP rather than AVIF.
