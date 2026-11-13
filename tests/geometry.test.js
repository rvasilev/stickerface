// Geometry unit tests — imports ONLY js/geometry.js. No DOM, no canvas.

import { describe, it, expect } from 'vitest';
import {
  px,
  norm,
  stickerRect,
  handlePositions,
  hitTest,
  resizeRect,
  rotateTo,
  angleDelta,
  snapAngle,
  nudge,
  clampViewPan,
  clampViewScale,
  focalZoomView,
  VIEW_MIN_SCALE,
  VIEW_MAX_SCALE,
  isDoubleTap,
} from '../js/geometry.js';

const SIZES = [
  [640, 480],
  [1920, 1080],
  [8000, 5000],
];

const A = 0.5;
const parked = (over = {}) => ({
  id: 's1',
  kind: 'emoji',
  src: 'assets/emoji/1f600.svg',
  cx: 0.5,
  cy: 0.5,
  w: 0.2,
  h: 0.2,
  rot: 0,
  z: 1,
  radius: 0.5,
  strength: 12,
  ...over,
});

describe('px / norm round-trips', () => {
  it.each(SIZES)('norm -> px -> norm is exact within 1e-9 at %ix%i', (W, H) => {
    for (const v of [0, 0.1, 0.25, 1 / 3, 0.5, 0.75, 0.9, 1]) {
      expect(Math.abs(norm(px(v, W), W) - v)).toBeLessThan(1e-9);
      expect(Math.abs(norm(px(v, H), H) - v)).toBeLessThan(1e-9);
    }
  });

  it.each(SIZES)('px -> norm -> px is exact within 1e-9 at %ix%i', (W, H) => {
    for (const x of [0, 1, W / 3, W / 2, W - 1, W]) {
      expect(Math.abs(px(norm(x, W), W) - x)).toBeLessThan(1e-9);
    }
    for (const y of [0, 1, H / 3, H / 2, H - 1, H]) {
      expect(Math.abs(px(norm(y, H), H) - y)).toBeLessThan(1e-9);
    }
  });

  it('guards degenerate spans without throwing', () => {
    expect(px(0.5, 0)).toBe(0);
    expect(norm(100, 0)).toBe(0);
    expect(px(0.5, -10)).toBe(0);
  });
});

describe('stickerRect', () => {
  it('centres on (cx*imgW, cy*imgH) with w*imgW / h*imgH', () => {
    const rect = stickerRect(parked({ cx: 0.25, cy: 0.75, w: 0.2, h: 0.1 }), 1000, 500);
    expect(rect).toEqual({ x: 150, y: 350, w: 200, h: 50 });
  });

  it('is the axis-aligned, un-rotated box regardless of rot', () => {
    const a = stickerRect(parked({ rot: 0 }), 800, 600);
    const b = stickerRect(parked({ rot: Math.PI / 4 }), 800, 600);
    expect(a).toEqual(b);
  });
});

