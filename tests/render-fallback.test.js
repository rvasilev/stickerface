// Decode-fallback unit tests — no DOM, no canvas, no network.
//
// render.js decodeEmojiBitmaps/decodeCustomBitmap touch document/Image, so
// the DOM-free surface tested here is the pure decision logic behind the
// fallback: partitionStickers() (which stickers draw from a bitmap, a
// fallback <img>, or a solid placeholder) and degradedStickerCount() from
// export.js (the degraded-state report that must never block export).
// The node import itself proves the decode modules load without a DOM.

import { describe, it, expect } from 'vitest';
import { partitionStickers } from '../js/render.js';
import { degradedStickerCount } from '../js/export.js';

const emojiSticker = { id: 'a', kind: 'emoji', src: 'assets/emoji/1f600.svg' };
const customSticker = { id: 'b', kind: 'custom', src: 'user:blob:x' };
const blurSticker = { id: 'c', kind: 'blur' };
const mosaicSticker = { id: 'd', kind: 'mosaic' };
const missingSticker = { id: 'e', kind: 'emoji', src: 'assets/emoji/1f601.svg' };

describe('partitionStickers — decode fallback', () => {
  it('routes a decoded emoji to the bitmap group', () => {
    const bitmaps = new Map([['assets/emoji/1f600.svg', { width: 512, height: 512 }]]);
    const out = partitionStickers([emojiSticker], bitmaps, new Map(), new Map());
    expect(out.withBitmap).toEqual([emojiSticker]);
    expect(out.withFallback).toEqual([]);
    expect(out.withPlaceholder).toEqual([]);
  });

  it('routes an undecodable emoji with an <img> fallback to the fallback group', () => {
    const fallback = new Map([['assets/emoji/1f600.svg', { width: 36, height: 36 }]]);
    const out = partitionStickers([emojiSticker], new Map(), fallback, new Map());
    expect(out.withBitmap).toEqual([]);
    expect(out.withFallback).toEqual([emojiSticker]);
    expect(out.withPlaceholder).toEqual([]);
  });

  it('routes an emoji with no bitmap and no fallback to the placeholder group', () => {
    const out = partitionStickers([missingSticker], new Map(), new Map(), new Map());
    expect(out.withBitmap).toEqual([]);
    expect(out.withFallback).toEqual([]);
    expect(out.withPlaceholder).toEqual([missingSticker]);
  });

  it('prefers the bitmap over the fallback when both exist', () => {
    const bitmaps = new Map([['assets/emoji/1f600.svg', { width: 1, height: 1 }]]);
    const fallback = new Map([['assets/emoji/1f600.svg', { width: 1, height: 1 }]]);
    const out = partitionStickers([emojiSticker], bitmaps, fallback, new Map());
    expect(out.withBitmap).toEqual([emojiSticker]);
    expect(out.withFallback).toEqual([]);
  });

  it('treats blur and mosaic as always paintable, never degraded', () => {
    const out = partitionStickers([blurSticker, mosaicSticker], new Map(), new Map(), new Map());
    expect(out.withBitmap).toEqual([blurSticker, mosaicSticker]);
    expect(out.withFallback).toEqual([]);
    expect(out.withPlaceholder).toEqual([]);
  });

  it('routes a custom sticker by its own bitmap slot', () => {
    const custom = new Map([['user:blob:x', { width: 512, height: 512 }]]);
    expect(partitionStickers([customSticker], new Map(), new Map(), custom).withBitmap).toEqual([customSticker]);
    expect(partitionStickers([customSticker], new Map(), new Map(), new Map()).withPlaceholder).toEqual([customSticker]);
  });

  it('null-safety: undefined/null-ish inputs never throw', () => {
    expect(() => partitionStickers(undefined, undefined, undefined, undefined)).not.toThrow();
    expect(partitionStickers(null, null, null, null)).toEqual({
      withBitmap: [],
      withFallback: [],
      withPlaceholder: [],
    });
  });
});

describe('degradedStickerCount — partial failure never blocks export', () => {
  const state = {
    stickers: [emojiSticker, missingSticker, blurSticker, mosaicSticker],
    image: { naturalWidth: 1200, naturalHeight: 800 },
  };

  it('is zero when every emoji bitmap decoded', () => {
    const bitmaps = new Map([
      ['assets/emoji/1f600.svg', { width: 1, height: 1 }],
      ['assets/emoji/1f601.svg', { width: 1, height: 1 }],
    ]);
    expect(degradedStickerCount(state, bitmaps, new Map(), new Map())).toBe(0);
  });

  it('counts fallback and placeholder stickers as degraded (reported, not blocking)', () => {
    const fallback = new Map([['assets/emoji/1f600.svg', { width: 1, height: 1 }]]);
    // emojiSticker has a fallback <img> but no bitmap; missingSticker has neither.
    // blur/mosaic are never degraded.
    expect(degradedStickerCount(state, new Map(), new Map(), fallback)).toBe(2);
  });

  it('is zero for an empty sticker list', () => {
    expect(degradedStickerCount({ stickers: [] }, new Map(), new Map(), new Map())).toBe(0);
  });
});
