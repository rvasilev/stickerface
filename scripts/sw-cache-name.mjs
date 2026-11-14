// The service worker's cache name, derived from what actually ships.
//
// The browser installs a new worker only when `sw.js`'s BYTES differ. A hand-bumped
// `const CACHE = 'sf-v1'` is therefore a correctness step that depends on remembering, and
// nothing fails when it is forgotten: ship a new `js/ui.js` with a byte-identical `sw.js`
// and every installed copy stays on the old build forever — no `updatefound`, no prompt, no
// error. This module makes the name a function of the precached files, so changing any one
// of them necessarily changes the worker's bytes and the update cannot be missed.
//
// ONE implementation, imported by both `scripts/stamp-sw.mjs` (the release step) and
// `tests/sw.test.js` (the guard that recomputes it). Two hashers would drift.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The URLs listed in the worker's own PRECACHE array, in file order.
 * Parses the array literal rather than every quoted './…' in the file: the fetch handler
 * also mentions './index.html'.
 * @param {string} swText
 * @returns {string[]}
 */
export function parsePrecacheList(swText) {
  const arrayLiteral = /const PRECACHE = \[([\s\S]*?)\];/.exec(swText);
  if (!arrayLiteral) throw new Error('PRECACHE array not found in sw.js');
  return [...arrayLiteral[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/**
 * A precache URL as a path on disk relative to the deploy root. './' is the directory URL
 * — what a browser serves `index.html` for.
 * @param {string} url
 * @returns {string}
 */
export function resolveAssetPath(url) {
  const stripped = url.replace(/^\.\//, '');
  return stripped === '' ? 'index.html' : stripped;
}

/**
 * The cache name, e.g. `sf-9f2c1ab44e07`.
 *
 * `./sw.js` is excluded: it is in its own precache list, so hashing it would make the name
 * depend on itself and never converge. It does not need to — an edit to `sw.js` alone still
 * changes the file's bytes, which is what the browser diffs.
 * @param {{ root?: string, read?: (path: string) => Buffer|string, swText?: string }} [opts]
 * @returns {string}
 */
export function computeCacheName(opts = {}) {
  const root = opts.root ?? process.cwd();
  const read = opts.read ?? ((path) => readFileSync(path));
  const swText = opts.swText ?? String(read(join(root, 'sw.js')));

  const hash = createHash('sha256');
  const seen = new Set();
  for (const url of parsePrecacheList(swText)) {
    if (url === './sw.js') continue;
    const path = resolveAssetPath(url);
    if (seen.has(path)) continue;   // './' and './index.html' are one file
    seen.add(path);
    const abs = join(root, path);
    if (!existsSync(abs)) throw new Error(`PRECACHE lists a file that does not exist: ${url}`);
    hash.update(url).update('\0').update(read(abs));
  }
  return `sf-${hash.digest('hex').slice(0, 12)}`;
}
