import { GESTURE_GROUPS, isDualGesture, type GestureDef, type GestureGroup } from '../config/gestures.ts';
import type { SpellDef } from '../config/spells.ts';
import type { Tuning } from '../config/tuning.ts';
import { CREATURE_SPECS, type CreatureKind, type Rank } from '../world/EncounterState.ts';
import type { GraphicsMode } from '../world/Quality.ts';
import type { SpellBook } from '../spells/SpellBook.ts';
import { el } from './dom.ts';
import { createSpellIcon } from './spell-icons.ts';

export interface SettingsOptions {
  book: SpellBook;
  tuning: Tuning;
  defaults: Tuning;
  onTuning: (t: Tuning) => void;
  onDebug: (visible: boolean) => void;
  isDebugVisible: () => boolean;
  /** Optional graphics quality: Auto adapts to the device; the others hold a level. */
  graphics?: { mode(): GraphicsMode; set(mode: GraphicsMode): void };
  /** Optional master volume and mute. */
  sound?: { readonly volume: number; readonly muted: boolean; setVolume(v: number): void; setMuted(m: boolean): void };
  /** Optional admin character trial: fight one creature alone. */
  onTrial?: (kind: CreatureKind) => void;
}

const RANKS: Record<Rank, string> = { normal: 'Normal', sub: 'Sub-boss', final: 'Final boss' };

const ADMIN_CODE = 'admin69';
const smoothnessToCutoff = (s: number): number => 4 - (s / 100) * 3.5;
const cutoffToSmoothness = (c: number): number => Math.round(((4 - c) / 3.5) * 100);

/** A gesture dropdown for one spell, grouped by kind. Picking a gesture rebinds the spell. */
function gestureSelect(book: SpellBook, spell: SpellDef): HTMLSelectElement {
  const current = book.gestureFor(spell.id);
  const option = (g: GestureDef) => {
    const opt = el('option', { value: g.id }, `${g.glyph} ${g.name}${isDualGesture(g) ? ' · 2 hands' : ''}`);
    if (current?.id === g.id) opt.selected = true;
    return opt;
  };
  const groups = (Object.keys(GESTURE_GROUPS) as GestureGroup[]).map((key) =>
    el('optgroup', { label: GESTURE_GROUPS[key] }, ...book.gestures.filter((g) => g.group === key).map(option)),
  );
  return el('select', { 'aria-label': `Gesture for ${spell.name}`, onchange: (e: Event) => book.assign(spell.id, (e.target as HTMLSelectElement).value) }, ...groups);
}

/** The Spellbook panel: rebind gestures to spells and tune how the detection feels. */
export class SettingsPanel {
  readonly toggleButton: HTMLButtonElement;
  private readonly panel = el('aside', { class: 'panel', id: 'spellbook', hidden: true, 'aria-label': 'Settings' });
  private readonly o: SettingsOptions;
  private tuning: Tuning;
  private adminOpen = false;
  private adminUnlocked = false;
  private typed = '';
  private opener: HTMLElement | null = null;

