#!/usr/bin/env node
// The release step that cannot be forgotten: rewrite the worker's cache name from the bytes
// of everything it precaches. Run `--write` as part of a release (`npm run release`), and
// `--check` in CI or a pre-push hook — the unit gate already recomputes it, so a stale name
// fails the suite rather than reaching a user.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeCacheName } from './sw-cache-name.mjs';

const argv = process.argv.slice(2);
const write = argv.includes('--write');
const rootFlag = argv.indexOf('--root');
const root = rootFlag === -1 ? process.cwd() : argv[rootFlag + 1];
const swPath = join(root, 'sw.js');

const swText = readFileSync(swPath, 'utf8');
const actual = /const CACHE = '([^']+)';/.exec(swText)?.[1];
if (!actual) {
  console.error("sw.js has no `const CACHE = '…';` line to stamp");
  process.exit(2);
}
const expected = computeCacheName({ root, swText });

if (actual === expected) {
  console.log(`cache name is current: ${actual}`);
  process.exit(0);
}

if (!write) {
  console.error(`sw.js cache name is STALE\n  in file:   ${actual}\n  from files: ${expected}\nrun: npm run release`);
  process.exit(1);
}

writeFileSync(swPath, swText.replace(/const CACHE = '[^']+';/, `const CACHE = '${expected}';`));
console.log(`cache name stamped: ${actual} -> ${expected}`);
