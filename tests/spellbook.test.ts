import { describe, expect, it } from 'vitest';
import { GESTURES, GESTURE_GROUPS, isDualGesture } from '../src/config/gestures.ts';
import { SPELLS } from '../src/config/spells.ts';
import { SpellBook } from '../src/spells/SpellBook.ts';
import type { KeyValueStore } from '../src/storage.ts';

const memory = (seed: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } => {
  const data = { ...seed };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => void (data[k] = v),
  };
};

describe('config integrity', () => {
  it('ships nineteen spells with a unique, valid default gesture each', () => {
    expect(SPELLS).toHaveLength(19);
    const defaults = SPELLS.map((s) => s.defaultGesture);
    expect(new Set(defaults).size).toBe(SPELLS.length);
    for (const id of defaults) expect(GESTURES.some((g) => g.id === id)).toBe(true);
  });

  it('offers a rich library: unique ids, every one grouped, one- and two-hand kinds', () => {
    expect(GESTURES.length).toBeGreaterThanOrEqual(24);
    expect(new Set(GESTURES.map((g) => g.id)).size).toBe(GESTURES.length);
    for (const g of GESTURES) {
      expect(g.name.length).toBeGreaterThan(0);
      expect(g.hint.length).toBeGreaterThan(10);
      expect(g.group in GESTURE_GROUPS).toBe(true);
    }
    expect(GESTURES.some((g) => isDualGesture(g))).toBe(true);
    expect(GESTURES.some((g) => !isDualGesture(g))).toBe(true);
  });

  it('lists a stricter variant before the looser one it overlaps', () => {
    const at = (id: string) => GESTURES.findIndex((g) => g.id === id);
    expect(at('phoenix')).toBeLessThan(at('rise'));
    expect(at('tempest')).toBeLessThan(at('swish'));
    expect(at('sunwise')).toBeLessThan(at('circle'));
    expect(at('moonwise')).toBeLessThan(at('circle'));
  });
});

describe('spell practice', () => {
  it('persists capped counts separately from bindings', () => {
    const store = memory();
    const book = new SpellBook(SPELLS, GESTURES, store);
    const id = SPELLS[0].id;
    let changes = 0;
    book.onChange(() => changes++);
    expect(book.practised(id)).toBe(0);
    for (let i = 0; i < 5; i++) book.practise(id);
    expect(changes).toBe(0);
    book.practise('unknown');
    expect(book.practised(id)).toBe(3);
    expect(book.practised('unknown')).toBe(0);
    expect(new SpellBook(SPELLS, GESTURES, store).practised(id)).toBe(3);
    expect(JSON.parse(store.data['arcane.practice.v1'])).toEqual({ [`${id}:${SPELLS[0].defaultGesture}`]: 3 });
    expect(store.data['arcane.spellbook.v1']).toBeUndefined();
  });

  it('tracks practice separately after rebinding', () => {
    const store = memory();
    const book = new SpellBook(SPELLS, GESTURES, store);
    const id = SPELLS[0].id;
    book.practise(id);
    book.assign(id, 'circle');
    expect(book.practised(id)).toBe(0);
    book.practise(id);
    book.practise(id);
    book.assign(id, SPELLS[0].defaultGesture);
    expect(book.practised(id)).toBe(1);
    book.assign(id, 'circle');
    expect(new SpellBook(SPELLS, GESTURES, store).practised(id)).toBe(2);
  });

  it('ignores corrupt counts and tolerates unavailable storage', () => {
    const id = SPELLS[0].id;
    const store = memory({ 'arcane.practice.v1': JSON.stringify({ [`${id}:${SPELLS[0].defaultGesture}`]: '3', unknown: 2 }) });
    const book = new SpellBook(SPELLS, GESTURES, store);
    expect(book.practised(id)).toBe(0);
    book.practise(id);
    expect(book.practised(id)).toBe(1);
    const unavailable = new SpellBook(SPELLS, GESTURES, { getItem: () => { throw Error(); }, setItem: () => { throw Error(); } });
    unavailable.practise(id);
    expect(unavailable.practised(id)).toBe(1);
    const noStore = new SpellBook(SPELLS, GESTURES, null);
    expect(() => noStore.practise(id)).not.toThrow();
    expect(noStore.practised(id)).toBe(1);
  });
});

describe('SpellBook', () => {
  it('starts from the defaults', () => {
    const book = new SpellBook(SPELLS, GESTURES, memory());
    expect(book.spellFor('bowdraw')?.id).toBe('spell-1');
    expect(book.gestureFor('spell-4')).toBeUndefined();
    expect(book.spells.some((spell) => spell.name === 'Gale')).toBe(false);
  });

  it('swaps bindings so a gesture never casts two spells', () => {
    const book = new SpellBook(SPELLS, GESTURES, memory());
    book.assign('spell-1', 'circle');
    expect(book.gestureFor('spell-1')?.id).toBe('circle');
    expect(book.gestureFor('spell-5')?.id).toBe('bowdraw');
    expect(book.spellFor('circle')?.id).toBe('spell-1');
  });

  it('persists and restores bindings', () => {
    const store = memory();
    new SpellBook(SPELLS, GESTURES, store).assign('spell-2', 'rise');
    const again = new SpellBook(SPELLS, GESTURES, store);
    expect(again.gestureFor('spell-2')?.id).toBe('rise');
  });

  it('upgrades an old held-point Bow binding without resetting other spell settings', () => {
    const store = memory({ 'arcane.spellbook.v1': '{"spell-1":"lance","spell-2":"fist"}' });
    const book = new SpellBook(SPELLS, GESTURES, store);
    expect(book.gestureFor('spell-1')?.id).toBe('bowdraw');
    expect(book.gestureFor('spell-2')?.id).toBe('fist');
  });

  it('survives corrupted saved data', () => {
    const book = new SpellBook(SPELLS, GESTURES, memory({ 'arcane.spellbook.v1': '{"spell-1":"nope","spell-2":"nope"}' }));
    expect(book.gestureFor('spell-1')).toBeDefined();
    const ids = SPELLS.map((s) => book.gestureFor(s.id)?.id);
    expect(new Set(ids).size).toBe(SPELLS.length);
  });

  it('resets to defaults', () => {
    const book = new SpellBook(SPELLS, GESTURES, memory());
    book.assign('spell-1', 'rise');
    book.resetToDefaults();
    expect(book.gestureFor('spell-1')?.id).toBe('bowdraw');
  });

  it('only activates gestures that are bound to a spell', () => {
    const book = new SpellBook(SPELLS, GESTURES, memory());
    const base = SPELLS.filter((s) => s.tier === 'base');
    expect(book.activeGestures().map((g) => g.id).sort()).toEqual(base.map((s) => s.defaultGesture).sort());
    book.assign('spell-1', 'eclipse');
    const ids = book.activeGestures().map((g) => g.id);
    expect(ids).toContain('eclipse');
    expect(ids).not.toContain('bowdraw');
    expect(ids).toHaveLength(base.length);
  });

  it('lets a gesture nobody uses replace the old one without swapping', () => {
    const book = new SpellBook(SPELLS, GESTURES, memory());
    book.assign('spell-2', 'cataclysm');
    expect(book.gestureFor('spell-2')?.id).toBe('cataclysm');
    expect(book.spellFor('impale')).toBeUndefined();
  });
});
