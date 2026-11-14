// Store unit tests — imports ONLY js/store.js. No DOM, no canvas.

import { describe, it, expect } from 'vitest';
import { Store } from '../js/store.js';

function makeStore() {
  const store = new Store();
  const events = [];
  store.subscribe((e) => events.push(e));
  return { store, events };
}

describe('Store — z uniqueness', () => {
  it('z stays unique after delete + add, and after an undo of the delete', () => {
    const { store } = makeStore();
    const a = store.add({ kind: 'emoji', cx: 0.2, cy: 0.2 });
    const b = store.add({ kind: 'emoji', cx: 0.5, cy: 0.5 });
    const c = store.add({ kind: 'emoji', cx: 0.8, cy: 0.8 });
    expect(store.state.stickers.map((s) => s.z)).toEqual([1, 2, 3]);

    store.remove(b.id); // ids a, c with z 1, 3
    const d = store.add({ kind: 'emoji', cx: 0.9, cy: 0.9 });
    // `length + 1` would give z=3 again; max+1 gives 4.
    expect(new Set(store.state.stickers.map((s) => s.z)).size).toBe(store.state.stickers.length);
    expect(d.z).toBeGreaterThan(c.z);
    expect(store.state.stickers.map((s) => s.z)).toEqual([1, 3, 4]);

    // Undo the add, then undo the delete: the restored list keeps unique z.
    store.undo();
    expect(new Set(store.state.stickers.map((s) => s.z)).size).toBe(store.state.stickers.length);
    store.undo();
    expect(new Set(store.state.stickers.map((s) => s.z)).size).toBe(store.state.stickers.length);
    expect(store.state.stickers.map((s) => s.id)).toEqual([a.id, b.id, c.id]);
    expect(store.state.stickers.map((s) => s.z)).toEqual([1, 2, 3]);
  });

  it('z is the store\'s to assign: a caller-supplied z is ignored, duplicates renumbered', () => {
    const { store } = makeStore();
    store.add({ kind: 'emoji', cx: 0.2, cy: 0.2, z: 1 });
    store.add({ kind: 'emoji', cx: 0.5, cy: 0.5, z: 1 });
    expect(store.state.stickers.map((s) => s.z)).toEqual([1, 2]);

    // A carried layout arrives with the previous photo's z values.
    store.setStickers([
      { kind: 'emoji', cx: 0.3, cy: 0.3, z: 5 },
      { kind: 'emoji', cx: 0.6, cy: 0.6, z: 5 },
    ]);
    expect(store.state.stickers.map((s) => s.z)).toEqual([1, 2]);
  });
});

describe('Store — basics', () => {
  it('adds a sticker with defaults and selects it', () => {
    const { store } = makeStore();
    const s = store.add({ kind: 'emoji', src: 'assets/emoji/1f600.svg' });
    expect(s.id).toBeTruthy();
    expect(store.state.stickers).toHaveLength(1);
    expect(store.state.selection).toBe(s.id);
    expect(s.cx).toBe(0.5);
    expect(s.rot).toBe(0);
  });

  it('reassigns colliding ids', () => {
    const { store } = makeStore();
    const a = store.add({ id: 's1', kind: 'emoji' });
    const b = store.add({ id: 's1', kind: 'emoji' });
    expect(a.id).toBe('s1');
    expect(b.id).not.toBe('s1');
    expect(new Set(store.state.stickers.map((s) => s.id)).size).toBe(2);
  });

  it('ignores unknown ids without throwing', () => {
    const { store } = makeStore();
    expect(() => {
      store.move('nope', { cx: 0.1 });
      store.remove('nope');
      store.raise('nope');
    }).not.toThrow();
  });

  it('emits change events to subscribers', () => {
    const { store, events } = makeStore();
    store.add({ kind: 'emoji' });
    expect(events.length).toBeGreaterThan(0);
  });

  it('clamps radius to 0..0.5 and strength to >= 0', () => {
    const { store } = makeStore();
    const s = store.add({ kind: 'blur', radius: 9, strength: -5 });
    expect(s.radius).toBe(0.5);
    expect(s.strength).toBe(0);
  });
});