describe('handlePositions', () => {
  it('matches the un-rotated rect at rot=0', () => {
    const rect = { x: 100, y: 100, w: 200, h: 100 };
    const h = handlePositions(rect, 0);
    expect(h.nw).toEqual({ x: 100, y: 100 });
    expect(h.n).toEqual({ x: 200, y: 100 });
    expect(h.ne).toEqual({ x: 300, y: 100 });
    expect(h.e).toEqual({ x: 300, y: 150 });
    expect(h.se).toEqual({ x: 300, y: 200 });
    expect(h.s).toEqual({ x: 200, y: 200 });
    expect(h.sw).toEqual({ x: 100, y: 200 });
    expect(h.w).toEqual({ x: 100, y: 150 });
  });

  it.each([0, Math.PI / 2, Math.PI, -Math.PI / 2])(
    'is stable at rot=%s (quarter turns)', (rot) => {
      const rect = { x: 0, y: 0, w: 200, h: 100 };
      const h = handlePositions(rect, rot);
      // Every handle sits on the rotated box: corners at half-extents,
      // edge midpoints on the edges. At 0/180 the box spans x 0..200, y 0..200
      // wait — corners keep the original half-extents (100,50); at 90/270 the
      // box is 100x200 so corners are (50,100) about the centre (100,50).
      const cx = 100;
      const cy = 50;
      const horiz = Math.abs(Math.sin(rot)) < 0.01;
      const corners = horiz
        ? [{ x: cx - 100, y: cy - 50 }, { x: cx + 100, y: cy - 50 }, { x: cx - 100, y: cy + 50 }, { x: cx + 100, y: cy + 50 }]
        : [{ x: cx - 50, y: cy - 100 }, { x: cx + 50, y: cy - 100 }, { x: cx - 50, y: cy + 100 }, { x: cx + 50, y: cy + 100 }];
      const edges = horiz
        ? [{ x: cx, y: cy - 50 }, { x: cx + 100, y: cy }, { x: cx, y: cy + 50 }, { x: cx - 100, y: cy }]
        : [{ x: cx - 50, y: cy }, { x: cx, y: cy - 100 }, { x: cx + 50, y: cy }, { x: cx, y: cy + 100 }];
      const allowed = [...corners, ...edges];
      for (const k of Object.keys(h)) {
        const occupied = allowed.some(
          (p) => Math.abs(p.x - h[k].x) < 1e-9 && Math.abs(p.y - h[k].y) < 1e-9,
        );
        expect(occupied, `handle ${k} at ${JSON.stringify(h[k])}`).toBe(true);
      }
      // Handles never collapse onto each other in a quarter turn.
      const keys = Object.keys(h);
      for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
          const a = h[keys[i]];
          const b = h[keys[j]];
          expect(Math.hypot(a.x - b.x, a.y - b.y), `${keys[i]} vs ${keys[j]}`).toBeGreaterThan(1e-9);
        }
      }
    },
  );

  it('rotates the NW corner clockwise to the NE position at +90°', () => {
    const rect = { x: 0, y: 0, w: 200, h: 100 };
    const h = handlePositions(rect, Math.PI / 2);
    // Centre (100,50); local (-100,-50) rotated +90° -> (50,-100) -> (150,-50).
    expect(h.nw.x).toBeCloseTo(150, 9);
    expect(h.nw.y).toBeCloseTo(-50, 9);
  });
});

describe('hitTest', () => {
  it('returns the topmost sticker in an overlap', () => {
    const bottom = parked({ id: 'bottom', z: 1 });
    const top = parked({ id: 'top', z: 5 });
    const hit = hitTest({ x: 400, y: 300 }, [bottom, top], 800, 600);
    expect(hit).toBe('top');
  });

  it('misses a point inside the un-rotated bbox but outside a 45°-rotated sticker', () => {
    // Wide short sticker centred; rotating 45° sweeps its corners out of the
    // bbox corners. The bbox corner (near x0,y0) is inside the un-rotated
    // rect but outside the rotated shape.
    const st = parked({ id: 'rot', w: 0.6, h: 0.2, rot: Math.PI / 4 });
    const rect = stickerRect(st, 800, 600); // x:160..640, y:240..360
    const corner = { x: rect.x + 2, y: rect.y + 2 };
    expect(hitTest(corner, [st], 800, 600)).toBeNull();
  });

  it('hits a point only covered because of rotation', () => {
    // Tall sticker rotated 90° becomes wide; a point on the (new) long axis
    // near the edge is inside only because of rotation.
    const st = parked({ id: 'tall', w: 0.2, h: 0.6, rot: Math.PI / 2 });
    // Centre (400,300). Long axis now horizontal: (520,300) is on it.
    expect(hitTest({ x: 520, y: 300 }, [st], 800, 600)).toBe('tall');
    // Un-rotated, (520,300) would be outside the bbox (x only reaches 480).
    const flat = parked({ id: 'flat', w: 0.2, h: 0.6, rot: 0 });
    expect(hitTest({ x: 520, y: 300 }, [flat], 800, 600)).toBeNull();
  });

  it('misses when nothing is under the point', () => {
    expect(hitTest({ x: 10, y: 10 }, [parked()], 800, 600)).toBeNull();
    expect(hitTest({ x: 400, y: 300 }, [], 800, 600)).toBeNull();
  });

  it('is inclusive of the edge', () => {
    const st = parked({ w: 0.5, h: 0.5 }); // 400x300 px centred -> edges at 200/600, 150/450
    expect(hitTest({ x: 200, y: 150 }, [st], 800, 600)).toBe('s1');
    expect(hitTest({ x: 600, y: 450 }, [st], 800, 600)).toBe('s1');
  });
});

