/**
 * Which of a depot's keys a body of source actually mentions.
 *
 * Shared by fetch (download only what is used) and prune (delete what is not),
 * because those two have to agree exactly. They used to be one rule written
 * once; the moment there were two copies, one of them would drift and the
 * symptom would be a texture that 404s only in production.
 *
 * Which keys count is decided by a plain text scan: any manifest key appearing
 * verbatim in a scanned file. Keys live in shader comments, saved presets and
 * source, all of which are text, and the key format is distinctive enough that
 * a false positive is harmless (it keeps a file) while a false negative is not
 * (it drops one). So the scan is deliberately literal.
 *
 * The scan dirs are the thing to get right. A library's own defaults —
 * DEFAULT_SKYBOX_KEY, a particle sprite — are referenced in the library's
 * source, not the app's, and an app that scans only its own src will happily
 * drop the textures its dependencies need.
 */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

const TEXT = /\.(ts|tsx|js|jsx|json|frag|vert|glsl|md|html|css)$/i;

function* files(dir) {
  for (const e of fsSync.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(abs);
    else if (TEXT.test(e.name)) yield abs;
  }
}

/**
 * A missing scan dir is reported, not fatal: the sibling checkout an app reads
 * in dev genuinely is not there on CI, and refusing would break the build that
 * needs this most.
 */
export async function usedKeys(allKeys, dirs) {
  let haystack = "";
  let scanned = 0;
  const missing = [];
  for (const dir of dirs) {
    if (!fsSync.existsSync(dir)) { missing.push(dir); continue; }
    for (const f of files(dir)) { haystack += await fs.readFile(f, "utf8"); scanned++; }
  }

  const used = new Set(allKeys.filter((k) => haystack.includes(k)));
  // Keys may also be stored without the .png the convention appends, so accept
  // the bare stem too rather than dropping a texture that is genuinely used.
  for (const k of allKeys)
    if (!used.has(k) && haystack.includes(k.replace(/\.png$/, ""))) used.add(k);

  return { used, scanned, missing };
}

/**
 * Cut a manifest down to a set of keys, in place.
 *
 * This is the part that is easy to forget and expensive to get wrong: `assets`
 * drives the texture dropdown and the randomiser, so a manifest still listing
 * keys whose files are gone offers the user textures that will 404.
 */
export function restrictManifest(manifest, used) {
  for (const k of Object.keys(manifest.assets)) if (!used.has(k)) delete manifest.assets[k];
  const packsInUse = new Set(Object.values(manifest.assets).map((a) => a.pack));
  for (const p of Object.keys(manifest.packs)) if (!packsInUse.has(p)) delete manifest.packs[p];
  manifest.pruned = true;
  return manifest;
}

/**
 * Every file path the surviving assets point at.
 */
export function keptPaths(manifest, used) {
  const keep = new Set();
  for (const k of used)
    for (const list of Object.values(manifest.assets[k].variants))
      for (const v of list) keep.add(v.path);
  return keep;
}
