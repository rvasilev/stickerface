import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const css = readFileSync('css/style.css', 'utf8');

// PNG width/height live in the IHDR chunk: big-endian uint32 at bytes 16 and 20. Reading
// them means a `sizes` that lies about the file is caught with no dependency at all.
function pngSize(file) {
  const b = readFileSync(file);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

describe('web app manifest', () => {
  it('declares the identity the install surfaces read', () => {
    expect(manifest.name || manifest.short_name).toBeTruthy();
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('./');
    expect(manifest.scope).toBe('./');
  });

  it('keeps every URL relative so the subpath deploy cannot break it', () => {
    // An absolute "/icons/…" works at the harness's root and 404s on GitHub Pages, which
    // is the worst way round: green locally, broken in production.
    expect(manifest.start_url.startsWith('./')).toBe(true);
    expect(manifest.scope.startsWith('./')).toBe(true);
    expect(manifest.id.startsWith('./')).toBe(true);
    for (const i of manifest.icons) expect(i.src.startsWith('./')).toBe(true);
  });

  it('ships an `any` icon, not only maskable ones', () => {
    const any = manifest.icons.filter((i) => (i.purpose || 'any').split(' ').includes('any'));
    expect(any.length).toBeGreaterThan(0);
    // 144 is Chromium's floor; 1024 is its desktop ceiling.
    expect(any.some((i) => Number((i.sizes || '').split('x')[0]) >= 144)).toBe(true);
    expect(any.every((i) => Number((i.sizes || '').split('x')[0]) <= 1024)).toBe(true);
    expect(manifest.icons.some((i) => (i.purpose || '').includes('maskable'))).toBe(true);
  });

  it('ships each declared icon at the size it claims', () => {
    for (const i of manifest.icons) {
      const [w, h] = i.sizes.split('x').map(Number);
      expect(pngSize(i.src.replace('./', '')), i.src).toEqual([w, h]);
    }
  });

  it('matches the colour the app actually paints', () => {
    // A mismatch is a flash of a different colour between the installed splash and the
    // first frame, so the two are tied together rather than trusted to stay in step.
    const bg = css.match(/--bg:\s*(#[0-9a-fA-F]{6})/)[1].toLowerCase();
    expect(manifest.background_color.toLowerCase()).toBe(bg);
    expect(manifest.theme_color.toLowerCase()).toBe(bg);
  });
});
