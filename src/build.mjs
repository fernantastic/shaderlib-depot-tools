#!/usr/bin/env node
/**
 * Turn a depot folder into a usable depot.
 *
 *   node build-depot.mjs <depot-folder>
 *
 * A depot is just a folder. To make one:
 *
 *   my-depot/
 *     depot.json           { "id": "...", "baseUrl": "..." }
 *     packs/
 *       <packname>/
 *         pack.json        { "license": "...", "tags": ["noise"], ... }
 *         *.png            lossless sources, whatever you have
 *
 * Run this on it and you get dist/ (every format and size the tags call for)
 * plus manifest.json (the index the library reads). Nothing else to register:
 * the folder describes itself, so a depot is portable — move it, mirror it to a
 * bucket, or keep it on a local disk, and it still works.
 *
 * Keys are `<packname>/<file>.png`. The pack folder name IS the namespace, so
 * there is no mapping table to keep in sync: what you name the folder is what
 * shaders address.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { policyFor, formatsFor } from "./policy.mjs";

const exec = promisify(execFile);

const root = path.resolve(process.argv[2] ?? ".");
const dry = process.argv.includes("--dry");
const only = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1]
  : null;

const depot = JSON.parse(await fs.readFile(path.join(root, "depot.json"), "utf8"));
const PACKS = path.join(root, "packs");
const DIST = path.join(root, "dist");

const SRC_RE = /\.(png|webp|jpe?g|tga|exr|hdr)$/i;

/** ffprobe one image: dimensions + pixel format. */
async function probe(file) {
  const { stdout } = await exec("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,pix_fmt", "-of", "json", file,
  ]);
  const s = JSON.parse(stdout).streams?.[0] ?? {};
  return { w: s.width ?? null, h: s.height ?? null, pixFmt: s.pix_fmt ?? null };
}

/**
 * Is this source already a lossy encode? If so we may not lossy-encode from it:
 * a second lossy pass compresses the first encoder's blocking artifacts as if
 * they were detail, giving files that are both bigger and worse.
 *
 * WebP records it in the RIFF chunk type — "VP8L" lossless, "VP8 " lossy,
 * "VP8X" extended (treated as suspect rather than assumed safe).
 */
function isLossyOrigin(file, buf) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".png" || ext === ".exr" || ext === ".hdr" || ext === ".tga") return false;
  if (ext === ".webp") return buf.subarray(12, 16).toString("latin1") !== "VP8L";
  return true; // jpeg and anything unrecognised
}

async function encode(srcAbs, outAbs, { fmt, lossless, quality }, width) {
  if (dry) return;
  await fs.mkdir(path.dirname(outAbs), { recursive: true });
  const resize = width ? ["-resize", `${width}x${width}>`] : [];

  // Unresized PNG is copied verbatim so bit depth survives — the only reason
  // the PNG variant exists is 16-bit sources that AVIF and WebP cannot carry.
  if (fmt === "png" && !width) return void (await fs.copyFile(srcAbs, outAbs));
  if (fmt === "png") return void (await exec("magick", [srcAbs, ...resize, outAbs]));
  if (lossless) {
    return void (await exec("magick", [srcAbs, ...resize, "-define", `${fmt}:lossless=true`, outAbs]));
  }
  await exec("magick", [srcAbs, ...resize, "-quality", String(quality), outAbs]);
}

const manifest = {
  id: depot.id,
  baseUrl: depot.baseUrl,
  public: depot.public === true,
  generated: new Date().toISOString(),
  packs: {},
  assets: {},
};

const packNames = (await fs.readdir(PACKS, { withFileTypes: true }))
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

let emitted = 0;
const warnings = [];

for (const pack of packNames) {
  // `--only` narrows what gets ENCODED, never what gets catalogued. Skipping
  // packs outright here would write a manifest describing just the one pack,
  // silently deleting every other asset from the depot's index.
  const encodeThis = !only || pack === only;
  const dir = path.join(PACKS, pack);

  let meta = {};
  try {
    meta = JSON.parse(await fs.readFile(path.join(dir, "pack.json"), "utf8"));
  } catch {
    warnings.push(`${pack}: no pack.json — provenance and licence unrecorded`);
  }
  if (!meta.license) warnings.push(`${pack}: no licence recorded`);
  if (!meta.tags?.length) warnings.push(`${pack}: no tags — using conservative defaults`);

  const pol = policyFor(meta.tags);
  manifest.packs[pack] = {
    title: meta.title ?? pack,
    author: meta.author ?? "",
    url: meta.url ?? "",
    license: meta.license ?? "UNKNOWN",
    tags: meta.tags ?? [],
    ...(meta.requiresNotice ? { requiresNotice: meta.requiresNotice } : {}),
  };

  for (const name of (await fs.readdir(dir)).sort()) {
    if (!SRC_RE.test(name)) continue;
    const srcAbs = path.join(dir, name);
    const buf = await fs.readFile(srcAbs);
    const { w, h, pixFmt } = await probe(srcAbs);
    const lossyOrigin = isLossyOrigin(srcAbs, buf);

    const key = `${pack}/${name.replace(/\.[^.]+$/, "")}.png`;
    const variants = {};

    const depth = pixFmt?.includes("16") ? 16 : 8;
    for (const spec of formatsFor({ kind: pol.kind, lossyOrigin, depth })) {
      for (const width of pol.sizes) {
        if (width && w && width > w) continue; // never upscale
        const stem = key.replace(/\.png$/, "");
        const rel = `${spec.fmt}/${stem}${width ? `@${width}` : ""}.${spec.fmt}`;
        // Variants are recorded either way: the manifest describes the depot,
        // not this run. Skipping the encode leaves already-built files in place.
        if (encodeThis) {
          await encode(srcAbs, path.join(DIST, rel), spec, width);
          emitted++;
        }
        (variants[spec.fmt] ??= []).push({ w: width ?? w, path: rel });
      }
    }

    manifest.assets[key] = {
      pack,
      w, h,
      depth,
      alpha: pixFmt ? /a|pal/.test(pixFmt) : false,
      colorSpace: pol.colorSpace,
      tiling: !!pol.tiling,
      // Honest record of what the bytes are, so a later re-encode knows whether
      // it is allowed to go lossy.
      master: !lossyOrigin,
      sha256: createHash("sha256").update(buf).digest("hex").slice(0, 16),
      variants,
    };
  }
}

if (!dry) {
  await fs.mkdir(DIST, { recursive: true });
  await fs.writeFile(
    path.join(root, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
}

const n = Object.keys(manifest.assets).length;
console.log(`depot      ${manifest.id}${manifest.public ? "" : "  (private)"}`);
console.log(`packs      ${Object.keys(manifest.packs).length}`);
console.log(`assets     ${n}`);
console.log(`variants   ${emitted}`);

// A public depot has to be able to say why each pack may be redistributed.
if (manifest.public) {
  const unclear = Object.entries(manifest.packs)
    .filter(([, p]) => !p.license || /^(UNKNOWN|PRIVATE|PROPRIETARY)$/.test(p.license))
    .map(([k]) => k);
  if (unclear.length) {
    console.error(`\nREFUSING: public depot contains packs with unclear licences:`);
    for (const p of unclear) console.error(`  ${p}: ${manifest.packs[p].license}`);
    console.error(`Move them to a private depot, or record a licence in pack.json.`);
    process.exit(1);
  }
}

for (const w of warnings) console.warn(`warn  ${w}`);
if (dry) console.log("\n(dry run — nothing written)");