describe('resizeRect — corner pinning', () => {
  // Image 1000x1000; sticker centred, 200x200 px -> rect 400..600 both axes.
  const base = () => parked({ cx: 0.5, cy: 0.5, w: 0.2, h: 0.2, rot: 0 });

  const cases = [
    // [handle, pointerPx, pinned corner (fx, fy), moved corner (fx, fy)]
    ['nw', { x: 300, y: 350 }, { x: 600, y: 600 }, { x: 300, y: 350 }],
    ['ne', { x: 700, y: 350 }, { x: 400, y: 600 }, { x: 700, y: 350 }],
    ['sw', { x: 300, y: 650 }, { x: 600, y: 400 }, { x: 300, y: 650 }],
    ['se', { x: 700, y: 650 }, { x: 400, y: 400 }, { x: 700, y: 650 }],
  ];

  it.each(cases)('%s pins the opposite corner', (handle, ptr, pinned, moved) => {
    const out = resizeRect(base(), handle, ptr, { imgW: 1000, imgH: 1000, keepAspect: false });
    const rect = stickerRect({ rot: 0, ...out }, 1000, 1000);
    const corners = {
      [pinned.x === rect.x ? 'x0' : 'x1']: pinned.x,
      [moved.x === rect.x ? 'x0' : 'x1']: moved.x,
    };
    // Pinned edge untouched; moved corner at the pointer.
    if (handle.includes('w') || handle.includes('e')) {
      expect(rect.x).toBeCloseTo(Math.min(pinned.x, moved.x), 9);
      expect(rect.x + rect.w).toBeCloseTo(Math.max(pinned.x, moved.x), 9);
    }
    if (handle.includes('n') || handle.includes('s')) {
      expect(rect.y).toBeCloseTo(Math.min(pinned.y, moved.y), 9);
      expect(rect.y + rect.h).toBeCloseTo(Math.max(pinned.y, moved.y), 9);
    }
    expect(corners).toBeTruthy();
  });

  it('edge handles move only one axis', () => {
    const east = resizeRect(base(), 'e', { x: 700, y: 123 }, { imgW: 1000, imgH: 1000, keepAspect: false });
    const rectE = stickerRect({ rot: 0, ...east }, 1000, 1000);
    expect(rectE.x).toBeCloseTo(400, 9); // west edge pinned
    expect(rectE.x + rectE.w).toBeCloseTo(700, 9); // east edge follows
    expect(rectE.y).toBeCloseTo(400, 9);
    expect(rectE.y + rectE.h).toBeCloseTo(600, 9);
  });

  it('never collapses below a 2px minimum', () => {
    const out = resizeRect(base(), 'e', { x: 401, y: 500 }, { imgW: 1000, imgH: 1000, keepAspect: false });
    const rect = stickerRect({ rot: 0, ...out }, 1000, 1000);
    expect(rect.w).toBeGreaterThanOrEqual(2);
  });

  it('keepAspect preserves the pixel ratio on a corner drag', () => {
    // Non-square image + non-square sticker so normalized and pixel ratios differ.
    const st = parked({ cx: 0.5, cy: 0.5, w: 0.4, h: 0.2, rot: 0 }); // px: 800x200 -> ratio 4
    const out = resizeRect(st, 'se', { x: 900, y: 600 }, { imgW: 2000, imgH: 1000, keepAspect: true });
    const rect = stickerRect({ rot: 0, ...out }, 2000, 1000);
    expect(rect.w / rect.h).toBeCloseTo(4, 9);
    // Pinned NW corner stays at (600, 400).
    expect(rect.x).toBeCloseTo(600, 9);
    expect(rect.y).toBeCloseTo(400, 9);
  });

  it('keepAspect on an edge drag derives the other axis and keeps the centre', () => {
    const st = parked({ cx: 0.5, cy: 0.5, w: 0.4, h: 0.2, rot: 0 }); // 800x200, ratio 4
    const out = resizeRect(st, 'e', { x: 1200, y: 500 }, { imgW: 2000, imgH: 1000, keepAspect: true });
    const rect = stickerRect({ rot: 0, ...out }, 2000, 1000);
    expect(rect.w / rect.h).toBeCloseTo(4, 9);
    expect(rect.y + rect.h / 2).toBeCloseTo(500, 9); // centre y unchanged
  });

  it('requires the options object: positional dimensions throw', () => {
    expect(() => resizeRect(base(), 'se', { x: 700, y: 700 }, 1000, 1000, false)).toThrow(TypeError);
    expect(() => resizeRect(base(), 'se', { x: 700, y: 700 })).toThrow(TypeError);
  });
});

