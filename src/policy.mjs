/**
 * Encoding policy, driven by TAGS rather than pack names.
 *
 * Packs identify provenance ("who made this, under what licence"); tags
 * identify what the pixels are ("noise", "hdri", "math"). Encoding cares only
 * about the latter — two noise packs from different authors want identical
 * treatment — so the policy table is keyed by tag.
 *
 * A pack's first matching tag wins. Adding a file to a pack picks up that
 * pack's tags automatically, which is what stops the Bayer-dither class of bug:
 * a 4x4 matrix of exact threshold values was shipped through lossy DCT at
 * -quality 99 because the old convert.bat applied one rule to everything.
 *
 *   kind        "data"  exact pixel values are load-bearing. Lossless always.
 *               "photo" natural image content. Lossy AVIF is a clear win.
 *               "alpha" cutout/sprite art. Edges matter more than interiors.
 *
 *   colorSpace  "srgb"  decode through sRGB on upload (pictures)
 *               "data"  sample raw, no transfer function (noise, gradients,
 *                       dither matrices, masks). Getting this wrong looks like
 *                       "my noise is washed out" and is horrible to debug.
 *
 *   sizes       widths to emit, largest first. null = keep native size.
 *   tiling      seamless, so consumers should use REPEAT not CLAMP_TO_EDGE.
 */
export const TAGS = {
  noise: {
    kind: "data",
    colorSpace: "data",
    sizes: [2048, 1024, 512],
    tiling: true,
  },
  math: {
    kind: "data",
    colorSpace: "data",
    sizes: [null], // dither matrices are 4x4/8x8 — resizing them is meaningless
    tiling: true,
    noMipmaps: true,
  },
  gradient: {
    kind: "data",
    colorSpace: "data",
    sizes: [null],
    tiling: false,
  },
  texture: {
    kind: "photo",
    colorSpace: "srgb",
    sizes: [2048, 1024, 512],
    tiling: true,
  },
  color: {
    kind: "photo",
    colorSpace: "srgb",
    sizes: [1024, 512],
    tiling: false,
  },
  hdri: {
    kind: "photo",
    colorSpace: "srgb",
    sizes: [4096, 2048],
    tiling: false,
    equirect: true,
  },
  sprite: {
    kind: "alpha",
    colorSpace: "srgb",
    sizes: [512],
    tiling: false,
  },
  brush: {
    kind: "alpha",
    colorSpace: "srgb",
    sizes: [1024, 512],
    tiling: false,
  },
  gui: {
    kind: "alpha",
    colorSpace: "srgb",
    sizes: [null],
    tiling: false,
  },
};

/** Untagged content gets conservative treatment rather than an error, so a new
 *  pack does something sane before its tags are tuned. */
export const DEFAULT_POLICY = {
  kind: "data",
  colorSpace: "data",
  sizes: [null],
  tiling: false,
};

/** First tag with a policy wins; order tags most-specific-first in packs.json. */
export function policyFor(tags = []) {
  for (const t of tags) if (TAGS[t]) return { ...DEFAULT_POLICY, ...TAGS[t] };
  return DEFAULT_POLICY;
}

/**
 * Which output formats to emit for one asset.
 *
 * The `lossyOrigin` guard is the important rule: when the only source is
 * already a lossy WebP (private-brushes, polyhaven's LDR jpeg), a lossy
 * re-encode compresses the first encoder's blocking artifacts *as if they were
 * detail* — bigger files AND worse pixels. Lossless is both honest and smaller.
 *
 * No lossless AVIF: measured, it is not actually lossless in this toolchain.
 * See ENCODERS.md. Lossless WebP was verified bit-exact and beats 8-bit PNG on
 * size; PNG rides along because it is the only one that carries >8 bits, which
 * the 16-bit noise masters need.
 */
export function formatsFor({ kind, lossyOrigin }) {
  if (kind === "data" || lossyOrigin) {
    return [
      { fmt: "webp", lossless: true },
      { fmt: "png", lossless: true },
    ];
  }
  return [
    { fmt: "avif", lossless: false, quality: kind === "alpha" ? 78 : 68 },
    { fmt: "webp", lossless: false, quality: kind === "alpha" ? 88 : 82 },
  ];
}
