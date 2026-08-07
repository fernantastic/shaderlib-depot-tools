#!/usr/bin/env node
/**
 * Publish a depot to Cloudflare R2 using wrangler.
 *
 *   node sync-wrangler.mjs <depot-folder> <bucket> [prefix]
 *   node sync-wrangler.mjs ../shaderlibrary-assets fernantastic-assets v1
 *
 * Use this when you authenticated with `wrangler login` and would rather not
 * mint an S3 API token. It is slower than sync.sh (rclone): wrangler uploads
 * one object per invocation, so a few hundred files means a few hundred process
 * launches. Correctness is identical; only throughput differs.
 *
 * Uploads dist/ and manifest.json into one flat prefix — the layout the
 * manifest assumes: manifest.json at the root, variant paths relative to it.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

const exec = promisify(execFile);

const [depotArg, bucket, prefix = ""] = process.argv.slice(2);
if (!depotArg || !bucket) {
  console.error("usage: sync-wrangler.mjs <depot-folder> <bucket> [prefix]");
  process.exit(1);
}
const root = path.resolve(depotArg);
const DIST = path.join(root, "dist");

const depot = JSON.parse(await fs.readFile(path.join(root, "depot.json"), "utf8"));

// A depot is private because something in it may not be redistributed. The
// build enforces the same rule; repeating it here means a fumbled path on the
// command line cannot publish what a licence forbids.
if (depot.public !== true) {
  console.error(`REFUSING: ${depotArg}/depot.json does not declare "public": true.`);
  process.exit(1);
}
if (!fsSync.existsSync(path.join(root, "manifest.json"))) {
  console.error(`no manifest.json in ${depotArg} — run: npx depot ${depotArg}`);
  process.exit(1);
}

/** Every file under dist/, relative to it. */
function walk(dir, base = dir) {
  return fsSync.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const abs = path.join(dir, e.name);
    return e.isDirectory() ? walk(abs, base) : [path.relative(base, abs).replaceAll("\\", "/")];
  });
}

const files = walk(DIST);

// Fail before uploading rather than halfway: a manifest listing a variant that
// was never encoded would publish a bucket that 404s once per frame.
const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
const missing = [];
for (const a of Object.values(manifest.assets))
  for (const list of Object.values(a.variants))
    for (const v of list) if (!fsSync.existsSync(path.join(DIST, v.path))) missing.push(v.path);
if (missing.length) {
  console.error(`INCOMPLETE: ${missing.length} variant(s) missing from dist/. Rebuild first.`);
  process.exit(1);
}

const key = (rel) => (prefix ? `${prefix}/${rel}` : rel);
const CT = {
  ".avif": "image/avif", ".webp": "image/webp", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".json": "application/json",
};

async function put(localAbs, remoteKey, cacheControl) {
  await exec("npx", [
    "--yes", "wrangler@latest", "r2", "object", "put", `${bucket}/${remoteKey}`,
    "--file", localAbs,
    "--content-type", CT[path.extname(localAbs).toLowerCase()] ?? "application/octet-stream",
    "--cache-control", cacheControl,
    "--remote",
  ], { maxBuffer: 1 << 24 });
}

// Content only ever gets added to under a versioned prefix, so a long max-age
// costs nothing. Publish a breaking change by bumping the prefix rather than
// mutating what is already out there.
const IMMUTABLE = "public, max-age=31536000, immutable";

console.log(`uploading ${files.length} files to ${bucket}${prefix ? "/" + prefix : ""}`);
let done = 0, failed = [];
const QUEUE = [...files];
// Modest concurrency: each upload is its own npx process, so too many at once
// costs more in process launches than it gains in parallelism.
await Promise.all(Array.from({ length: 6 }, async () => {
  for (let rel; (rel = QUEUE.shift()); ) {
    try { await put(path.join(DIST, rel), key(rel), IMMUTABLE); }
    catch (e) { failed.push(rel); console.error(`  FAILED ${rel}: ${String(e).slice(0, 120)}`); }
    if (++done % 25 === 0) console.log(`  ${done}/${files.length}`);
  }
}));

// Last, and deliberately not immutable: this is the one file that changes when
// the depot does, and publishing it before its variants would point clients at
// objects that are not there yet.
if (!failed.length) {
  await put(path.join(root, "manifest.json"), key("manifest.json"), "public, max-age=60");
  console.log(`\ndone — ${files.length} files + manifest.json`);
  console.log(`Set this depot's baseUrl to the bucket's public URL, then:`);
  console.log(`  npx depot ${depotArg} --manifest-only`);
} else {
  console.error(`\n${failed.length} upload(s) failed; manifest.json NOT published.`);
  process.exitCode = 1;
}
