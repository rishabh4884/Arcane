import { GESTURE_GROUPS, isDualGesture, type GestureDef } from '../config/gestures.ts';
import { SPELLS, type SpellDef } from '../config/spells.ts';
import type { EngineOutput } from '../gestures/GestureEngine.ts';
import { CAST_CAP, type SpellBook } from '../spells/SpellBook.ts';
import { HAND_CONNECTIONS } from '../tracking/types.ts';
import { el } from './dom.ts';
import { createGestureDiagram } from './gesture-diagram.ts';
import { button, conceal, noop, screen, type Ui } from './screens.ts';
import { createSpellIcon } from './spell-icons.ts';
import './grimoire.css';

/**
 * THE GRIMOIRE
 * ────────────
 * An open book: every spell down the left, one page on the right. A known spell's page shows its
 * movement performed by a drawn hand beside the caster's own (live from the camera)
 * and counts practice casts. A sealed page says which ruler holds it.
 * Practice never casts: the world ignores casts while a menu or pause is up.
 */

const NOTICE_MS = 1800;
const TRAIL_MS = 700;
const W = 480, H = 360;
/** How quickly the practice view follows the hands (per frame). */
const FOLLOW = 0.18;

const groups = [
  { label: 'Known from the first night', spells: SPELLS.filter((s) => s.tier !== 'legend') },
  { label: 'Taken from the rulers', spells: SPELLS.filter((s) => s.tier === 'legend') },
];

type Point = { x: number; y: number; t: number };
/** What the practice canvas shows, in tracking space: a centre and the height it spans (4:3). */
type View = { x: number; y: number; span: number };

export class GrimoireScreen {
  readonly root = screen('grimoire', 'Grimoire');
  private readonly count = el('p', { class: 'grimoire-count' });
  private readonly index = el('nav', { class: 'grimoire-index', 'aria-label': 'Spells' });
  private readonly page = el('article', { class: 'grimoire-page', id: 'grimoire-page', 'aria-labelledby': 'grimoire-page-title' });
  private readonly entries = new Map<string, HTMLButtonElement>();
  private selected: SpellDef = SPELLS[0];

  // Practice: the caster's hands, the hold meter, and one status line that only speaks on change.
  private readonly canvas = el('canvas', { class: 'practice-hands', width: W, height: H });
  private readonly meter = el('div', { class: 'practice-meter', 'aria-hidden': 'true' }, el('span'));
  private readonly frame = el('div', { class: 'practice-frame' }, this.canvas, this.meter);
  private readonly status = el('p', { class: 'practice-status', 'aria-live': 'polite' });
  private readonly tally = el('p', { class: 'practice-tally' });
  private readonly trails = new Map<string, Point[]>();
  private view: View | null = null;
  private camera: string | null = 'Starting camera…';
  private framed = false;
  private notice: { text: string; until: number } | null = null;

