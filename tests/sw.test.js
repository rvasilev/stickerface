import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { computeCacheName } from '../scripts/sw-cache-name.mjs';

const sw = readFileSync('sw.js', 'utf8');
// Parse the PRECACHE array itself, not every quoted './…' in the file: the fetch handler also
// mentions './index.html', and a loose whole-file match both double-counted it and — because
// it required a character after './' — missed the root entry, which made the completeness
// check fail on a list that was actually complete.
const list = [...sw.match(/const PRECACHE = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

describe('service worker precache list', () => {
  it('covers the shell, every module, and every emoji on disk', () => {
    const required = [
      './', './index.html', './manifest.json', './sw.js', './css/style.css',
      ...readdirSync('js').map((f) => './js/' + f),
      ...readdirSync('assets/emoji').filter((f) => f.endsWith('.svg')).map((f) => './assets/emoji/' + f),
      ...readdirSync('icons').filter((f) => f.endsWith('.png')).map((f) => './icons/' + f),
    ];
    const missing = required.filter((u) => !list.includes(u));
    // This is the "77 emoji, cached 76" guard. The picker fetches emoji on demand, so a
    // missing one is a face that cannot be hidden offline — and nothing else would notice.
    expect(missing).toEqual([]);
  });

  it('uses relative paths only, so the subpath deploy still caches', () => {
    // An absolute '/js/ui.js' would resolve to the origin root on GitHub Pages and 404,
    // leaving the installed app with no shell to boot from.
    for (const u of list) expect(u.startsWith('./')).toBe(true);
  });

  it('names its cache from the bytes of what it precaches, never by hand', () => {
    // The guard this replaces asserted the constant's SHAPE (`sf-v\d+`), which cannot fail
    // when the value is stale — decoration, not a guard. This recomputes the name from the
    // files on disk, so any change to a precached file without a re-stamp fails here
    // instead of silently reaching nobody: the browser installs a new worker only when
    // sw.js's bytes differ, so a stale name is a release that never ships.
    expect(sw).toMatch(/const CACHE = 'sf-[0-9a-f]{12}';/);
    expect(sw.match(/const CACHE = '([^']+)';/)[1]).toBe(computeCacheName());
    // The cleanup filter and the prefix must not drift apart: another project on the same
    // origin (user.github.io hosts many) keeps its caches because of that prefix.
    expect(sw).toMatch(/startsWith\(CACHE_PREFIX\)/);
  });

  it('re-fetches the precache past the HTTP cache, so a fresh install cannot store old bytes', () => {
    // addAll() fetches through the HTTP cache, and GitHub Pages sends max-age=600 on
    // everything. Within that window an install would otherwise fill the NEW cache with the
    // PREVIOUS release's bytes — a mixed-version install that looks successful.
    expect(sw).toMatch(/new Request\([^)]*\{ cache: 'reload' \}/);
  });
});