describe('rotateTo', () => {
  it('returns atan2 of the pointer offset', () => {
    expect(rotateTo({ x: 0, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(0, 12);
    expect(rotateTo({ x: 0, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(Math.PI / 2, 12);
    expect(rotateTo({ x: 0, y: 0 }, { x: -1, y: 0 })).toBeCloseTo(Math.PI, 12);
    expect(rotateTo({ x: 0, y: 0 }, { x: 0, y: -1 })).toBeCloseTo(-Math.PI / 2, 12);
  });

  it('snaps to the nearest 15° when snap=true', () => {
    // 10° -> 15°, 22° -> 15°, 23° -> 30° (nearest multiple of 15).
    const at = (deg) => {
      const r = (deg * Math.PI) / 180;
      return rotateTo({ x: 0, y: 0 }, { x: Math.cos(r), y: Math.sin(r) }, true);
    };
    expect(at(10)).toBeCloseTo(Math.PI / 12, 12);
    expect(at(22)).toBeCloseTo(Math.PI / 12, 12);
    expect(at(23)).toBeCloseTo(Math.PI / 6, 12);
    expect(at(0)).toBeCloseTo(0, 12);
    // -8 is 8 away from 0 and 7 away from -15 -> nearest multiple of 15 is -15.
    expect(at(-8)).toBeCloseTo(-Math.PI / 12, 12);
  });

  it('does not snap when snap is false/omitted', () => {
    const r = (10 * Math.PI) / 180;
    const angle = rotateTo({ x: 0, y: 0 }, { x: Math.cos(r), y: Math.sin(r) });
    expect(angle).toBeCloseTo(r, 12);
  });
});

describe('nudge', () => {
  it('moves by pixel deltas, normalized, without mutating the input', () => {
    const st = parked({ cx: 0.5, cy: 0.5 });
    const out = nudge(st, 50, -100, 1000, 1000);
    expect(out.cx).toBeCloseTo(0.55, 12);
    expect(out.cy).toBeCloseTo(0.4, 12);
    expect(st.cx).toBe(0.5);
    expect(st.cy).toBe(0.5);
    expect(out.id).toBe(st.id);
  });

  it('scales x by imgW and y by imgH independently', () => {
    const out = nudge(parked({ cx: 0, cy: 0 }), 192, 54, 1920, 1080);
    expect(out.cx).toBeCloseTo(0.1, 12);
    expect(out.cy).toBeCloseTo(0.05, 12);
  });
});

describe('clampViewPan', () => {
  it('keeps pan within 75% of the CSS box (25% visible)', () => {
    const v = clampViewPan({ dx: 5000, dy: -5000, scale: 1 }, 400, 300);
    expect(v.dx).toBe(300); // 0.75 * 400
    expect(v.dy).toBe(-225); // -0.75 * 300
    expect(v.scale).toBe(1);
  });

  it('passes small pans through unchanged and carries scale (pinch hook)', () => {
    const v = clampViewPan({ dx: 12, dy: -8, scale: 1.5 }, 400, 300);
    expect(v).toEqual({ dx: 12, dy: -8, scale: 1.5 });
  });

  it('tolerates missing/zero dimensions without throwing', () => {
    expect(clampViewPan({ dx: 10, dy: 10 }, 0, 0)).toEqual({ dx: 0, dy: 0, scale: 1 });
    expect(clampViewPan(undefined, 400, 300)).toEqual({ dx: 0, dy: 0, scale: 1 });
  });

  it('keeps the sample pans from the mobile gate inside the clamp', () => {
    // The gate pans 60/40 CSS px on a 390×260 box; clamp is 292.5/195 — free.
    const v = clampViewPan({ dx: 60, dy: 40, scale: 1 }, 390, 260);
    expect(v).toEqual({ dx: 60, dy: 40, scale: 1 });
  });
});

describe('undo/redo across 20 operations (spec: 20-op drag chain)', () => {
  // Minimal local store doubles as executable spec for js/store.js undo shape:
  // each entry is a {undo, redo} closure pair; a drag pushes ONE entry on release.
  it('restores state through 20 mixed operations and replays them', () => {
    const sticker = parked({ cx: 0.5, cy: 0.5, rot: 0 });
    const stack = [];
    const apply = (before, after) => stack.push({ undo: () => Object.assign(sticker, before), redo: () => Object.assign(sticker, after) });
    const undo = () => stack.pop().undo();
    const redo = (entry) => entry.redo();

    const snapshots = [{ ...sticker }];
    for (let i = 1; i <= 20; i++) {
      const before = { ...sticker };
      if (i % 3 === 0) {
        sticker.rot = (i * 15 * Math.PI) / 180;
      } else if (i % 2 === 0) {
        sticker.w = 0.2 + i * 0.005;
      } else {
        sticker.cx = 0.5 + i * 0.01;
        sticker.cy = 0.5 - i * 0.005;
      }
      const after = { ...sticker };
      apply(before, after);
      snapshots.push({ ...after });
    }

    const entries = [...stack];
    for (let i = 19; i >= 0; i--) {
      undo();
      const expected = snapshots[i];
      expect(sticker.cx).toBe(expected.cx);
      expect(sticker.cy).toBe(expected.cy);
      expect(sticker.w).toBe(expected.w);
      expect(sticker.rot).toBe(expected.rot);
    }
    expect(sticker.cx).toBe(0.5);
    for (const entry of entries) {
      redo(entry);
      stack.push(entry);
    }
    expect(sticker).toEqual(snapshots[20]);
    expect(stack.length).toBe(20);
  });
});

describe('isDoubleTap (double-tap window)', () => {
  it('is true inside 350ms and 25 CSS px', () => {
    expect(isDoubleTap({ x: 100, y: 100, t: 0 }, { x: 100, y: 100, t: 350 })).toBe(true);
    expect(isDoubleTap({ x: 100, y: 100, t: 0 }, { x: 108, y: 100, t: 200 })).toBe(true);
    expect(isDoubleTap({ x: 100, y: 100, t: 0 }, { x: 100, y: 125, t: 200 })).toBe(true);
    expect(isDoubleTap({ x: 100, y: 100, t: 0 }, { x: 117.6, y: 117.6, t: 100 })).toBe(true); // ~25px diag
  });

  it('is false outside the window', () => {
    expect(isDoubleTap({ x: 100, y: 100, t: 0 }, { x: 100, y: 100, t: 351 })).toBe(false);
    expect(isDoubleTap({ x: 100, y: 100, t: 0 }, { x: 126, y: 100, t: 200 })).toBe(false);
    expect(isDoubleTap({ x: 100, y: 100, t: 0 }, { x: 100, y: 100, t: -1 })).toBe(false);
    expect(isDoubleTap({ x: 100, y: 100, t: 0 }, { x: 110, y: 100, t: 400 })).toBe(false); // close but slow
  });

  it('tolerates missing/bad input without throwing', () => {
    expect(isDoubleTap(null, { x: 0, y: 0, t: 0 })).toBe(false);
    expect(isDoubleTap({ x: 0, y: 0, t: 0 }, null)).toBe(false);
    expect(isDoubleTap({ x: 'a' }, { x: 0, y: 0, t: 0 })).toBe(false);
  });

  it('respects custom opts', () => {
    expect(isDoubleTap({ x: 0, y: 0, t: 0 }, { x: 0, y: 0, t: 500 }, { maxMs: 600 })).toBe(true);
    expect(isDoubleTap({ x: 0, y: 0, t: 0 }, { x: 0, y: 40, t: 100 }, { maxDistCssPx: 40 })).toBe(true);
  });
});

describe('angleDelta (the wrap-safe rotation step)', () => {
  it('is zero for an unchanged angle', () => {
    expect(angleDelta(-Math.PI / 2, -Math.PI / 2)).toBeCloseTo(0, 12);
  });

  it('takes the short way round when the pointer crosses the ±PI axis', () => {
    // 170° -> -170° is a +20° step, not -340°.
    expect(angleDelta((170 * Math.PI) / 180, (-170 * Math.PI) / 180)).toBeCloseTo((20 * Math.PI) / 180, 12);
    expect(angleDelta((-170 * Math.PI) / 180, (170 * Math.PI) / 180)).toBeCloseTo((-20 * Math.PI) / 180, 12);
  });

  it('never reports more than half a turn', () => {
    for (let deg = -720; deg <= 720; deg += 7) {
      expect(Math.abs(angleDelta(0, (deg * Math.PI) / 180))).toBeLessThanOrEqual(Math.PI + 1e-12);
    }
  });

  it('makes the grab itself a zero step, so the handle does not jump', () => {
    // The bug: the rotate handle sits above (cx, cy), so the pointer's ABSOLUTE
    // angle there is -90°, and writing that into `rot` snapped the sticker. As a
    // delta baseline it is free, and 2 px straight up stays 0°.
    const grab = rotateTo({ x: 100, y: 100 }, { x: 100, y: 60 });
    const nudged = rotateTo({ x: 100, y: 100 }, { x: 100, y: 58 });
    expect(grab).toBeCloseTo(-Math.PI / 2, 12);
    expect(angleDelta(grab, nudged)).toBeCloseTo(0, 12);
  });
});

describe('snapAngle (the 15° rotate snap — one definition)', () => {
  it('rounds to the nearest 15°', () => {
    const step = Math.PI / 12;
    expect(snapAngle((7 * Math.PI) / 180)).toBeCloseTo(0, 12);
    expect(snapAngle((8 * Math.PI) / 180)).toBeCloseTo(step, 12);
    expect(snapAngle((-225 * Math.PI) / 180)).toBeCloseTo((-225 * Math.PI) / 180, 12);
  });

  it('is exactly what rotateTo applies when asked to snap', () => {
    const at = (deg) => ({
      x: 100 + 100 * Math.cos((deg * Math.PI) / 180),
      y: 100 + 100 * Math.sin((deg * Math.PI) / 180),
    });
    expect(rotateTo({ x: 100, y: 100 }, at(37), true)).toBeCloseTo(snapAngle((37 * Math.PI) / 180), 12);
  });
});

describe('clampViewScale (pinch zoom range)', () => {
  it('clamps to 1…8 with 1 as the fit floor', () => {
    expect(clampViewScale(1)).toBe(1);
    expect(clampViewScale(3)).toBe(3);
    expect(clampViewScale(0.5)).toBe(1);
    expect(clampViewScale(0)).toBe(1);
    expect(clampViewScale(100)).toBe(8);
    expect(VIEW_MIN_SCALE).toBe(1);
    expect(VIEW_MAX_SCALE).toBe(8);
  });

  it('falls back to 1 for non-finite input instead of inverting the projection', () => {
    expect(clampViewScale(NaN)).toBe(1);
    expect(clampViewScale(Infinity)).toBe(1);
    expect(clampViewScale(undefined)).toBe(1);
  });
});

describe('clampViewPan with scale', () => {
  it('clamps scale to 1…8 while clamping the offset against the SCALED image', () => {
    // 400x300 at scale 2: allowance is 75% of 800x600.
    expect(clampViewPan({ dx: 5000, dy: -5000, scale: 2 }, 400, 300)).toEqual({
      dx: 600, dy: -450, scale: 2,
    });
    expect(clampViewPan({ dx: 5000, dy: 5000, scale: 100 }, 400, 300).scale).toBe(8);
    expect(clampViewPan({ dx: 5000, dy: 5000, scale: 0 }, 400, 300).scale).toBe(1);
  });

  it('at scale 1 this is exactly the old 75%-of-CSS-box pan clamp', () => {
    expect(clampViewPan({ dx: 5000, dy: -5000, scale: 1 }, 400, 300)).toEqual({
      dx: 300, dy: -225, scale: 1,
    });
  });

  it('lets a focal zoom reach a large negative offset at high zoom (not snapped to the 1x clamp)', () => {
    // Focal zoom at scale 3 about a centre focal derives dx = -400 for a
    // 390-wide image; the 1x clamp (-292.5) would snap the focal point.
    const v = focalZoomView({ dx: 0, dy: 0, scale: 1 }, { x: 100, y: 100 }, { x: 100, y: 100 }, 30, 90, 390, 260);
    expect(v.scale).toBe(3);
    expect(v.dx).toBe(-200);
    expect(v.dy).toBe(-200);
  });
});

describe('focalZoomView (pure focal derivation)', () => {
  it('keeps the image point under the focal point fixed while zooming', () => {
    const startView = { dx: 0, dy: 0, scale: 1 };
    const focal = { x: 100, y: 100 };
    const v = focalZoomView(startView, focal, focal, 30, 90, 390, 260);
    expect(v.scale).toBe(3);
    // Image point under focal at start: (100-0)/1 = 100. At the end it must
    // still map to the focal: focal - point*scale = 100 - 100*3 = -200.
    expect(v.dx).toBe(-200);
    expect(v.dy).toBe(-200);
    // Round-trip through the projection: (focal - dx)/scale === start point.
    expect((focal.x - v.dx) / v.scale).toBeCloseTo(100, 9);
    expect((focal.y - v.dy) / v.scale).toBeCloseTo(100, 9);
  });

  it('reduces to a plain pan when the finger distance is unchanged', () => {
    const v = focalZoomView({ dx: 10, dy: 20, scale: 1 }, { x: 100, y: 100 }, { x: 160, y: 140 }, 60, 60, 390, 260);
    expect(v).toEqual({ dx: 70, dy: 60, scale: 1 });
  });

  it('clamps both ends: zooming in past 8 stays at 8, out past 1 stays at 1', () => {
    const big = focalZoomView({ dx: 0, dy: 0, scale: 1 }, { x: 195, y: 130 }, { x: 195, y: 130 }, 30, 300, 390, 260);
    expect(big.scale).toBe(8);
    const small = focalZoomView({ dx: 0, dy: 0, scale: 1 }, { x: 195, y: 130 }, { x: 195, y: 130 }, 300, 6, 390, 260);
    expect(small.scale).toBe(1);
    // At scale 1 the offset must still be inside the pan clamp (no blast-off).
    expect(Math.abs(small.dx)).toBeLessThanOrEqual(0.75 * 390);
    expect(Math.abs(small.dy)).toBeLessThanOrEqual(0.75 * 260);
  });

  it('derives from start values only (a longer pinch does not accumulate drift)', () => {
    const a = focalZoomView({ dx: 0, dy: 0, scale: 1 }, { x: 195, y: 130 }, { x: 195, y: 130 }, 30, 90, 390, 260);
    const b = focalZoomView({ dx: 0, dy: 0, scale: 1 }, { x: 195, y: 130 }, { x: 195, y: 130 }, 30, 90, 390, 260);
    expect(a).toEqual(b);
    // scale = startScale * k, not the product of per-step ratios.
    expect(a.scale).toBe(3);
  });

  it('handles zero/degenerate distances without throwing', () => {
    expect(focalZoomView({ dx: 0, dy: 0, scale: 2 }, { x: 10, y: 10 }, { x: 20, y: 20 }, 0, 90, 390, 260).scale).toBe(2);
    expect(focalZoomView(undefined, { x: 0, y: 0 }, { x: 0, y: 0 }, 30, 90, 390, 260).scale).toBe(3);
  });
});
