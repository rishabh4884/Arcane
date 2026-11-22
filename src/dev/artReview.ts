import * as THREE from 'three';
import { SPELLS } from '../config/spells.ts';
import { Shot } from '../cutscene/Cutscene.ts';
import { SCRIPTS } from '../cutscene/scripts.ts';
import { createSpellAnimation, type SpellAnimation } from '../world/effects.ts';
import { lightAt } from '../world/paintedShots.ts';
import { terrainHeight } from '../world/spatial.ts';
import type { World } from '../world/World.ts';
import { DESIGNS } from '../world/characters/index.ts';
import { lanternFlower } from '../cutscene/cast.ts';
import { createCreatureProjectile, animateCreatureProjectile, type ProjectileStyle } from '../world/fx/creatureProjectiles.ts';
import { CREATURE_SPECS, type CreatureKind } from '../world/EncounterState.ts';

/** Development-only camera and effect frame desk. No webcam or saved progress is involved.
 * /?review&scene=ending&t=35, or /?review&effect=frost&t=0.6
 * Background mode deliberately leaves the actors out so projection defects remain visible.
 */
export async function artReview(world: World): Promise<void> {
  document.querySelectorAll<HTMLElement>('.g-screen').forEach((screen) => { screen.hidden = true; });
  document.body.className = 'is-cutscene';
  const stage = world.beginCinematic();
  let shot = new Shot(stage);
  let effect: SpellAnimation | null = null;
  let flower: ReturnType<typeof lanternFlower> | null = null;
  let projectile: THREE.Group | null = null;
  let simulated = 0;
  let playing = false;
  let request = 0;
  let mode = '';
  const params = new URLSearchParams(location.search);

  const panel = document.createElement('form');
  panel.setAttribute('aria-label', 'Art review');
  panel.style.cssText = 'position:fixed;inset:auto 12px 12px;z-index:1000;display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:12px 16px;background:#102021;color:#e5e9db;border:1px solid #677e75;font:14px/1.5 system-ui;';
  panel.addEventListener('submit', (event) => event.preventDefault());
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Review subject');
  const sets = document.createElement('optgroup'); sets.label = 'Painted backgrounds';
  for (const script of Object.values(SCRIPTS)) sets.append(new Option(script.id, `scene:${script.id}`));
  const spells = document.createElement('optgroup'); spells.label = 'Spell drawings';
  for (const spell of SPELLS) spells.append(new Option(spell.name, `effect:${spell.effect}`));
  const scenes = document.createElement('optgroup'); scenes.label = 'Complete cutscenes';
  for (const script of Object.values(SCRIPTS)) scenes.append(new Option(script.id, `full:${script.id}`));
  const figures = document.createElement('optgroup'); figures.label = 'Characters in the wood';
  for (const [key, design] of Object.entries(DESIGNS)) figures.append(new Option(design.name, `figure:${key}`));
  const props = document.createElement('optgroup'); props.label = 'Living props and attacks';
  props.append(new Option('Lantern-flower', 'prop:flower'));
  for (const style of ['ember','bile','boulder','lantern','moth','pale','cold','star','wisp']) props.append(new Option(`${style} attack`, `projectile:${style}`));
  select.append(sets, scenes, figures, props, spells);
  const time = document.createElement('input');
  time.type = 'range'; time.min = '0'; time.step = '0.01';
  time.setAttribute('aria-label', 'Frame time');
  time.style.cssText = 'flex:1;min-width:120px;accent-color:#d9c589';
  const label = document.createElement('output');
  label.style.cssText = 'font-variant-numeric:tabular-nums;min-width:70px';
  const status = document.createElement('span');
  status.setAttribute('role', 'status');
  const hide = document.createElement('button'); hide.type = 'button'; hide.textContent = 'Hide controls';
  hide.addEventListener('click', () => { panel.hidden = true; panel.style.display = 'none'; });
  document.addEventListener('keydown', (event) => {
    if (event.key.toLowerCase() === 'h' && !['INPUT', 'SELECT'].includes((event.target as HTMLElement)?.tagName)) {
      panel.hidden = !panel.hidden; panel.style.display = panel.hidden ? 'none' : 'flex';
    }
  });
  const play = document.createElement('button'); play.type = 'button'; play.textContent = 'Play';
  play.addEventListener('click', () => { playing = !playing; play.textContent = playing ? 'Pause' : 'Play'; });
  const angle = document.createElement('select'); angle.setAttribute('aria-label', 'Figure angle');
  for (const [name,value] of [['Front','0'],['Three-quarter','0.65'],['Side','1.57'],['Back','3.14']]) angle.append(new Option(name,value));
  angle.value = params.get('yaw') ?? '0.65';
  const action = document.createElement('select'); action.setAttribute('aria-label', 'Figure action');
  const cast = document.createElement('button'); cast.type = 'button'; cast.textContent = 'Cast in world';
  cast.addEventListener('click', () => {
    const [kind,id] = select.value.split(':'); if (kind !== 'effect') return;
    playing = false; play.textContent = 'Play'; if (effect) effect.group.visible = false;
    const spell = SPELLS.find((s)=>s.effect===id)!;
    world.previewEffect(spell.effect, new THREE.Vector3(0,terrainHeight(0,5)+1,5),spell.color);
  });
  panel.append(select, angle, action, play, cast, time, label, status, hide);
  document.body.append(panel);

  const clear = () => { effect?.group.removeFromParent(); effect?.dispose(); effect = null; };
  const draw = () => {
    const at = Number(time.value);
    label.value = `${at.toFixed(2)} s`;
    const [kind, id] = select.value.split(':');
    if (kind === 'scene' || kind === 'full') {
      const script = SCRIPTS[id];
      shot.camera_(script.camera, at);
      stage.setMood(lightAt(script, at) as typeof script.mood, 0.01);
      if (kind === 'full') {
        if (at < simulated) { shot.dispose(); shot = new Shot(stage); script.build(shot); simulated = 0; }
        while (simulated < at) {
          const dt = Math.min(1 / 30, at - simulated); simulated += dt; shot.t = simulated;
          script.tick(shot, simulated, dt); shot.update(dt);
        }
      }
    } else if (kind === 'figure') {
      const a = shot.actors.get('review')!;
      const cycle = at % 4;
      a.input.pose = action.value === 'idle' ? 'idle' : cycle < 1.2 ? 'windup' : cycle < 1.8 ? 'strike' : cycle < 2.8 ? 'recover' : 'idle';
      a.input.progress = cycle < 1.2 ? cycle / 1.2 : cycle < 1.8 ? (cycle - 1.2) / 0.6 : cycle < 2.8 ? cycle - 1.8 : 0;
      a.input.attack = action.value;
      a.figure.setYaw(Number(angle.value)); a.input.faceYaw = Number(angle.value);
      // A held pose gets time for the rig springs to settle; Play advances in real time.
      const steps = playing ? 1 : 30;
      for (let i=0;i<steps;i++) shot.update(1 / 60);
      simulated = at;
    } else if (kind === 'prop') {
      flower?.set(Math.min(1, at / 3), Math.min(1, at / 3), at);
    } else if (kind === 'projectile') {
      projectile!.quaternion.copy(stage.camera.quaternion);
      animateCreatureProjectile(projectile!, id as ProjectileStyle, at);
    } else {
      clear();
      const spell = SPELLS.find((s) => s.effect === id)!;
      const ground = terrainHeight(0, 5);
      const target = new THREE.Vector3(0, ground + 1, 5);
      effect = createSpellAnimation(spell.effect, new THREE.Vector3(0.5, stage.camera.position.y - 0.4, 16), target, new THREE.Color(spell.color), undefined, {
        groundY: ground, cameraQuaternion: stage.camera.quaternion, cameraPosition: stage.camera.position,
        depth: 12, hand: 'right', fov: stage.camera.fov,
      });
      stage.scene.add(effect.group);
      // Fixed steps preserve the same stage transitions as play, then hold the requested drawing.
      let elapsed = 0;
      while (elapsed < at) { const dt = Math.min(1 / 60, at - elapsed); effect.update(dt); elapsed += dt; }
      if (at === 0) effect.update(0);
    }
  };
  const choose = async (initial = false) => {
    const ticket = ++request;
    clear(); shot.dispose(); shot = new Shot(stage); flower = null; projectile = null; simulated = 0;
    world.releasePaintedShots();
    const [kind, id] = select.value.split(':');
    mode = select.value;
    angle.hidden = action.hidden = kind !== 'figure'; cast.hidden = kind !== 'effect';
    status.textContent = 'Loading paintings…'; time.disabled = true;
    if (kind === 'scene' || kind === 'full') {
      const script = SCRIPTS[id];
      world.setRegion(script.region ?? 'edge');
      time.max = String(script.duration);
      await world.preparePaintedShots(id);
      if (ticket !== request) return;
      if (kind === 'full') script.build(shot);
    } else {
      world.setRegion('edge'); stage.setMood('edge', 0.01);
      stage.camera.position.set(0, terrainHeight(0, 17) + 1.85, 17);
      stage.camera.lookAt(0, 1.2, -12); stage.camera.fov = 64;
      stage.camera.updateProjectionMatrix(); stage.camera.updateMatrixWorld(true);
      time.max = '6';
      if (kind === 'figure') {
        const design = DESIGNS[id as keyof typeof DESIGNS];
        const figure = shot.actor('review', design, 0, 5, Number(params.get('yaw') ?? 0.65), 0, 0.37);
        action.replaceChildren(new Option('Idle','idle'));
        for (const attack of CREATURE_SPECS[id as CreatureKind].attacks) action.append(new Option(attack.id,attack.id));
        action.value = params.get('attack') ?? 'idle';
        const ground = figure.group.position.y, distance = Math.max(3, design.height * 2.25);
        stage.camera.position.set(0, ground + design.height * 0.6, 5 + distance);
        stage.camera.lookAt(0, ground + design.height * 0.48, 5); stage.camera.fov = 42;
        time.max = '12';
      } else if (kind === 'prop' || kind === 'projectile') {
        const ground = terrainHeight(0, 5);
        if (kind === 'prop') { flower = lanternFlower(1); flower.group.position.set(0, ground, 5); shot.add(flower.group); }
        else { projectile = createCreatureProjectile(id as ProjectileStyle, new THREE.Color('#adc5bb')); projectile.position.set(0, ground + 0.5, 5); shot.add(projectile); }
        stage.camera.position.set(0, ground + 0.85, 8.2); stage.camera.lookAt(0, ground + 0.6, 5); stage.camera.fov = 36;
      }
      stage.camera.updateProjectionMatrix(); stage.camera.updateMatrixWorld(true);
    }
    if (ticket !== request) return;
    time.value = initial ? params.get('t') ?? '0.6' : '0.6';
    time.disabled = false;
    status.textContent = `${kind === 'scene' ? 'Background only' : 'Animation review'} · H hides controls`;
    draw();
  };
  select.addEventListener('change', () => { void choose(); });
  angle.addEventListener('change', draw); action.addEventListener('change', draw);
  time.addEventListener('input', () => { if (select.value === mode) draw(); });
  const requested = params.has('effect') ? `effect:${params.get('effect')}` : params.has('figure') ? `figure:${params.get('figure')}` : params.has('prop') ? `prop:${params.get('prop')}` : params.has('projectile') ? `projectile:${params.get('projectile')}` : `${params.has('full') ? 'full' : 'scene'}:${params.get('scene') ?? 'intro'}`;
  if (Array.from(select.options).some((option) => option.value === requested)) select.value = requested;
  await choose(true);
  let last = performance.now();
  const animate = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.05); last = now;
    if (playing && !time.disabled) {
      const at = Number(time.value) + dt;
      time.value = String(at > Number(time.max) ? 0 : at); draw();
    }
    requestAnimationFrame(animate);
  };
  requestAnimationFrame(animate);
}
