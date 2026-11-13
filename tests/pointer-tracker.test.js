// PointerTracker unit tests — imports ONLY js/pointer-tracker.js. No DOM.
import { describe, it, expect } from 'vitest';
import { PointerTracker } from '../js/pointer-tracker.js';

describe('PointerTracker', () => {
  it('starts empty and reports zero', () => {
    const t = new PointerTracker();
    expect(t.size).toBe(0);
    expect(t.centroid()).toEqual({ x: 0, y: 0 });
  });

  it('add grows count, update does not', () => {
    const t = new PointerTracker();
    expect(t.add(1, 10, 20)).toBe(1);
    expect(t.add(2, 30, 40)).toBe(2);
    expect(t.add(1, 11, 21)).toBe(2); // update same id
    expect(t.size).toBe(2);
  });

  it('remove deletes only the named id', () => {
    const t = new PointerTracker();
    t.add(1, 0, 0);
    t.add(2, 10, 10);
    expect(t.remove(1)).toBe(true);
    expect(t.size).toBe(1);
    expect(t.has(1)).toBe(false);
    expect(t.has(2)).toBe(true);
    expect(t.remove(99)).toBe(false);
  });

  it('centroid is the mean of live points', () => {
    const t = new PointerTracker();
    t.add(1, 0, 0);
    t.add(2, 20, 40);
    expect(t.centroid()).toEqual({ x: 10, y: 20 });
    t.remove(1);
    expect(t.centroid()).toEqual({ x: 20, y: 40 });
  });

  it('clear forgets all contacts', () => {
    const t = new PointerTracker();
    t.add(1, 1, 1);
    t.add(2, 2, 2);
    t.clear();
    expect(t.size).toBe(0);
    expect(t.values()).toEqual([]);
  });

  it('garbage coordinates fall back to 0 without throwing', () => {
    const t = new PointerTracker();
    t.add(1, NaN, Infinity);
    expect(t.values()[0]).toEqual({ x: 0, y: 0 });
  });
});