  constructor(private readonly book: SpellBook, onBack: () => void, private readonly ui: Ui = noop) {
    this.root.append(
      el('header', { class: 'g-header' },
        button('← Back', onBack, 'g-button g-button--quiet', ui, null),
        el('div', {}, el('p', { class: 'g-eyebrow' }, 'Every spell has its own movement'), el('h2', {}, 'The Grimoire')),
        this.count),
      el('div', { class: 'grimoire-book' }, this.index, this.page),
    );
    this.index.addEventListener('keydown', (e) => this.step(e));
    book.onChange(() => { if (!this.root.hidden) this.render(); });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !this.root.hidden) { e.stopImmediatePropagation(); onBack(); } });
  }

  show(): void {
    this.framed = false;
    this.render();
    this.root.hidden = false;
    this.root.scrollTop = 0;
    const entry = this.entries.get(this.selected.id);
    entry?.focus({ preventScroll: true });
    entry?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  hide(): void { conceal(this.root); }

  /** Why practice can't see hands yet (null once the camera is running). */
  setCamera(problem: string | null): void {
    this.camera = problem;
    if (!this.root.hidden && !this.framed) this.say(this.idle());
  }

  /** One frame from the gesture engine. Only the open page of a known spell listens. */
  listen(out: EngineOutput): void {
    if (this.root.hidden || !this.book.isKnown(this.selected.id)) return;
    const g = this.book.gestureFor(this.selected.id);
    if (!g) return;
    this.framed = true;
    const now = performance.now();
    this.draw(out, g, now);

    const progress = Math.max(0, ...[out.hold, out.bow, ...out.hands.map((h) => h.hold)].filter((h) => h?.gestureId === g.id).map((h) => h!.progress));
    this.meter.style.setProperty('--p', progress.toFixed(3));

    for (const f of out.fired) {
      if (f.gestureId === g.id) this.cast(now);
      else {
        const other = this.book.gestures.find((x) => x.id === f.gestureId), spell = this.book.spellFor(f.gestureId);
        if (other && spell) this.notice = { text: `That was ${other.glyph} ${other.name}, which casts ${spell.name}.`, until: now + NOTICE_MS };
      }
    }
    if (this.notice && now > this.notice.until) this.notice = null;
    const hands = out.hands.filter((h) => h.landmarks).length, two = isDualGesture(g);
    this.say(this.notice?.text
      ?? (!hands ? (two ? 'Raise both hands where the camera can see them.' : 'Raise a hand where the camera can see it.')
        : two && hands < 2 ? 'This one takes both hands.'
          : progress > 0 ? 'Hold it…'
            : `Now: ${g.hint.charAt(0).toLowerCase()}${g.hint.slice(1)}`));
  }

  private cast(now: number): void {
    this.book.practise(this.selected.id);
    this.ui('ready');
    const n = this.book.practised(this.selected.id);
    this.notice = { text: n >= CAST_CAP ? 'Cast! You know this one by heart.' : 'Cast! Again.', until: now + NOTICE_MS };
    this.renderTally();
    this.frame.classList.remove('is-cast');
    void this.frame.offsetWidth; // restart the CSS animation
    this.frame.classList.add('is-cast');
  }

  private say(text: string): void { if (this.status.textContent !== text) this.status.textContent = text; }

  private idle(): string { return this.camera ?? 'Raise a hand where the camera can see it.'; }

  /**
   * The caster's hands as a skeleton in the spell's colour. A held sign is framed close, so its
   * shape can be compared with the drawing; a movement shows the whole camera, with a fading trail.
   */
  private draw(out: EngineOutput, g: GestureDef, now: number): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const aspect = out.aspect || 4 / 3, whole: View = { x: aspect / 2, y: 0.5, span: Math.max(1, aspect * 0.75) };
    const moving = g.kind === 'swipe' || g.kind === 'circle' || g.kind === 'dual-motion' || g.kind === 'bow';
    const points = out.hands.flatMap((h) => h.landmarks ?? []);
    let target = whole;
    if (!moving && points.length) {
      const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      target = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, span: Math.min(whole.span, Math.max(0.3, (y1 - y0) * 1.5, (x1 - x0) * 1.5 * 0.75)) };
    }
    const v = this.view ??= target;
    v.x += (target.x - v.x) * FOLLOW; v.y += (target.y - v.y) * FOLLOW; v.span += (target.span - v.span) * FOLLOW;
    const px = (p: { x: number; y: number }) => [(p.x - v.x) / (v.span * 4 / 3) * W + W / 2, (p.y - v.y) / v.span * H + H / 2] as const;
    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const color = this.selected.color;

    // The fingertip (sigils) or palm (sweeps) leaves a fading trail for movements.
    for (const side of ['left', 'right']) {
      const lm = out.hands.find((h) => h.side === side)?.landmarks;
      const trail = (this.trails.get(side) ?? []).filter((p) => now - p.t < TRAIL_MS);
      if (lm && moving) trail.push({ ...lm[g.kind === 'circle' ? 8 : 9], t: now });
      this.trails.set(side, trail);
      ctx.strokeStyle = color;
      for (let i = 1; i < trail.length; i++) {
        const [x0, y0] = px(trail[i - 1]), [x1, y1] = px(trail[i]);
        ctx.globalAlpha = (1 - (now - trail[i].t) / TRAIL_MS) * 0.8;
        ctx.lineWidth = 3 + 6 * (i / trail.length);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    for (const hand of out.hands) {
      if (!hand.landmarks) continue;
      const lm = hand.landmarks;
      ctx.strokeStyle = color;
      ctx.lineWidth = 4;
      ctx.beginPath();
      for (const [a, b] of HAND_CONNECTIONS) {
        const [x1, y1] = px(lm[a]), [x2, y2] = px(lm[b]);
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
      }
      ctx.stroke();
      ctx.fillStyle = '#f2ead8';
      for (const p of lm) { const [x, y] = px(p); ctx.beginPath(); ctx.arc(x, y, 3.6, 0, Math.PI * 2); ctx.fill(); }
    }
  }

  /** Arrow keys walk the index; the page follows focus. */
  private step(e: KeyboardEvent): void {
    const order = SPELLS.map((s) => s.id), i = order.indexOf(this.selected.id);
    const next = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? i - 1
      : e.key === 'Home' ? 0 : e.key === 'End' ? order.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    this.select(SPELLS[Math.max(0, Math.min(order.length - 1, next))]);
    this.entries.get(this.selected.id)?.focus();
  }

  private select(spell: SpellDef): void {
    if (spell === this.selected) return;
    this.ui('hover');
    this.selected = spell;
    this.notice = null;
    this.trails.clear();
    this.view = null;
    this.canvas.getContext('2d')?.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.render();
  }

  private render(): void {
    const known = SPELLS.filter((s) => this.book.isKnown(s.id)).length;
    this.count.textContent = `${known} of ${SPELLS.length} known`;
    this.renderIndex();
    this.renderPage();
  }

  private renderIndex(): void {
    const focused = this.index.contains(document.activeElement);
    this.entries.clear();
    this.index.replaceChildren(...groups.map(({ label, spells }) => el('section', { class: 'index-group' },
      el('h3', {}, label),
      el('ul', {}, ...spells.map((spell) => {
        const known = this.book.isKnown(spell.id), current = spell === this.selected;
        const b = el('button', {
          class: `index-entry${known ? '' : ' is-sealed'}`, type: 'button', tabindex: current ? 0 : -1, 'aria-label': known ? spell.name : `${spell.name}, sealed`,
          'aria-current': current ? 'true' : false, 'aria-controls': 'grimoire-page',
          onclick: () => this.select(spell),
        },
        el('span', { class: 'index-icon' }, createSpellIcon(spell.id)),
        el('span', { class: 'index-name' }, spell.name),
        el('span', { class: 'index-mark' }, known ? this.book.gestureFor(spell.id)?.glyph ?? '' : `Lv ${spell.learnedAt}`));
        b.style.setProperty('--spell', spell.color);
        this.entries.set(spell.id, b);
        return el('li', {}, b);
      })))));
    if (focused) this.entries.get(this.selected.id)?.focus({ preventScroll: true });
  }

  private renderPage(): void {
    const spell = this.selected, known = this.book.isKnown(spell.id), legend = spell.tier === 'legend';
    const g = this.book.gestureFor(spell.id);
    this.page.className = `grimoire-page${known ? '' : ' is-sealed'}`;
    this.page.style.setProperty('--spell', spell.color);
    this.page.scrollTop = 0;
    const title = el('h3', { id: 'grimoire-page-title' }, spell.name);
    if (!known || !g) {
      this.page.replaceChildren(
        el('header', { class: 'page-head' }, el('div', {}, el('p', { class: 'g-eyebrow' }, 'Sealed · Legendary'), title)),
        el('div', { class: 'page-seal' },
          el('div', { class: 'seal-sigil' }, createSpellIcon(spell.id)),
          el('p', {}, `Defeat the ruler of level ${spell.learnedAt} to learn it.`),
          el('p', { class: 'seal-sub' }, 'Its movement is written here once it is yours.')));
      return;
    }

    this.renderTally();
    this.status.textContent = this.idle();
    this.meter.hidden = !(g.kind === 'pose' || g.kind === 'dual-pose' || g.kind === 'dual-shape' || g.kind === 'bow');
    this.meter.style.setProperty('--p', '0');

    this.page.replaceChildren(
      el('header', { class: 'page-head' },
        el('div', { class: 'page-icon' }, createSpellIcon(spell.id)),
        el('div', {},
          el('p', { class: 'g-eyebrow' }, legend ? `Legendary · taken at level ${spell.learnedAt}` : 'Known from the first night'),
          title,
          el('p', { class: 'page-lore' }, `“${spell.lore}”`))),
      el('section', { class: 'page-section', 'aria-labelledby': 'page-does-title' },
        el('h4', { id: 'page-does-title' }, 'What it does'),
        el('p', { class: 'page-effect' }, spell.effectText),
        el('ul', { class: 'page-facts' },
          el('li', {}, `Returns in ${spell.cooldown}s`),
          el('li', {}, isDualGesture(g) ? 'Both hands' : 'One hand'))),
      el('section', { class: 'page-section', 'aria-labelledby': 'page-move-title' },
        el('h4', { id: 'page-move-title' }, 'The movement'),
        el('p', { class: 'page-gesture' }, `${g.glyph} ${g.name}`, el('span', {}, GESTURE_GROUPS[g.group])),
        el('p', { class: 'page-hint' }, g.hint),
        el('div', { class: 'page-stage' },
          el('figure', { class: 'page-diagram' }, el('figcaption', {}, 'How'), createGestureDiagram(g)),
          el('figure', { class: 'page-you' }, el('figcaption', {}, 'Your hands'), this.frame),
          el('div', { class: 'page-practice' }, el('p', { class: 'page-practice-title' }, 'Practise'), this.status, this.tally))),
    );
  }

  private renderTally(): void {
    const n = Math.min(CAST_CAP, this.book.practised(this.selected.id));
    this.tally.replaceChildren(el('span', { class: 'tally-marks', 'aria-hidden': 'true' }, ...Array.from({ length: CAST_CAP }, (_, i) => el('i', { class: i < n ? 'is-done' : '' }))),
      n >= CAST_CAP ? 'Known by heart' : `Practised ${n} of ${CAST_CAP}`);
  }
}
