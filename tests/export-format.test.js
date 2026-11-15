// Export FORMAT + level unit tests — imports only js/export.js's pure surface (no DOM).
//
// The reason these exist rather than an e2e criterion: the trap this code guards is a browser that
// answers a request for WebP with PNG bytes, SILENTLY (the HTML spec says an unsupported type must
// be exported as image/png, and Safari has no canvas WebP encoder at all). The only way to see it
// is to compare what came back with what was asked for — and a test done that way needs no Safari,
// because the blob's type is an ARGUMENT here. Same shape as maxCanvasPixels(ua).
import { describe, it, expect } from 'vitest';
import {
  EXPORT_LEVELS,
  EXPORT_SIZES,
  DEFAULT_EXPORT_LEVEL,
  DEFAULT_EXPORT_SIZE,
  EXPORT_SETTINGS_KEY,
  levelValue,
  longEdge,
  resolveExportFormat,
  exportFilename,
  readExportSettings,
  writeExportSettings,
} from '../js/export.js';

/** A localStorage-shaped stub. `hole` in the API on purpose: a private-mode browser throws. */
const fakeStorage = (initial, { throws = false } = {}) => {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (k) => {
      if (throws) throw new Error('storage is blocked');
      return map.has(k) ? map.get(k) : null;
    },
    setItem: (k, v) => {
      if (throws) throw new Error('storage is blocked');
      map.set(k, String(v));
    },
    _map: map,
  };
};

describe('resolveExportFormat — the extension follows what was PRODUCED, not what was asked for', () => {
  it('keeps each format when the browser really encoded it', () => {
    expect(resolveExportFormat('image/webp', 'image/webp')).toEqual({ mime: 'image/webp', ext: 'webp', fellBack: false });
    expect(resolveExportFormat('image/jpeg', 'image/jpeg')).toEqual({ mime: 'image/jpeg', ext: 'jpg', fellBack: false });
    expect(resolveExportFormat('image/png', 'image/png')).toEqual({ mime: 'image/png', ext: 'png', fellBack: false });
  });

  it('reports the PNG fallback when WebP was asked for — this is Safari', () => {
    // Not hypothetical: `toBlob(cb, 'image/webp', q)` returns a PNG blob with type image/png on
    // every Safari to date. Naming that file .webp is the bug; this is the fix, and it needs no
    // Safari to test because the returned type is the input.
    expect(resolveExportFormat('image/webp', 'image/png')).toEqual({ mime: 'image/png', ext: 'png', fellBack: true });
  });

  it('reports the fallback for JPEG too, so a .jpg never holds PNG bytes', () => {
    expect(resolveExportFormat('image/jpeg', 'image/png')).toEqual({ mime: 'image/png', ext: 'png', fellBack: true });
  });

  it('treats a missing or unknown produced type as PNG, which is what the spec falls back to', () => {
    expect(resolveExportFormat('image/webp', undefined)).toEqual({ mime: 'image/png', ext: 'png', fellBack: true });
    expect(resolveExportFormat('image/webp', 'image/gif')).toEqual({ mime: 'image/png', ext: 'png', fellBack: true });
    expect(resolveExportFormat('image/webp', '')).toEqual({ mime: 'image/png', ext: 'png', fellBack: true });
  });
});

describe('levelValue — the four levels a lossy export offers', () => {
  it('offers a level per lossy format and NONE for png (toBlob ignores quality there)', () => {
    expect(Object.keys(EXPORT_LEVELS).sort()).toEqual(['jpeg', 'webp']);
    expect(levelValue('png', 'better')).toBeUndefined();
    expect(levelValue('png', DEFAULT_EXPORT_LEVEL)).toBeUndefined();
  });

  it("keeps the shipped default: 'better' is 0.92, the value the app encoded with before", () => {
    // Byte-compatibility with every export made before this feature, which is why the default is
    // this level and not a rounder number.
    expect(levelValue('jpeg', 'better')).toBe(0.92);
    expect(levelValue('webp', 'better')).toBe(0.92);
  });

  it('never reaches 1.0 as a LEVEL — for WebP that is a lossless cliff, for JPEG it still triples the file', () => {
    for (const format of ['jpeg', 'webp']) {
      for (const [name, q] of Object.entries(EXPORT_LEVELS[format])) {
        if (name === 'lossless') continue;
        expect(q, `${format}.${name}`).toBeGreaterThan(0);
        expect(q, `${format}.${name}`).toBeLessThanOrEqual(0.95);
      }
    }
  });

  it('offers 1.0 as ONE named tier, for WebP only, and it means lossless', () => {
    // The tier exists because lossless WebP is 43.8% smaller than PNG at identical pixels
    // (diag-export-compression-probe.js) — a saving that needs no dependency. JPEG has no such
    // tier: at 1.0 it is still lossy and still triples the file. Asking for a tier a format does
    // not have falls back like any other unknown level, so the absence is enforced by the table
    // and by the control that is built from it, not by a second refusal here.
    expect(levelValue('webp', 'lossless')).toBe(1);
    expect(Object.keys(EXPORT_LEVELS.webp)).toContain('lossless');
    expect(Object.keys(EXPORT_LEVELS.jpeg)).not.toContain('lossless');
    expect(levelValue('jpeg', 'lossless')).toBe(EXPORT_LEVELS.jpeg[DEFAULT_EXPORT_LEVEL]);
  });

  it('is monotone from smaller to maximum, so the control means one thing', () => {
    for (const format of ['jpeg', 'webp']) {
      const l = EXPORT_LEVELS[format];
      expect(l.smaller).toBeLessThan(l.balanced);
      expect(l.balanced).toBeLessThan(l.better);
      expect(l.better).toBeLessThan(l.maximum);
    }
  });

  it('falls back to the default for an unknown or absent level', () => {
    expect(levelValue('jpeg', 'nope')).toBe(EXPORT_LEVELS.jpeg[DEFAULT_EXPORT_LEVEL]);
    expect(levelValue('jpeg', undefined)).toBe(EXPORT_LEVELS.jpeg[DEFAULT_EXPORT_LEVEL]);
    expect(levelValue('nosuchformat', 'better')).toBeUndefined();
  });
});