  constructor(root: HTMLElement, options: SettingsOptions) {
    this.o = options;
    this.tuning = structuredClone(options.tuning);
    this.toggleButton = el('button', { class: 'tool', type: 'button', 'aria-controls': 'spellbook', 'aria-expanded': 'false', onclick: () => this.toggle() }, 'Settings');
    root.append(this.toggleButton, this.panel);
    options.book.onChange(() => !this.panel.hidden && this.render());
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !this.panel.hidden) { e.stopImmediatePropagation(); this.toggle(false); } });
    window.addEventListener('keydown', (e) => this.trySecret(e), { capture: true });
    this.render();
  }

  toggle(open = this.panel.hidden): void {
    if (open && this.panel.hidden) this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.panel.hidden = !open;
    this.toggleButton.setAttribute('aria-expanded', String(open));
    if (open) this.render();
    else { this.adminOpen = false; this.opener?.focus({ preventScroll: true }); this.opener = null; }
  }

  private soundControls(): HTMLElement[] {
    const sound = this.o.sound;
    if (!sound) return [];
    const out = el('output', {}, `${Math.round(sound.volume * 100)}%`);
    const volume = el('input', { type: 'range', min: 0, max: 100, step: 1, value: Math.round(sound.volume * 100), 'aria-label': 'Volume' });
    volume.addEventListener('input', () => {
      out.textContent = `${volume.value}%`;
      sound.setVolume(Number(volume.value) / 100);
    });
    const mute = el('input', { type: 'checkbox' });
    mute.checked = sound.muted;
    mute.addEventListener('change', () => sound.setMuted(mute.checked));
    return [
      el('h3', {}, 'Sound'),
      el('label', { class: 'row slider' }, el('span', { class: 'label' }, 'Volume'), volume, out),
      el('label', { class: 'row check' }, mute, el('span', {}, 'Mute (M)')),
    ];
  }

  private graphicsControls(): HTMLElement[] {
    const graphics = this.o.graphics;
    if (!graphics) return [];
    const mode = graphics.mode();
    const select = el(
      'select',
      { 'aria-label': 'Graphics quality', onchange: (event: Event) => graphics.set((event.target as HTMLSelectElement).value as GraphicsMode) },
      el('option', { value: 'auto', selected: mode === 'auto' }, 'Auto · suits this device'),
      el('option', { value: 'high', selected: mode === 'high' }, 'High · sharpest'),
      el('option', { value: 'balanced', selected: mode === 'balanced' }, 'Balanced'),
      el('option', { value: 'low', selected: mode === 'low' }, 'Low · smoothest'),
    );
    return [
      el('h3', {}, 'Graphics'),
      el('label', { class: 'row' }, el('span', { class: 'label' }, 'Quality'), select),
      el('p', { class: 'note' }, 'Auto adjusts graphics to keep the wood smooth on this device.'),
    ];
  }

  private renderAdmin(): void {
    const { book } = this.o;
    const rows = book.available.map((spell) => {
      const current = book.gestureFor(spell.id);
      const select = gestureSelect(book, spell);
      return el(
        'div',
        { class: 'spell-row', style: { '--spell': spell.color } },
        el('label', { class: 'row' }, createSpellIcon(spell.id), el('span', { class: 'label' }, spell.name), select),
        el('p', { class: 'hint' }, current?.hint ?? ''),
      );
    });
    this.panel.replaceChildren(
      this.header('Admin'),
      el('h3', {}, 'Spell assignment'),
      el('p', { class: 'note' }, 'Choose a gesture for each spell; selecting one already used swaps them.'),
      ...rows,
      el('button', { class: 'reset', type: 'button', onclick: () => book.resetToDefaults() }, 'Restore gesture defaults'),
      ...this.trialControls(),
    );
  }

  private trialControls(): HTMLElement[] {
    const { onTrial } = this.o;
    if (!onTrial) return [];
    const kinds = Object.keys(CREATURE_SPECS) as CreatureKind[];
    const select = el('select', { 'aria-label': 'Character' },
      ...(Object.keys(RANKS) as Rank[]).map((rank) =>
        el('optgroup', { label: RANKS[rank] }, ...kinds.filter((k) => CREATURE_SPECS[k].rank === rank).map((k) => el('option', { value: k }, CREATURE_SPECS[k].name)))));
    return [
      el('h3', {}, 'Character trial'),
      el('label', { class: 'row' }, el('span', { class: 'label' }, 'Character'), select),
      el('button', { class: 'reset', type: 'button', onclick: () => onTrial(select.value as CreatureKind) }, 'Begin trial'),
    ];
  }

  private header(title: string): HTMLElement {
    return el('header', {}, el('h2', {}, title), el('button', { class: 'close', type: 'button', 'aria-label': 'Close settings', onclick: () => this.toggle(false) }, '×'));
  }

  private openAdmin(): void {
    this.adminOpen = true;
    this.toggle(true);
    this.panel.scrollTop = 0;
    this.panel.querySelector<HTMLElement>('.close')?.focus();
  }

  /** Typing the admin code anywhere outside a field unlocks spell assignment for this session. */
  private trySecret(event: KeyboardEvent): void {
    if (event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.key.length !== 1) return;
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) return;
    this.typed = (this.typed + event.key.toLowerCase()).slice(-ADMIN_CODE.length);
    let matched = this.typed.length;
    while (matched && !this.typed.endsWith(ADMIN_CODE.slice(0, matched))) matched--;
    // Keep the code's letters from also firing single-key shortcuts (M mutes, D shows tracking).
    if (matched >= 2) { event.preventDefault(); event.stopImmediatePropagation(); }
    if (matched < ADMIN_CODE.length) return;
    this.typed = '';
    this.adminUnlocked = true;
    this.openAdmin();
  }

  private render(): void {
    if (this.adminOpen) { this.renderAdmin(); return; }

    const slider = (label: string, min: number, max: number, step: number, value: number, unit: string, set: (v: number) => void) => {
      const out = el('output', {}, `${value}${unit}`);
      const input = el('input', { type: 'range', min, max, step, value, 'aria-label': label });
      input.addEventListener('input', () => {
        const v = Number(input.value);
        out.textContent = `${v}${unit}`;
        set(v);
        this.o.onTuning(this.tuning);
      });
      return el('label', { class: 'row slider' }, el('span', { class: 'label' }, label), input, out);
    };

    const debug = el('input', { type: 'checkbox', id: 'arcane-debug-toggle' });
    debug.checked = this.o.isDebugVisible();
    debug.addEventListener('change', () => this.o.onDebug(debug.checked));
    const frameRate = el(
      'select',
      {
        'aria-label': 'Camera capture rate',
        onchange: (event: Event) => {
          const value = Number((event.target as HTMLSelectElement).value);
          this.tuning.cameraFps = value === 30 ? 30 : 60;
          this.o.onTuning(this.tuning);
        },
      },
      el('option', { value: '30', selected: this.tuning.cameraFps === 30 }, '30 fps · lower load'),
      el('option', { value: '60', selected: this.tuning.cameraFps === 60 }, '60 fps · smoother'),
    );

    this.panel.replaceChildren(
      this.header('Settings'),
      el('h3', {}, 'Feel'),
      el('label', { class: 'row' }, el('span', { class: 'label' }, 'Camera rate'), frameRate),
      el('p', { class: 'note' }, 'Camera hardware may deliver less than the requested cap; press D for actual rates.'),
      slider('Smoothness', 0, 100, 1, cutoffToSmoothness(this.tuning.smoothing.minCutoff), '', (v) => (this.tuning.smoothing.minCutoff = smoothnessToCutoff(v))),
      slider('Hold time', 150, 800, 10, this.tuning.poseHoldMs, ' ms', (v) => (this.tuning.poseHoldMs = v)),
      slider('Pause between casts', 200, 1500, 50, this.tuning.cooldownMs, ' ms', (v) => (this.tuning.cooldownMs = v)),
      slider('Reach', 1, 2, 0.05, this.tuning.cursorGain, '×', (v) => (this.tuning.cursorGain = v)),
      el('label', { class: 'row check' }, debug, el('span', {}, 'Show tracking view (D)')),
      ...this.graphicsControls(),
      ...this.soundControls(),
      el('button', {
        class: 'reset',
        type: 'button',
        onclick: () => {
          this.o.graphics?.set('auto');
          this.tuning = structuredClone(this.o.defaults);
          this.o.onTuning(this.tuning);
          this.render();
        },
      }, 'Restore defaults'),
      ...(this.adminUnlocked ? [el('button', { class: 'reset', type: 'button', onclick: () => this.openAdmin() }, 'Admin')] : []),
    );
  }
}
