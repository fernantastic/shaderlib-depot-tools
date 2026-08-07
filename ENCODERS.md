# Encoder findings

Measured on this machine (ImageMagick 7.1.1-Q16-HDRI w/ libheif 1.18.2,
ffmpeg N-112724 w/ libaom-av1). Re-run before trusting these on a new toolchain.

## 1. AVIF "lossless" is not lossless here

Round-tripping a 2048×2048 8-bit greyscale master and counting differing pixels
with `magick compare -metric AE`:

| invocation | diff (of 4,194,304 px) | size |
|---|---|---|
| `magick -define heic:lossless=true` | 4,189,560 | 23,111 |
| `ffmpeg libaom -lossless 1` | 4,189,480 | 21,462 |
| `+ -pix_fmt gray` | 2,927,530 | 23,999 |
| `+ -color_range pc` | 2,927,530 | 23,999 |
| `+ -pix_fmt yuv444p -color_range pc` | 3,963,260 | 20,646 |
| **`magick -define webp:lossless=true`** | **0** | **854,018** |
| PNG (8-bit reference) | 0 | 997,765 |

Every AVIF path alters ~70–100% of pixels and yields a ~40× reduction, which is
impossible losslessly. The `-lossless 1` flag is silently not reaching libaom.

**Consequence:** the lossless path uses WebP, which is bit-exact *and* smaller
than PNG. No AVIF is emitted for data textures. See `formatsFor()` in
`scripts/policy.mjs`.

## 2. Bit depth is a hard ceiling

The noise masters are **2048×2048, 16-bit, single-channel greyscale**. AVIF and
WebP are both 8-bit — neither can carry them. 8-bit quantisation measures 58.9 dB
PSNR, which sounds harmless, but PSNR does not capture banding, and these are
smooth fields where banding is precisely the failure mode.

So PNG is kept as the **precision variant**, not a compatibility fallback. It is
the only one of the three formats that can represent the source at all.

## 3. Lossy: AVIF's win is real but modest on this content

`lukesgenerictextures/ground_stone.png` (2790×2790 sRGBA master, 19.9 MB):

| encoding | size | PSNR |
|---|---|---|
| avif q50 | 1,621,889 | 33.20 |
| avif q62 | 2,354,657 | 36.65 |
| avif q72 | 2,773,485 | 38.30 |
| avif q82 | 3,489,819 | 40.52 |
| webp q82 | 2,792,550 | 37.10 |
| webp q90 | 3,648,006 | 40.09 |
| **webp q99 (what shipped)** | **5,420,182** | **43.38** |

AVIF q82 beats WebP q90 on both axes, but only by ~5% — well short of the
20–35% usually quoted. PSNR does under-rate AVIF (it rewards blur), so the
perceptual gap is wider than the table suggests, but the honest headline is:

**the format was never the problem — `-quality 99` was.** Dropping to AVIF q82
is a 36% saving at visually equivalent quality; q72 is 49%.

## 4. Alpha

Only `gui/` has a real alpha channel. `sprites/` and `brushstrokes/` are
3-channel with no alpha — they are additive-blend luminance masks on black.
They are also effectively greyscale, so a single-channel encode is available as
a further ~3× saving if wanted.
