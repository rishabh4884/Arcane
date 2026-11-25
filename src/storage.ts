export interface KeyValueStore { getItem(key: string): string | null; setItem(key: string, value: string): void }
/** A benchmark run (`?bench`) plays levels automatically; it must never touch the player's saves. */
const BENCH = typeof location !== 'undefined' && new URLSearchParams(location.search).has('bench');
const store = (): KeyValueStore | null => { try { return window.localStorage; } catch { return null; } };
export function loadJSON<T>(key: string, source: KeyValueStore | null | undefined = undefined): T | undefined { try { const raw = (source === undefined ? (BENCH ? null : store()) : source)?.getItem(key); return raw ? JSON.parse(raw) as T : undefined; } catch { return undefined; } }
export function saveJSON(key: string, value: unknown, source: KeyValueStore | null | undefined = undefined): void { try { (source === undefined ? (BENCH ? null : store()) : source)?.setItem(key, JSON.stringify(value)); } catch { /* storage is optional */ } }
