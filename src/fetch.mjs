#!/usr/bin/env node
/**
 * Download a depot so an app can serve it itself.
 *
 *   node fetch.mjs <remote-url> <dest-folder>
 *   node fetch.mjs https://pub-xxxx.r2.dev/v1 public/depots/shaderlibrary-assets
 *
 * The remote depot is a distribution channel, not a runtime CDN. You fetch it
 * once — like installing a package — and from then on the textures are local:
 * the dev server serves them, and a production build ships them with the rest
 * of the app, same-origin. Nothing reaches for the bucket at render time.
 *
 * That is why the destination usually lives under the app's `public/` folder:
 * Vite serves public/ in dev and copies it into dist/ on build, so both halves
 * work with no plugin and no middleware.
 *
 * Re-running is cheap: files already present with the right size are skipped,
 * so this doubles as "update to whatever the bucket has now".
 */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

const [remote, dest] = process.argv.slice(2);
if (!remote || !dest) {
  console.error("usage: fetch.mjs <remote-url> <dest-folder>");
  process.exit(1);
}
const base = remote.replace(/\/+$/, "");
const out = path.resolve(dest);
const force = process.argv.includes("--force");

console.log(`fetching ${base}`);
const res = await fetch(`${base}/manifest.json`);
if (!res.ok) {
  console.error(`could not read ${base}/manifest.json — HTTP ${res.status}`);
  process.exit(1);
}
const manifest = await res.json();

// Every variant the manifest lists, deduplicated: two assets can legitimately
// point at the same file, and downloading it twice is pure waste.
const paths = [
  ...new Set(
    Object.values(manifest.assets).flatMap((a) =>
      Object.values(a.variants).flatMap((list) => list.map((v) => v.path)),
    ),
  ),
];

console.log(`  ${Object.keys(manifest.assets).length} assets, ${paths.length} files`);

let done = 0, skipped = 0, failed = [];
const QUEUE = [...paths];

async function get(rel) {
  // Flat, NOT under dist/. The manifest's variant paths are relative to
  // manifest.json, so the download has to mirror that or every URL gains a
  // spurious /dist/ segment. It is also exactly the bucket's layout, which is
  // the point: a fetched depot and a published one are the same shape.
  const abs = path.join(out, rel);
  // Size is enough to tell "already have it" from "never downloaded": published
  // paths are immutable, so a file that exists at the right length is the file.
  if (!force && fsSync.existsSync(abs)) {
    const head = await fetch(`${base}/${rel}`, { method: "HEAD" });
    const len = Number(head.headers.get("content-length") ?? -1);
    if (len >= 0 && fsSync.statSync(abs).size === len) { skipped++; return; }
  }
  const r = await fetch(`${base}/${rel}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, Buffer.from(await r.arrayBuffer()));
}

await Promise.all(
  Array.from({ length: 16 }, async () => {
    for (let rel; (rel = QUEUE.shift()); ) {
      try { await get(rel); }
      catch (e) { failed.push(rel); console.error(`  FAILED ${rel}: ${e.message}`); }
      if (++done % 50 === 0) console.log(`  ${done}/${paths.length}`);
    }
  }),
);

// The manifest lands last, so an interrupted fetch leaves a folder without an
// index rather than an index promising files that are not there.
if (failed.length) {
  console.error(`\n${failed.length} download(s) failed; manifest not written.`);
  process.exit(1);
}

// baseUrl is cleared deliberately. It records where the depot was published,
// which is not where it now lives — a consumer resolves against the path it
// loaded the depot from, and a stale absolute URL here would send it back to
// the bucket at runtime, which is the whole thing this avoids.
manifest.baseUrl = "";
await fs.writeFile(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

const bytes = paths.reduce((s, p) => {
  const f = path.join(out, p);
  return s + (fsSync.existsSync(f) ? fsSync.statSync(f).size : 0);
}, 0);

console.log(`\ndone — ${paths.length} files (${skipped} already current), ${(bytes / 1048576).toFixed(0)} MB`);
console.log(`  ${out}`);