describe('Store — moveTo', () => {
  it('moves a sticker to any array position, with z renumbered 1..n in array order', () => {
    const { store } = makeStore();
    const a = store.add({ id: 'a', kind: 'emoji' });
    const b = store.add({ id: 'b', kind: 'emoji' });
    const c = store.add({ id: 'c', kind: 'emoji' });
    store.moveTo(a.id, 2);
    expect(store.state.stickers.map((s) => s.id)).toEqual(['b', 'c', 'a']);
    expect(store.state.stickers.map((s) => s.z)).toEqual([1, 2, 3]);
    expect(store.orderedStickers().map((s) => s.id)).toEqual(['b', 'c', 'a']);
    store.moveTo(c.id, 0);
    expect(store.state.stickers.map((s) => s.id)).toEqual(['c', 'b', 'a']);
    expect(store.state.stickers.map((s) => s.z)).toEqual([1, 2, 3]);
  });

  it('clamps at both ends, and an out-of-range call is a no-op', () => {
    const { store } = makeStore();
    const a = store.add({ id: 'a', kind: 'emoji' });
    store.add({ id: 'b', kind: 'emoji' });
    const depth = store._undo.length;
    store.moveTo(a.id, 99); // clamped to the top
    expect(store.state.stickers.map((s) => s.id)).toEqual(['b', 'a']);
    store.moveTo(a.id, -99); // clamped to the bottom
    expect(store.state.stickers.map((s) => s.id)).toEqual(['a', 'b']);
    expect(store._undo.length).toBe(depth + 2);
    // Already at the clamped position: nothing to push.
    store.moveTo(a.id, -5);
    expect(store._undo.length).toBe(depth + 2);
    store.moveTo('nope', 0);
    expect(store._undo.length).toBe(depth + 2);
  });

  it('a same-index move pushes NO undo entry', () => {
    const { store } = makeStore();
    const a = store.add({ id: 'a', kind: 'emoji' });
    store.add({ id: 'b', kind: 'emoji' });
    const depth = store._undo.length;
    store.moveTo('b', 1);
    expect(store._undo.length).toBe(depth);
    expect(store.state.stickers.map((s) => s.z)).toEqual([1, 2]);
  });

  it('raise then undo restores the original order and z', () => {
    const { store } = makeStore();
    store.add({ id: 'a', kind: 'emoji' });
    store.add({ id: 'b', kind: 'emoji' });
    store.add({ id: 'c', kind: 'emoji' });
    store.raise('a');
    expect(store.state.stickers.map((s) => s.id)).toEqual(['b', 'a', 'c']);
    store.undo();
    expect(store.state.stickers.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(store.state.stickers.map((s) => s.z)).toEqual([1, 2, 3]);
  });

  it('is exactly one undo step for a long drag', () => {
    const { store } = makeStore();
    const first = store.add({ id: 'a', kind: 'emoji' });
    store.add({ id: 'b', kind: 'emoji' });
    store.add({ id: 'c', kind: 'emoji' });
    store.add({ id: 'd', kind: 'emoji' });
    store.add({ id: 'e', kind: 'emoji' });
    const depth = store._undo.length;
    store.moveTo(first.id, 4);
    expect(store._undo.length).toBe(depth + 1);
    expect(store.state.stickers.map((s) => s.id)).toEqual(['b', 'c', 'd', 'e', 'a']);
    store.undo();
    expect(store.state.stickers.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('Store — undo/redo', () => {
  it('undoes and redoes an add', () => {
    const { store } = makeStore();
    store.add({ kind: 'emoji' });
    expect(store.state.stickers).toHaveLength(1);
    expect(store.undo()).toBe(true);
    expect(store.state.stickers).toHaveLength(0);
    expect(store.redo()).toBe(true);
    expect(store.state.stickers).toHaveLength(1);
  });

  it('undoes a remove and restores the removed sticker', () => {
    const { store } = makeStore();
    store.add({ id: 's1', kind: 'emoji' });
    store.add({ id: 's2', kind: 'emoji' });
    store.remove('s1');
    expect(store.state.stickers.map((s) => s.id)).toEqual(['s2']);
    store.undo();
    expect(store.state.stickers.map((s) => s.id).sort()).toEqual(['s1', 's2']);
  });

  it('raise/lower swap z order and undo inverts them', () => {
    const { store } = makeStore();
    store.add({ id: 'a', kind: 'emoji', z: 1 });
    store.add({ id: 'b', kind: 'emoji', z: 2 });
    store.raise('a');
    const order = store.orderedStickers().map((s) => s.id);
    expect(order).toEqual(['b', 'a']);
    store.undo();
    expect(store.orderedStickers().map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('caps the undo stack at 100 and clears redo on a new action', () => {
    const { store } = makeStore();
    for (let i = 0; i < 250; i++) store.add({ kind: 'emoji' });
    expect(store._undo.length).toBe(100);
    store.undo();
    store.add({ kind: 'emoji' });
    expect(store.canRedo).toBe(false);
  });
});

describe('Store — drag coalescing', () => {
  it('coalesces a whole drag into ONE undo entry', () => {
    const { store } = makeStore();
    const s = store.add({ kind: 'emoji' });
    const depth = store._undo.length;
    store.beginDrag(s.id);
    for (let i = 0; i < 50; i++) store.move(s.id, { cx: 0.5 + i * 0.002 });
    expect(store._undo.length).toBe(depth); // previews are silent
    store.commitDrag();
    expect(store._undo.length).toBe(depth + 1);
    store.undo();
    expect(store.state.stickers[0].cx).toBeCloseTo(0.5, 12);
    store.redo();
    expect(store.state.stickers[0].cx).toBeCloseTo(0.5 + 49 * 0.002, 12);
  });

  it('commitDrag pushes nothing when nothing changed', () => {
    const { store } = makeStore();
    const s = store.add({ kind: 'emoji' });
    const depth = store._undo.length;
    store.beginDrag(s.id);
    store.commitDrag();
    expect(store._undo.length).toBe(depth);
  });

  it('cancelDrag restores the pre-drag state', () => {
    const { store } = makeStore();
    const s = store.add({ kind: 'emoji' });
    store.beginDrag(s.id);
    store.move(s.id, { cx: 0.9 });
    store.cancelDrag();
    expect(store.state.stickers[0].cx).toBe(0.5);
  });
});

describe('Store — 20-operation deterministic chain', () => {
  it('undo walks back 20 mixed ops and redo replays them', () => {
    const { store } = makeStore();
    const snapshots = [];
    const snap = () => JSON.stringify(store.state.stickers);
    // Pre-add state (empty) is snapshots[0]; the add produces snapshots[1].
    snapshots.push(snap());
    const s = store.add({ kind: 'emoji', cx: 0.5, cy: 0.5 });
    snapshots.push(snap());
    // 19 ops + the add = 20 undoable ops. Note i=0 moves cx to its current
    // value (0.5), which the store correctly treats as a no-op — so start
    // the loop at i=1 to get 19 real mutations (total depth 20).
    for (let i = 1; i <= 19; i++) {
      if (i % 4 === 0) store.move(s.id, { cx: 0.5 + i * 0.01 });
      else if (i % 4 === 1) store.resize(s.id, { w: 0.18 + i * 0.005 });
      else if (i % 4 === 2) store.rotate(s.id, (i * 15 * Math.PI) / 180);
      else store.move(s.id, { cy: 0.5 - i * 0.002 });
      snapshots.push(snap());
    }
    expect(store._undo.length).toBe(20);
    for (let i = 20; i >= 1; i--) {
      expect(store.undo()).toBe(true);
      expect(snap()).toBe(snapshots[i - 1]);
    }
    expect(store.state.stickers).toHaveLength(0); // add undone
    for (let i = 1; i <= 20; i++) {
      expect(store.redo()).toBe(true);
      expect(snap()).toBe(snapshots[i]);
    }
  });
});

describe('Store — double-click net-zero (place then delete)', () => {
  it('place then delete is two undo steps returning to the same state', () => {
    const { store } = makeStore();
    const before = JSON.stringify(store.state.stickers);
    const added = store.add({ kind: 'emoji', cx: 0.3, cy: 0.3 });
    store.remove(added.id);
    expect(JSON.stringify(store.state.stickers)).toBe(before);
    // Undo both -> same state again (undo stack not corrupted).
    store.undo(); // restores the deleted sticker
    expect(store.state.stickers).toHaveLength(1);
    expect(store.state.stickers[0].id).toBe(added.id);
    store.undo(); // undoes the add
    expect(JSON.stringify(store.state.stickers)).toBe(before);
    // Redo both -> nets to empty again.
    store.redo();
    expect(store.state.stickers).toHaveLength(1);
    store.redo();
    expect(JSON.stringify(store.state.stickers)).toBe(before);
  });

  it('removing the selected sticker clears the selection', () => {
    const { store } = makeStore();
    const a = store.add({ kind: 'emoji' });
    expect(store.state.selection).toBe(a.id);
    store.remove(a.id);
    expect(store.state.selection).toBeNull();
  });
});

describe('Store — photo boundary', () => {
  it('setImage with resetStickers leaves zero stickers and drops selection', () => {
    const { store } = makeStore();
    store.add({ kind: 'emoji', cx: 0.3, cy: 0.3 });
    store.add({ kind: 'emoji', cx: 0.7, cy: 0.7 });
    store.setImage({ name: 'b.jpg', naturalWidth: 800, naturalHeight: 1200 }, { resetStickers: true });
    expect(store.state.image.name).toBe('b.jpg');
    expect(store.state.stickers).toHaveLength(0);
    expect(store.state.selection).toBeNull();
  });

  it('clears undo and redo history at the boundary', () => {
    const { store } = makeStore();
    store.add({ kind: 'emoji' });
    store.undo();
    expect(store.canRedo).toBe(true);
    store.redo();
    store.setImage({ name: 'b.jpg' }, { resetStickers: true });
    expect(store.canUndo).toBe(false);
    expect(store.canRedo).toBe(false);
    expect(store._undo).toHaveLength(0);
    expect(store._redo).toHaveLength(0);
  });

  it('undo after a reset cannot restore the previous photo stickers', () => {
    const { store } = makeStore();
    store.add({ kind: 'emoji', cx: 0.3, cy: 0.3 });
    store.add({ kind: 'emoji', cx: 0.7, cy: 0.7 });
    store.setImage({ name: 'b.jpg' }, { resetStickers: true });
    expect(store.undo()).toBe(false);
    expect(store.state.stickers).toHaveLength(0);
    expect(store.state.image.name).toBe('b.jpg');
  });

  it('clearHistory alone drops both stacks', () => {
    const { store } = makeStore();
    store.add({ kind: 'emoji' });
    store.clearHistory();
    expect(store.canUndo).toBe(false);
    expect(store.undo()).toBe(false);
    expect(store.state.stickers).toHaveLength(1);
  });

  it('the carried layout is exactly one undoable step', () => {
    const { store } = makeStore();
    store.add({ kind: 'emoji', cx: 0.3, cy: 0.4 });
    store.add({ kind: 'emoji', cx: 0.65, cy: 0.45 });
    const layout = store.orderedStickers().map((s) => ({ ...s }));
    store.setImage({ name: 'b.jpg' }, { resetStickers: true });
    store.setStickers(layout);
    expect(store.state.stickers).toHaveLength(2);
    expect(store.undo()).toBe(true);
    expect(store.state.stickers).toHaveLength(0);
    expect(store.redo()).toBe(true);
    expect(store.state.stickers).toHaveLength(2);
  });
});

describe('Store — swapEmoji', () => {
  const BLACK = 'assets/emoji/2b1b.svg';
  const WHITE = 'assets/emoji/2b1c.svg';
  const addEmoji = (store) => store.add({ kind: 'emoji', src: BLACK, cx: 0.3, cy: 0.4, w: 0.2, h: 0.3, rot: 0.5 });

  it('replaces the artwork in place, leaving geometry and z alone', () => {
    const { store } = makeStore();
    const a = addEmoji(store);
    const before = { ...store.state.stickers.find((s) => s.id === a.id) };
    expect(store.swapEmoji(a.id, WHITE)).toBe(true);
    const after = store.state.stickers.find((s) => s.id === a.id);
    expect(after.src).toBe(WHITE);
    expect([after.cx, after.cy, after.w, after.h, after.rot, after.z])
      .toEqual([before.cx, before.cy, before.w, before.h, before.rot, before.z]);
  });

  it('pushes exactly ONE undo entry, and undo restores the old artwork', () => {
    const { store } = makeStore();
    const a = addEmoji(store);
    const depth = store._undo.length;
    store.swapEmoji(a.id, WHITE);
    expect(store._undo.length).toBe(depth + 1);
    expect(store.undo()).toBe(true);
    expect(store.state.stickers.find((s) => s.id === a.id).src).toBe(BLACK);
  });

  it('refuses a no-op and leaves no undo entry behind', () => {
    const { store } = makeStore();
    const a = addEmoji(store);
    const depth = store._undo.length;
    expect(store.swapEmoji(a.id, BLACK)).toBe(false);   // already that emoji
    expect(store.swapEmoji(a.id, '')).toBe(false);
    expect(store.swapEmoji(a.id, null)).toBe(false);
    expect(store.swapEmoji('no-such-id', WHITE)).toBe(false);
    expect(store._undo.length).toBe(depth);
    expect(store.state.stickers.find((s) => s.id === a.id).src).toBe(BLACK);
  });

  it('refuses to convert a patch kind — a blur has no artwork to swap', () => {
    const { store } = makeStore();
    const b = store.add({ kind: 'blur', cx: 0.3, cy: 0.4, radius: 0.2 });
    const depth = store._undo.length;
    const srcBefore = b.src;
    expect(store.swapEmoji(b.id, WHITE)).toBe(false);
    expect(store.state.stickers.find((s) => s.id === b.id).src).toBe(srcBefore);
    expect(store._undo.length).toBe(depth);
  });

  it("emits 'swap', never 'change' — 'change' is the tooltip-only fast path", () => {
    const { store, events } = makeStore();
    const a = addEmoji(store);
    events.length = 0;
    store.swapEmoji(a.id, WHITE);
    const types = events.map((e) => e.type);
    expect(types).toContain('swap');
    expect(types).not.toContain('change');
  });
});

describe('Store — a mutation during a live drag is its own undo step', () => {
  it('undoes the delete first, then the drag — never in the other order', () => {
    const { store } = makeStore();
    const a = store.add({ cx: 0.5, cy: 0.5 });
    store.add({ cx: 0.4, cy: 0.4 });
    store.beginDrag(a.id);
    store.move(a.id, { cx: 0.6 }); // the drag's own live preview: silent
    store.remove(a.id); // a concurrent mutation while the drag is still live
    expect(store.state.stickers.some((s) => s.id === a.id)).toBe(false);

    // Undo #1 must undo the DELETE — so the sticker returns as the drag left it.
    // A drag entry left on the stack ahead of it restores a snapshot taken before
    // the delete ever happened (cx 0.5), which reads to the user as "one Ctrl+Z
    // brought back a sticker I deleted".
    store.undo();
    const back = store.state.stickers.find((s) => s.id === a.id);
    expect(back).toBeTruthy();
    expect(back.cx).toBeCloseTo(0.6, 12);

    // Undo #2 must undo the drag, and only the drag.
    store.undo();
    expect(store.state.stickers.find((s) => s.id === a.id).cx).toBeCloseTo(0.5, 12);
    expect(store.state.stickers).toHaveLength(2);
  });

  it('a reorder mid-drag cannot fold the drag into the reorder entry', () => {
    const { store } = makeStore();
    const a = store.add({ cx: 0.5, cy: 0.5 });
    const b = store.add({ cx: 0.4, cy: 0.4 });
    store.beginDrag(b.id);
    store.move(b.id, { cx: 0.45 });
    store.raise(a.id); // pushes z to the top while the drag is live
    expect(store.state.stickers.map((s) => s.id)).toEqual([b.id, a.id]);
    store.undo();
    expect(store.state.stickers.map((s) => s.id)).toEqual([a.id, b.id]);
    expect(store.state.stickers.find((s) => s.id === b.id).cx).toBeCloseTo(0.45, 12);
  });
});

describe('Store — the selection always names a sticker that exists', () => {
  it('refuses a ghost id instead of storing it', () => {
    const { store } = makeStore();
    store.add({ cx: 0.5, cy: 0.5 });
    store.select('ghost');
    expect(store.state.selection).toBe(null);
  });

  it('clears a selection the new list no longer contains', () => {
    const { store } = makeStore();
    const a = store.add({ cx: 0.5, cy: 0.5 });
    expect(store.state.selection).toBe(a.id);
    store.setStickers([{ id: 'other', cx: 0.2, cy: 0.2, w: 0.1, h: 0.1, rot: 0, z: 1 }]);
    expect(store.state.selection).toBe(null);
  });

  it('gives two stickers that arrive with the same id distinct ones', () => {
    const { store } = makeStore();
    store.setStickers([{ id: 'dup', cx: 0.2, cy: 0.2 }, { id: 'dup', cx: 0.6, cy: 0.6 }]);
    const ids = store.state.stickers.map((s) => s.id);
    expect(new Set(ids).size).toBe(2);
  });
});
