// Export cap unit tests — imports ONLY js/export.js pure surface (no DOM).
// The node import itself proves the predicate loads without a DOM.
import { describe, it, expect } from 'vitest';
import {
  maxCanvasPixels,
  exportSize,
  degradedStickerCount,
  MAX_CANVAS_PIXELS,
  DEFAULT_MAX_CANVAS_PIXELS,
  SAFARI_LEGACY_MAX_CANVAS_PIXELS,
  SAFARI_MODERN_MAX_CANVAS_PIXELS,
} from '../js/export.js';

const IOS17 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const IOS18 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Safari/605.1.15';
const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0';

describe('maxCanvasPixels', () => {
  it('caps iOS 17 and earlier at 4096x4096', () => {
    expect(maxCanvasPixels(IOS17)).toBe(16777216);
    expect(maxCanvasPixels(IOS17)).toBe(SAFARI_LEGACY_MAX_CANVAS_PIXELS);
  });

  it('caps iOS 18+ at 8192x8192', () => {
    expect(maxCanvasPixels(IOS18)).toBe(67108864);
    expect(maxCanvasPixels(IOS18)).toBe(SAFARI_MODERN_MAX_CANVAS_PIXELS);
  });

  it('caps desktop Safari at the legacy limit', () => {
    expect(maxCanvasPixels(MAC_SAFARI)).toBe(SAFARI_LEGACY_MAX_CANVAS_PIXELS);
  });

  it('gives everything else the default 268M cap', () => {
    expect(DEFAULT_MAX_CANVAS_PIXELS).toBe(268435456);
    expect(MAX_CANVAS_PIXELS).toBe(268435456);
    expect(maxCanvasPixels(CHROME)).toBe(268435456);
    expect(maxCanvasPixels(FIREFOX)).toBe(268435456);
    expect(maxCanvasPixels(undefined)).toBe(268435456);
    expect(maxCanvasPixels('')).toBe(268435456);
  });

  it('never throws on odd input', () => {
    expect(() => maxCanvasPixels(null)).not.toThrow();
    expect(() => maxCanvasPixels(42)).not.toThrow();
    expect(maxCanvasPixels(null)).toBe(268435456);
  });
});

describe('exportSize', () => {
  it('is exactly at the cap -> full resolution, not capped', () => {
    // 4096x4096 = 16,777,216 == the legacy cap.
    const s = exportSize(4096, 4096, SAFARI_LEGACY_MAX_CANVAS_PIXELS);
    expect(s).toEqual({ w: 4096, h: 4096, scale: 1, capped: false });
  });

  it('is one pixel over the cap -> capped, area at or under the cap', () => {
    const s = exportSize(4097, 4096, SAFARI_LEGACY_MAX_CANVAS_PIXELS);
    expect(s.capped).toBe(true);
    expect(s.w * s.h).toBeLessThanOrEqual(SAFARI_LEGACY_MAX_CANVAS_PIXELS);
    expect(s.w).toBeLessThanOrEqual(4096);
    expect(s.h).toBeLessThanOrEqual(4096);
  });

  it('a normal photo fits at full resolution', () => {
    const s = exportSize(1200, 800, SAFARI_LEGACY_MAX_CANVAS_PIXELS);
    expect(s).toEqual({ w: 1200, h: 800, scale: 1, capped: false });
  });

  it('a 108MP photo (12000x9000) is capped on every iOS cap', () => {
    for (const cap of [SAFARI_LEGACY_MAX_CANVAS_PIXELS, SAFARI_MODERN_MAX_CANVAS_PIXELS, DEFAULT_MAX_CANVAS_PIXELS]) {
      const s = exportSize(12000, 9000, cap);
      if (cap === DEFAULT_MAX_CANVAS_PIXELS) {
        expect(s.capped).toBe(false); // 108M < 268M default
      } else {
        expect(s.capped).toBe(true);
      }
      expect(s.w * s.h).toBeLessThanOrEqual(cap);
    }
  });

  it('a 48MP photo is capped at legacy Safari but not at the default cap', () => {
    expect(exportSize(8000, 6000, SAFARI_LEGACY_MAX_CANVAS_PIXELS).capped).toBe(true);
    expect(exportSize(8000, 6000, DEFAULT_MAX_CANVAS_PIXELS).capped).toBe(false);
  });

  it('never upscales: asking for a small size returns it untouched', () => {
    const s = exportSize(800, 600, SAFARI_LEGACY_MAX_CANVAS_PIXELS);
    expect(s.w).toBe(800);
    expect(s.h).toBe(600);
    expect(s.scale).toBe(1);
    expect(s.capped).toBe(false);
  });

  it('preserves aspect ratio: one linear factor, w/h unchanged within a pixel', () => {
    const s = exportSize(12000, 9000, SAFARI_MODERN_MAX_CANVAS_PIXELS);
    expect(Math.abs(s.w / s.h - 12000 / 9000)).toBeLessThan(0.002);
    // One linear factor within the floor() rounding a pixel can cause.
    expect(Math.abs(s.scale * 12000 - s.w)).toBeLessThanOrEqual(1);
    expect(Math.abs(s.scale * 9000 - s.h)).toBeLessThanOrEqual(1);
  });

  it('the returned size is the largest that fits (area within 0.1% of the cap)', () => {
    const cap = SAFARI_LEGACY_MAX_CANVAS_PIXELS;
    const s = exportSize(12000, 9000, cap);
    expect(s.w * s.h).toBeGreaterThanOrEqual(cap * 0.999);
  });

  it('a tiny cap still yields a usable at-least-1px canvas', () => {
    const s = exportSize(100000, 100000, 100);
    expect(s.w).toBeGreaterThanOrEqual(1);
    expect(s.h).toBeGreaterThanOrEqual(1);
    expect(s.w * s.h).toBeLessThanOrEqual(100);
  });

  it('tolerates degenerate input without throwing', () => {
    expect(exportSize(0, 800, 1000)).toEqual({ w: 0, h: 800, scale: 1, capped: false });
    expect(exportSize(1200, 0, 1000)).toEqual({ w: 1200, h: 0, scale: 1, capped: false });
    expect(() => exportSize(NaN, NaN, 1000)).not.toThrow();
    expect(() => exportSize(100, 100, 0)).not.toThrow();
    const fallback = exportSize(100, 100, 0);
    expect(fallback.w).toBe(100); // non-positive cap -> default cap, no crash
  });

  it('an absent cap uses the default 268M cap', () => {
    expect(exportSize(1200, 800)).toEqual({ w: 1200, h: 800, scale: 1, capped: false });
  });
});

describe('degradedStickerCount — meaning unchanged (§4: report, do not alter)', () => {
  const emojiSticker = { id: 'a', kind: 'emoji', src: 'assets/emoji/1f600.svg' };
  const missingSticker = { id: 'e', kind: 'emoji', src: 'assets/emoji/1f601.svg' };
  const blurSticker = { id: 'c', kind: 'blur' };

  it('still counts fallback and placeholder stickers as degraded, blur as never', () => {
    const state = { stickers: [emojiSticker, missingSticker, blurSticker] };
    const fallback = new Map([['assets/emoji/1f600.svg', { width: 1, height: 1 }]]);
    expect(degradedStickerCount(state, new Map(), new Map(), fallback)).toBe(2);
  });
});
