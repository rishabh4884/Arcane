import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEVELS } from '../src/game/campaign.ts';
import { Progress } from '../src/game/Progress.ts';
import { Encounter } from '../src/world/Encounter.ts';
import { GameEvents, type GameEvent } from '../src/world/events.ts';

vi.mock('../src/ui/EnemyIndicators.ts', () => ({
  EnemyIndicators: class {
    update() {}
    reset() {}
    dispose() {}
  },
}));

afterEach(() => vi.unstubAllGlobals());

describe('expanded campaign progression', () => {
  it('restores the same completed encounters and spells from a forty-level save', () => {
    const legacy = { completed: { 9: { time: 32, damageTaken: 0, stars: 3 }, 39: { time: 51, damageTaken: 14, stars: 2 } },
      learned: ['spell-13', 'spell-19'], last: 39 };
    const records = new Map([['arcane.journey.v1', JSON.stringify(legacy)]]);
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => records.get(key), setItem: (key: string, value: string) => records.set(key, value) } });
    const progress = new Progress();
    expect(progress.record(10)).toEqual(legacy.completed[9]);
    expect(progress.record(43)).toEqual(legacy.completed[39]);
    expect(progress.record(39)).toBeUndefined();
    expect(progress.lastPlayed).toBe(43);
    expect(progress.learned).toEqual(legacy.learned);
    progress.setLast(44);
    expect(new Progress().lastPlayed).toBe(44);
  });

  it('holds the Widow encounter in dialogue until her threat, then permits combat and victory', () => {
    const camera = new THREE.PerspectiveCamera(64, 16 / 9);
    camera.position.set(0, 1.85, 17);
    camera.lookAt(0, 1.2, -12);
    camera.updateMatrixWorld();
    const events = new GameEvents();
    const log: GameEvent[] = [];
    events.on((event) => log.push(event));
    const encounter = new Encounter(new THREE.Scene(), camera, [], () => null, { events });
    const advance = (frames: number) => { for (let i = 0; i < frames; i++) encounter.update(0.05, false, false); };
    try {
      encounter.startLevel(LEVELS.find((level) => level.boss === 'widow')!);
      advance(88);
      expect(encounter.snapshot().mode).toBe('boss-intro');
      expect(encounter.snapshot().boss).toBeNull();
      expect(encounter.cast('arrow')).toBe(false);
      expect(log.some((event) => event.type === 'boss-dialogue')).toBe(true);
      expect(log.some((event) => event.type === 'enemy-windup')).toBe(false);
      advance(600);
      expect(encounter.snapshot().mode).toBe('boss');
      expect(encounter.snapshot().boss?.health).toBeGreaterThan(0);
      expect(log.some((event) => event.type === 'boss-dialogue' && event.tense)).toBe(true);
      expect(encounter.cast('arrow')).toBe(true);
      expect(encounter.skipCurrentWave()).toBe(true);
      advance(54);
      expect(encounter.snapshot().mode).toBe('won');
    } finally {
      encounter.dispose();
    }
  });
});
