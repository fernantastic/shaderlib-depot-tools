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
 *
 * A public r2.dev URL is rate limited, and a depot is hundreds of files, so
 * every request goes through `req` below: it backs off and retries rather than
 * treating a 429 as a dead file. Without that a cold fetch of a large depot
 * fails somewhere in the middle, which is exactly when it matters.
 *
 *   --jobs N     parallel downloads (default 8)
 *   --force      re-download even files already present at the right size
 *   --scan DIR   fetch only the assets DIR's source actually references
 *                (repeatable). The manifest is cut down to match, so this is
 *                fetch and prune in one pass — a build wants the handful of
 *                textures it ships, not the whole published depot, and
 *                downloading 108 MB to keep 1 MB is a cost paid on every
 *                deploy. Without it you get everything, which is what a dev
 *                machine wants: the dropdown browses the full set.
 */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { usedKeys, restrictManifest, keptPaths } from "./scan.mjs";

const args = process.argv.slice(2);

// --scan and --jobs each consume the value after them, so those values must not
// be mistaken for the two positional arguments.
const consumed = new Set();
const scanDirs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--scan" || args[i] === "--jobs") {
    consumed.add(i);
    consumed.add(i + 1);
    if (args[i] === "--scan" && args[i + 1]) scanDirs.push(args[i + 1]);
  }
}
const [remote, dest] = args.filter((a, i) => !a.startsWith("--") && !consumed.has(i));
if (!remote || !dest) {
  console.error(
    "usage: fetch.mjs <remote-url> <dest-folder> [--scan DIR]... [--jobs N] [--force]",
  );
  process.exit(1);
}
const base = remote.replace(/\/+$/, "");
const out = path.resolve(dest);
const force = args.includes("--force");
const jobsFlag = args.indexOf("--jobs");
const JOBS = jobsFlag === -1 ? 8 : Math.max(1, Number(args[jobsFlag + 1]) || 8);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch, but patient. 429 is not "this file is missing", it is "ask again
 * later", and the bucket says how much later often enough to be worth
 * honouring. Everything transient — rate limits, 5xx, a dropped socket — comes
 * back here; a 404 does not, because no amount of waiting will fix it.
 *
 * The jitter matters more than the backoff: without it the whole worker pool
 * retries in lockstep and reproduces the burst that caused the 429.
 */
async function req(url, opts = {}, attempts = 6) {
  for (let i = 0; ; i++) {
    let res, err;
    try {
      res = await fetch(url, opts);
      if (res.status !== 429 && res.status < 500) return res;
    } catch (e) {
      err = e;
    }
    if (i >= attempts - 1) {
      if (err) throw err;
      throw new Error(`HTTP ${res.status} after ${attempts} attempts`);
    }
    const retryAfter = Number(res?.headers.get("retry-after"));
    const backoff = retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** i;
    await sleep(Math.min(backoff, 30_000) * (0.5 + Math.random()));
  }
}

console.log(`fetching ${base}`);
const res = await req(`${base}/manifest.json`);
if (!res.ok) {
  console.error(`could not read ${base}/manifest.json — HTTP ${res.status}`);
  process.exit(1);
}
const manifest = await res.json();
const published = Object.keys(manifest.assets).length;

// With --scan the manifest is cut to the referenced keys before anything is
// downloaded, so the queue below is built from what survives. Same rule prune
// uses, from the same module, so "what a build fetches" and "what a build
// keeps" cannot drift apart.
if (scanDirs.length) {
  const { used, scanned, missing } = await usedKeys(Object.keys(manifest.assets), scanDirs);
  for (const d of missing) console.warn(`  skipping missing scan dir ${d}`);

  // The same refusal prune makes, for the same reason: no matches almost
  // certainly means a wrong scan path, and acting on it would fetch nothing
  // and write a manifest claiming the depot is empty.
  if (!used.size) {
    console.error("REFUSING: no keys matched — that is almost certainly a wrong --scan path.");
    process.exit(1);
  }
  restrictManifest(manifest, used);
  console.log(`  scanned ${scanned} files in ${scanDirs.join(", ")}`);
  console.log(`  ${used.size} of ${published} keys referenced`);
}

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
    const head = await req(`${base}/${rel}`, { method: "HEAD" });
    const len = Number(head.headers.get("content-length") ?? -1);
    if (len >= 0 && fsSync.statSync(abs).size === len) { skipped++; return; }
  }
  const r = await req(`${base}/${rel}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, Buffer.from(await r.arrayBuffer()));
}

await Promise.all(
  Array.from({ length: JOBS }, async () => {
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

// A scanned fetch has to sweep, not just skip. The destination may already
// hold a full depot from an earlier unscanned run — public/ is exactly such a
// folder — and Vite copies all of public/ into dist/, so files left behind
// would ship even though the manifest no longer lists them. Downloading less
// is only half of shipping less.
if (scanDirs.length) {
  const keep = keptPaths(manifest, new Set(Object.keys(manifest.assets)));
  let swept = 0, freed = 0;
  function* onDisk(dir) {
    for (const e of fsSync.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) yield* onDisk(abs);
      else yield path.relative(out, abs).replaceAll("\\", "/");
    }
  }
  for (const rel of [...onDisk(out)]) {
    if (rel === "manifest.json" || keep.has(rel)) continue;
    freed += fsSync.statSync(path.join(out, rel)).size;
    await fs.rm(path.join(out, rel), { force: true });
    swept++;
  }
  // Prune empty directories, so the tree does not fill with husks.
  (function pruneEmpty(dir) {
    for (const e of fsSync.readdirSync(dir, { withFileTypes: true }))
      if (e.isDirectory()) pruneEmpty(path.join(dir, e.name));
    if (dir !== out && !fsSync.readdirSync(dir).length) fsSync.rmdirSync(dir);
  })(out);
  if (swept) console.log(`swept ${swept} unreferenced file(s) (${(freed / 1048576).toFixed(0)} MB)`);
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
