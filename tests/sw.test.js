import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

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

  it('names its cache with the sf- prefix its cleanup is scoped to', () => {
    expect(sw).toMatch(/const CACHE = 'sf-v\d+';/);
    // The cleanup filter and the prefix must not drift apart: another project on the same
    // origin (user.github.io hosts many) keeps its caches because of that prefix.
    expect(sw).toMatch(/startsWith\(CACHE_PREFIX\)/);
  });
});
