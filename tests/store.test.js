// Store unit tests — imports ONLY js/store.js. No DOM, no canvas.

import { describe, it, expect } from 'vitest';
import { Store } from '../js/store.js';

function makeStore() {
  const store = new Store();
  const events = [];
  store.subscribe((e) => events.push(e));
  return { store, events };
}

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