describe('longEdge — the resolution lever, which is the one that actually decides a file size', () => {
  it('maps a size name to a long edge, and every name to something', () => {
    // Measured (diag-export-compression-probe.js): 12.2 MP -> 3.1 MP is 83% fewer bytes and
    // 12.2 MP -> 1.2 MP is 95%, against 78% for the entire JPEG level range. So these two
    // numbers are the feature, and `full` is the app's standing promise: null = do not touch it.
    expect(EXPORT_SIZES.full).toBeNull();
    expect(EXPORT_SIZES.large).toBe(2048);
    expect(EXPORT_SIZES.web).toBe(1280);
    expect(DEFAULT_EXPORT_SIZE).toBe('full');
  });

  it('is monotone from full down to web, so the control means one thing', () => {
    // Same discipline as the level table: a size list that is not ordered reads as arbitrary.
    // full is unbounded (null), then the edges must strictly descend.
    expect(longEdge('large')).toBeGreaterThan(longEdge('web'));
    expect(longEdge('web')).toBeGreaterThan(0);
    expect(Object.keys(EXPORT_SIZES)).toEqual(['full', 'large', 'web']);
  });

  it('returns null — full resolution — for the default, for an absent name and for junk', () => {
    // Fail-SAFE direction on purpose: an unknown stored size must never silently reduce the
    // export, and a caller that forgets the argument gets the app's documented behaviour.
    expect(longEdge('full')).toBeNull();
    expect(longEdge(undefined)).toBeNull();
    expect(longEdge('nope')).toBeNull();
    expect(longEdge('large')).toBe(2048);
    expect(longEdge('web')).toBe(1280);
  });
});

describe('exportFilename', () => {
  it('keeps the established shape, with the extension it is HANDED', () => {
    expect(exportFilename('photo', 'png')).toBe('photo_stickerface.png');
    expect(exportFilename('photo', 'jpg')).toBe('photo_stickerface.jpg');
    expect(exportFilename('photo', 'webp')).toBe('photo_stickerface.webp');
  });
});

describe('readExportSettings / writeExportSettings — one key, fail-silent', () => {
  const defaults = () => ({ jpeg: DEFAULT_EXPORT_LEVEL, webp: DEFAULT_EXPORT_LEVEL, size: DEFAULT_EXPORT_SIZE });

  it('defaults when nothing is stored', () => {
    expect(readExportSettings(fakeStorage())).toEqual(defaults());
  });

  it('round-trips a written choice, size included', () => {
    const s = fakeStorage();
    writeExportSettings(s, { jpeg: 'smaller', webp: 'maximum', size: 'web' });
    expect(s._map.has(EXPORT_SETTINGS_KEY)).toBe(true);
    expect(readExportSettings(s)).toEqual({ jpeg: 'smaller', webp: 'maximum', size: 'web' });
  });

  it('reads a blob written BEFORE size existed as full resolution', () => {
    // The migration: the previous build stored two keys and no size. Absent means full — never an
    // exception, and never a silent reduction of someone's export.
    expect(readExportSettings(fakeStorage({ [EXPORT_SETTINGS_KEY]: '{"jpeg":"maximum","webp":"maximum"}' })))
      .toEqual({ jpeg: 'maximum', webp: 'maximum', size: DEFAULT_EXPORT_SIZE });
  });

  it('ignores junk instead of throwing on it', () => {
    expect(readExportSettings(fakeStorage({ [EXPORT_SETTINGS_KEY]: 'not json' }))).toEqual(defaults());
    expect(readExportSettings(fakeStorage({ [EXPORT_SETTINGS_KEY]: '[1,2]' }))).toEqual(defaults());
    // A stored level that no longer exists, a size that no longer exists, and a format this
    // build does not have.
    expect(readExportSettings(fakeStorage({ [EXPORT_SETTINGS_KEY]: '{"jpeg":"ultra","size":"huge","png":"better"}' })))
      .toEqual(defaults());
  });

  it('survives storage that throws — private mode must not take the app down', () => {
    // Same fail-safe shape as the coach flag (ui.js _coachSeen): an unreadable preference is a
    // preference at its default, never an exception on the export path.
    const blocked = fakeStorage({}, { throws: true });
    expect(readExportSettings(blocked)).toEqual(defaults());
    expect(() => writeExportSettings(blocked, { jpeg: 'smaller', webp: 'smaller', size: 'large' })).not.toThrow();
  });
});
