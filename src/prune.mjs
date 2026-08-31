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
 * Which keys count as used is decided by a plain text scan: any manifest key
 * appearing verbatim in a scanned file. Keys live in shader comments, saved
 * presets and source, all of which are text, and the key format is distinctive
 * enough that a false positive is harmless (it keeps a file) while a false
 * negative is not (it drops one). So the scan is deliberately literal.
 *
 * The manifest is rewritten to match. That is the important part: `allKeys`
 * drives the texture dropdown and the randomiser, so a manifest still listing
 * pruned assets would offer the user textures that are no longer there.
 *
 * Run it against a COPY, or re-fetch afterwards — this deletes files.
 */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

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

const TEXT = /\.(ts|tsx|js|jsx|json|frag|vert|glsl|md|html|css)$/i;
function* files(dir) {
  for (const e of fsSync.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(abs);
    else if (TEXT.test(e.name)) yield abs;
  }
}

let haystack = "";
let scanned = 0;
for (const dir of dirs) {
  if (!fsSync.existsSync(dir)) { console.warn(`  skipping missing ${dir}`); continue; }
  for (const f of files(dir)) { haystack += await fs.readFile(f, "utf8"); scanned++; }
}

const allKeys = Object.keys(manifest.assets);
const used = new Set(allKeys.filter((k) => haystack.includes(k)));

// Keys may also be stored without the .png the convention appends, so accept
// the bare stem too rather than dropping a texture that is genuinely referenced.
for (const k of allKeys) if (!used.has(k) && haystack.includes(k.replace(/\.png$/, ""))) used.add(k);

console.log(`scanned ${scanned} files in ${dirs.join(", ")}`);
console.log(`  ${used.size} of ${allKeys.length} keys referenced`);

if (!used.size) {
  console.error("REFUSING: no keys matched — that is almost certainly a wrong scan path,");
  console.error("and pruning on it would delete the entire depot.");
  process.exit(1);
}

const keep = new Set();
for (const k of used)
  for (const list of Object.values(manifest.assets[k].variants))
    for (const v of list) keep.add(v.path);

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
for (const k of allKeys) if (!used.has(k)) delete manifest.assets[k];
const packsInUse = new Set(Object.values(manifest.assets).map((a) => a.pack));
for (const p of Object.keys(manifest.packs)) if (!packsInUse.has(p)) delete manifest.packs[p];
manifest.pruned = true;

await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`\ndone — ${Object.keys(manifest.assets).length} assets, ${Object.keys(manifest.packs).length} packs`);
