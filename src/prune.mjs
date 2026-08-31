#!/usr/bin/env node
/**
 * Drop every texture an app does not reference.
 *
 *   node prune.mjs <depot-folder> <scan-dir> [<scan-dir> ...]
 *   node prune.mjs public/depots/shaderlibrary-assets src
 *
 * A fetched depot holds everything published. A build only needs what the app
 * actually asks for, and shipping 400 textures to render three is a cost paid
 * on every deploy and every page load.
 *
 * Which keys count as used, and how the manifest is rewritten to match, live
 * in scan.mjs — `depot-fetch --scan` applies the identical rule before it
 * downloads anything, and a build that fetched one set while pruning to
 * another would ship textures nothing references, or drop ones it needs.
 *
 * Prefer `depot-fetch --scan` for a build: it never downloads the files this
 * would delete. Reach for prune when the depot is already on disk.
 *
 * Run it against a COPY, or re-fetch afterwards — this deletes files.
 */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { usedKeys, restrictManifest, keptPaths } from "./scan.mjs";

const [depotArg, ...scanDirs] = process.argv.slice(2);
const dry = process.argv.includes("--dry");
const dirs = scanDirs.filter((d) => !d.startsWith("--"));

if (!depotArg || !dirs.length) {
  console.error("usage: prune.mjs <depot-folder> <scan-dir> [...] [--dry]");
  process.exit(1);
}
const root = path.resolve(depotArg);
const manifestPath = path.join(root, "manifest.json");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

const allKeys = Object.keys(manifest.assets);
const { used, scanned, missing } = await usedKeys(allKeys, dirs);
for (const d of missing) console.warn(`  skipping missing ${d}`);

console.log(`scanned ${scanned} files in ${dirs.join(", ")}`);
console.log(`  ${used.size} of ${allKeys.length} keys referenced`);

if (!used.size) {
  console.error("REFUSING: no keys matched — that is almost certainly a wrong scan path,");
  console.error("and pruning on it would delete the entire depot.");
  process.exit(1);
}

const keep = keptPaths(manifest, used);

// Everything on disk that no surviving asset points at.
function* onDisk(dir, base = dir) {
  for (const e of fsSync.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) yield* onDisk(abs, base);
    else yield path.relative(base, abs).replaceAll("\\", "/");
  }
}
const present = [...onDisk(root)].filter((p) => p !== "manifest.json");
const drop = present.filter((p) => !keep.has(p));

const size = (p) => fsSync.statSync(path.join(root, p)).size;
const freed = drop.reduce((s, p) => s + size(p), 0);
const kept = present.length - drop.length;

console.log(`  keeping ${kept} files, removing ${drop.length} (${(freed / 1048576).toFixed(0)} MB)`);

if (dry) { console.log("\n(dry run — nothing removed)"); process.exit(0); }

for (const p of drop) await fs.rm(path.join(root, p), { force: true });

// Prune empty directories left behind, so the tree does not fill with husks.
function pruneEmpty(dir) {
  for (const e of fsSync.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) pruneEmpty(path.join(dir, e.name));
  }
  if (dir !== root && !fsSync.readdirSync(dir).length) fsSync.rmdirSync(dir);
}
pruneEmpty(root);

// Rewrite the manifest to match. Without this the dropdown and the randomiser
// would still offer keys whose files are gone.
restrictManifest(manifest, used);

await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`\ndone — ${Object.keys(manifest.assets).length} assets, ${Object.keys(manifest.packs).length} packs`);
