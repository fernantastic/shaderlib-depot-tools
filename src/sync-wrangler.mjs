#!/usr/bin/env node
/**
 * Publish a depot to Cloudflare R2 using wrangler.
 *
 *   node sync-wrangler.mjs <depot-folder> <bucket> [prefix]
 *   node sync-wrangler.mjs ../shaderlibrary-assets fernantastic-assets v1
 *
 * Use this when you authenticated with `wrangler login` and would rather not
 * mint an S3 API token. wrangler uploads one object per invocation, so cost is
 * dominated by process launches, not bytes — which is why this resolves the
 * wrangler entry point once and runs it with `node` directly. Going through
 * `npx` each time measured 2474ms per call against 894ms direct: 2.8x, and on
 * 775 files that is the difference between five minutes and under two.
 *
 * Uploads dist/ and manifest.json into one flat prefix — the layout the
 * manifest assumes: manifest.json at the root, variant paths relative to it.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

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

/** Resolve wrangler's entry point once; every upload reuses it. */
function findWrangler() {
  const roots = [
    path.join(process.cwd(), "node_modules/wrangler/bin/wrangler.js"),
    ...fsSync.existsSync(path.join(os.homedir(), "AppData/Local/npm-cache/_npx"))
      ? fsSync.readdirSync(path.join(os.homedir(), "AppData/Local/npm-cache/_npx"))
          .map((d) => path.join(os.homedir(), "AppData/Local/npm-cache/_npx", d, "node_modules/wrangler/bin/wrangler.js"))
      : [],
  ];
  return roots.find((p) => fsSync.existsSync(p)) ?? null;
}
const WRANGLER = findWrangler();
if (!WRANGLER) {
  console.error("wrangler not found — run `npx wrangler login` once first.");
  process.exit(1);
}

async function put(localAbs, remoteKey, cacheControl) {
  await exec(process.execPath, [
    WRANGLER, "r2", "object", "put", `${bucket}/${remoteKey}`,
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
// Concurrency is tuned for process launches rather than bandwidth: each upload
// is its own node process, and the work is almost entirely startup.
await Promise.all(Array.from({ length: 12 }, async () => {
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
