import * as THREE from 'three';
import { FENWYRM, GORRIK, GRAEL, HOLLOW_STAG, PALE_HERALD, UNLIT_KING, WIDOW, EGG } from '../world/characters/bosses.ts';
import { bump, smooth, TAU } from '../world/rig/Rig.ts';
import { terrainHeight } from '../world/spatial.ts';
import { Trail } from '../world/vfx.ts';
import { KINDLER_HANDS, lanternFlower, WARDEN } from './cast.ts';
import type { Script, Shot, V3 } from './Cutscene.ts';

const G = (x: number, y: number, z: number): V3 => [x, terrainHeight(x, z) + y, z];
const v = (p: V3) => new THREE.Vector3(...p);

function stageHands(s: Shot): void {
  const hands = s.actor('hands', KINDLER_HANDS, 0, 0, Math.PI, 0, 0.4);
  s.camera.add(hands.group);
  hands.group.position.set(0, 0, 0);
  hands.group.rotation.set(0, Math.PI, 0);
  s.onDispose(() => hands.group.removeFromParent());
}

const palm = (s: Shot) => s.get('hands').bones.handR.localToWorld(new THREE.Vector3(0, 0.013, -0.026));
const luminance = new THREE.Color('#ffd684');

const widowGift: Script = {
  id: 'widow-gift', region: 'loom', mood: 'deeps', duration: 18,
  camera: [
    { t: 0, p: G(1.65, 1.07, -3.2), l: G(0, 1.2, -8.7), fov: 58 },
    { t: 8, p: G(1.4, 0.91, -4.2), l: G(0, 1.15, -8.4), fov: 54 },
    { t: 18, p: G(1.4, 0.91, -4.2), l: G(0, 0.96, -8.4), fov: 54 },
  ],
  lines: [
    { at: 1.2, until: 5.2, speaker: 'The Lantern Widow', kind: 'whisper', text: 'Under the longest root. Cup your hands before you touch them. They startle so easily.' },
    { at: 5.5, until: 9.8, speaker: 'The Lantern Widow', kind: 'whisper', text: 'Once they hear rain, they’ll think I’m coming. Please take them somewhere dry before it starts again.' },
    { at: 10.2, until: 15.9, speaker: 'The Lantern Widow', kind: 'whisper', text: 'I swallowed every cry so I wouldn’t wake them. There’s no room left in me now. Take it. You don’t have to keep it quiet.' },
  ],
  build(s) {
    s.actor('widow', WIDOW, 0, -9, 0, 0, 0.5);
    s.actor('brood-a', EGG, -2, -8, 0, 0, 0.4);
    s.actor('brood-b', EGG, -2.7, -8.3, 0, 0, 0.8);
    stageHands(s);
    const drops = Array.from({ length: 13 }, (_, i) => {
      const bead = new THREE.Mesh(new THREE.SphereGeometry(0.013 + (i % 3) * 0.004, 12, 8),
        new THREE.MeshStandardMaterial({ color: '#5c1527', emissive: '#a92141', emissiveIntensity: 0.6, roughness: 0.28 }));
      const ribbon = new Trail(i % 3 ? '#8e1228' : '#ed4755', 0.028, 0.34, 24, 0.4);
      s.trails.push(ribbon);
      s.root.add(ribbon.mesh, bead);
      return { bead, ribbon };
    });
    s.onDispose(() => drops.forEach(({ ribbon }) => ribbon.mesh.removeFromParent()));
    widowDrops.set(s, drops);
  },
  tick(s, t) {
    s.act('widow', 'dead', 0.46 + 0.45 * smooth(0, 4, t));
    s.get('widow').overrides.dissolve = 0.08 + 0.12 * smooth(14, 18, t);
    const lookToBrood = bump(1.4, 8.6, t), surrender = smooth(10.2, 14.8, t);
    s.actors.get('widow')!.input.extra = (a) => {
      a.rig.pos('hips', 0, -0.62, 0).rot('abd', 0.15).rot('spine', 0.26, 0, -0.13)
        .rot('head', -0.21 * lookToBrood, -0.43 * lookToBrood, -0.11 * surrender)
        .rotPair('fang', Math.sin(t * 19) * 0.08 * (lookToBrood + bump(10.3, 15.7, t)));
      for (let leg = 1; leg <= 4; leg++) a.rig.rotPair(`leg${leg}`, 0.18, 0.2 - leg * 0.07, 0.12)
        .rotPair(`knee${leg}`, -0.24 - leg * 0.045, 0, 0.27);
    };
    s.act('hands', 'strike', smooth(8.5, 11, t));
    s.actors.get('hands')!.input.extra = (a) => a.rig.rotPair('wrist', -0.16 * lookToBrood, 0.21 * surrender)
      .rot('wristR', Math.sin(t * 24) * 0.13 * bump(12.8, 16.3, t));
    const from = s.at(0, -7.5, 0.58), to = palm(s);
    widowDrops.get(s)?.forEach(({ bead, ribbon }, i) => {
      const start = 11.4 + i * 0.14;
      const end = 14.6 + i * 0.11;
      const k = smooth(start, end, t);
      const splay = Math.sin(Math.PI * k);
      const shiver = Math.sin(Math.floor(t * 36) + i * 0.9) * splay;
      const at = from.clone().lerp(to, k).add(new THREE.Vector3(shiver * 0.075, splay * 0.47 + Math.sin(t * 21 + i) * splay * 0.07, shiver * 0.07));
      bead.position.copy(at);
      bead.scale.set(1 - 0.49 * k, 1.5 + Math.abs(shiver) * 1.4, 1 - 0.49 * k);
      bead.visible = t > start && t < end;
      ribbon.opacity = bead.visible ? 0.72 * (1 - smooth(0.8, 1, k)) : 0;
      if (bead.visible) ribbon.push(at);
    });
    s.stage.illuminate(0, to, new THREE.Color('#ee3e67'), bump(13, 17, t) * 2, 4);
  },
};
const widowDrops = new WeakMap<Shot, Array<{ bead: THREE.Mesh; ribbon: Trail }>>();

const graelGift: Script = {
  id: 'grael-gift', region: 'heartwood', mood: 'fen', duration: 17,
  camera: [
    { t: 0, p: G(3, 2.1, -1), l: G(0, 2.9, -11), fov: 58 },
    { t: 6.5, p: G(1.8, 1.55, -1.7), l: G(0, 1.03, -10), fov: 55 },
    { t: 17, p: G(1.8, 1.55, -1.7), l: G(0, 1.03, -10), fov: 55 },
  ],
  lines: [
    { at: 1.8, until: 6.6, text: 'The ground moves under his hand. In the little hollow where his fingers rested, a green shoot pushes through.', kind: 'caption' },
    { at: 13, until: 16.8, text: 'You wait for the petals to wilt. They go soft as wax instead, and the warmth stays under your skin.', kind: 'caption' },
  ],
  build(s) {
    s.actor('grael', GRAEL, 0, -11, 0, 0, 0.4);
    stageHands(s);
    const garden = Array.from({ length: 25 }, (_, i) => {
      const flower = lanternFlower(i === 0 ? 0.37 : 0.3 + (i % 5) * 0.14);
      const r = 1 + i / 6;
      flower.group.position.copy(s.at(Math.sin(i * 2.4) * r, -9.5 + Math.cos(i * 2.4) * r));
      s.add(flower.group);
      return flower;
    });
    blooms.set(s, { garden, from: garden[0].group.position.clone(), honey: s.lumen('#ffca68', 0.095) });
  },
  tick(s, t) {
    const { garden, from, honey } = blooms.get(s)!;
    s.act('grael', 'dead', 0.28 + smooth(0, 5, t) * 0.62);
    s.get('grael').overrides.dissolve = smooth(9, 17, t) * 0.82;
    s.act('hands', 'strike', smooth(7, 11, t));
    const to = palm(s), take = smooth(7, 12.2, t), melt = smooth(12.2, 14.3, t);
    garden.forEach((flower, i) => {
      const open = smooth(1 + i * 0.15, 3.4 + i * 0.15, t);
      flower.set(open, open * (1 - smooth(13, 17, t)) * 0.8, t);
    });
    const blossom = garden[0].group;
    const size = 1 - 0.78 * smooth(7.5, 12.1, t);
    blossom.position.copy(from).lerp(to, take).y += 1.25 * Math.sin(take * Math.PI) - 0.2 * take * size;
    blossom.rotation.z = -0.36 * Math.sin(take * Math.PI) - melt * 0.72;
    blossom.scale.set(size * (1 + melt * 0.5) * (1 - melt), Math.max(0.001, size * (1 - melt) ** 2), size * (1 - melt));
    honey.place(to);
    honey.sprite.material.opacity = bump(12, 16, t);
    s.stage.illuminate(0, garden[0].group.position, luminance, bump(2, 16.8, t) * 2.1, 7);
  },
};
const blooms = new WeakMap<Shot, { garden: Array<ReturnType<typeof lanternFlower>>; from: THREE.Vector3; honey: ReturnType<Shot['lumen']> }>();

const stagFall: Script = {
  id: 'stag-fall', region: 'antlerhall', mood: 'deeps', duration: 14,
  camera: [
    { t: 0, p: G(4.1, 1.1, -3), l: G(0, 1.1, -9), fov: 57 },
    { t: 9, p: G(3.2, 1.7, -4), l: G(0, 3.3, -9), fov: 55 },
    { t: 14, p: G(2.3, 1.9, -3), l: G(-3.5, 2.4, -14), fov: 58 },
  ],
  lines: [
    { at: 4.4, until: 8.6, speaker: 'The Hollow Stag', kind: 'whisper', text: 'Thank you. I’d forgotten what it was to stand without carrying the weight of those bones.' },
    { at: 8.9, until: 13.8, speaker: 'The Hollow Stag', kind: 'whisper', text: 'The path goes on past the ridge. When you need me, call. I can take it at a run now.' },
  ],
  build(s) {
    s.actor('body', HOLLOW_STAG, 0, -9, 0.44, 0, 0.6);
    s.actor('spirit', HOLLOW_STAG, 0, -9, 0.44, 0, 0.6);
  },
  tick(s, t) {
    s.act('body', 'dead', 0.64 + smooth(0, 4, t) * 0.31);
    const body = s.get('body');
    body.lift.rotation.z = 1.29;
    body.overrides.dissolve = smooth(5.5, 11, t);
    const spirit = s.get('spirit');
    spirit.overrides.dissolve = 1 - smooth(1.5, 5, t) * (1 - smooth(11.5, 14, t));
    spirit.overrides.flash = 0.74;
    spirit.u.uFlashColor.value.set('#c0e8ff');
    s.hover('spirit', 0.55 * bump(2, 9, t));
    s.act('spirit', 'idle');
    const bow = bump(4.5, 8.9, t);
    s.actors.get('spirit')!.input.extra = (a) => a.rig.rot('neck', 0.29 * bow).rot('head', 0.21 * bow);
    s.travel('spirit', [0, -9], [-7, -19], 10.2, 14);
  },
};

const fenwyrmFall: Script = {
  id: 'fenwyrm-fall', region: 'coils', mood: 'fen', duration: 15,
  camera: [
    { t: 0, p: G(3.6, 1.55, -1), l: G(0, 0.8, -8), fov: 58 },
    { t: 8, p: G(1.8, 1.4, -3), l: G(0, 1.1, -8), fov: 52 },
    { t: 15, p: G(1.8, 1.4, -3), l: G(0, 1.1, -8), fov: 52 },
  ],
  lines: [
    { at: 2, until: 7, speaker: 'The Fenwyrm', kind: 'whisper', text: 'Wait. I can taste the salt again. Get out of the riverbed, little thing. I’ve got a long way to swim.' },
    { at: 9.5, until: 14.4, text: 'It throws itself against the current. You open your hand to let it pass, but the river has already found a new bed.', kind: 'caption' },
  ],
  build(s) {
    s.actor('fenwyrm', FENWYRM, 0, -8, 0.7, 0, 0.5);
    const spirit = s.actor('water', FENWYRM, 0, -8, 0.7, 0, 0.5);
    spirit.overrides.flash = 0.88;
    spirit.u.uFlashColor.value.set('#8fe9ff');
    stageHands(s);
    lumens.set(s, [s.lumen('#78e7ff', 0.44)]);
  },
  tick(s, t) {
    s.act('fenwyrm', 'dead', 0.44 + smooth(0, 7, t) * 0.55);
    s.act('hands', 'windup', smooth(9, 11.5, t));
    const leave = smooth(2, 8, t), bind = smooth(8, 12.5, t);
    const spirit = s.get('water');
    spirit.overrides.dissolve = 1 - smooth(1.4, 4.5, t) * (1 - smooth(11, 12.5, t));
    s.act('water', 'walk');
    s.actors.get('water')!.input.velocity.set(2, 0, -1);
    s.face('water', 1.9 - bind * 1.5);
    const stream = s.at(-4 * leave, -8 - 3 * leave, 3 * leave).lerp(palm(s), bind);
    spirit.group.position.copy(stream);
    spirit.group.scale.setScalar(1 - bind * 0.96);
    const current = lumens.get(s)![0];
    current.place(stream);
    current.sprite.material.opacity = bump(3, 13.6, t);
    current.trail.opacity = current.sprite.material.opacity;
    s.stage.illuminate(0, stream, new THREE.Color('#62d7ff'), bump(5, 14, t) * 2, 6);
  },
};

const gorrikFall: Script = {
  id: 'gorrik-fall', region: 'edge', mood: 'edge', duration: 12,
  camera: [
    { t: 0, p: G(2.3, 1.6, -3.9), l: G(0, 1.5, -8), fov: 53 },
    { t: 12, p: G(1.4, 1.15, -4.8), l: G(0, 0.8, -8), fov: 50 },
  ],
  lines: [
    { at: 1.8, until: 6.9, speaker: 'Gorrik', kind: 'whisper', text: 'Tell the little ones there’s flour under the stall with the blue cloth. I hid it there. I was saving it till tomorrow.' },
    { at: 7.9, until: 11.8, text: 'His hand drops. The ground takes the weight of it, then sends it up through the soles of your feet.', kind: 'caption' },
  ],
  build(s) {
    s.actor('gorrik', GORRIK, 0, -8, 0.7, 0, 0.5);
    stageHands(s);
    lumens.set(s, Array.from({ length: 9 }, () => s.lumen('#efaa5e', 0.16)));
  },
  tick(s, t) {
    s.act('gorrik', 'dead', 0.3 + smooth(0, 6, t) * 0.64);
    s.act('hands', 'strike', smooth(6, 9, t));
    for (const [i, light] of lumens.get(s)!.entries()) {
      const a = i * TAU / 9, n = smooth(2, 6, t) * 3;
      const spot = s.at(Math.cos(a) * n, -7.3 + Math.sin(a) * n, 0.05);
      light.place(spot.lerp(palm(s), smooth(6 + i * 0.1, 9.5 + i * 0.1, t)));
      light.sprite.material.opacity = bump(2, 10.3, t);
      light.trail.opacity = light.sprite.material.opacity;
    }
  },
};

const lumens = new WeakMap<Shot, Array<ReturnType<Shot['lumen']>>>();

const heraldMemory: Script = {
  id: 'herald-memory', region: 'bellfields', mood: 'throne', memory: true, duration: 17,
  camera: [
    { t: 0, p: G(-6, 2.3, 3), l: G(-5, 2.5, -10), fov: 51 },
    { t: 6.6, p: G(3, 3, 1), l: G(0, 4, -10), fov: 51 },
    { t: 7, p: G(4, 8.2, -2), l: G(0, 8.1, -10), fov: 47 },
    { t: 17, p: G(2.6, 8.6, -4), l: G(0, 11.5, -16), fov: 55 },
  ],
  sounds: [{ at: 2.5, kind: 'bell' }, { at: 5.4, kind: 'bell' }],
  lines: [
    { at: 7.7, until: 11.9, speaker: 'The Pale Herald', text: 'My sister used to point out that crooked row of stars. I keep thinking she might be looking at it tonight.' },
    { at: 12, until: 16.8, speaker: 'The Pale Herald', text: 'I climbed higher this time. I thought I’d see the road from here. Good God, I’m tired of walking.' },
  ],
  build(s) {
    s.actor('herald', PALE_HERALD, -8, -10, 1.3, 0, 0.5).group.scale.setScalar(0.75);
    const bark = new THREE.MeshStandardMaterial({ color: '#434342', roughness: 0.95 });
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.85, 9, 10), bark);
    trunk.position.copy(s.at(0.8, -10.9, 4.35));
    const branch = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.39, 3.7, 9), bark);
    branch.position.copy(s.at(-0.7, -10.8, 6.8));
    branch.rotation.z = Math.PI * 0.43;
    s.add(trunk); s.add(branch);
    const stars = Array.from({ length: 24 }, (_, i) => s.lumen('#cfddf1', 0.08 + (i % 3) * 0.025));
    stars.forEach((star, i) => { star.place(s.at((i % 9 - 4) * 4, -32 - i % 5 * 6, 13 + i % 7 * 2)); star.trail.opacity = 0; });
    lumens.set(s, stars);
  },
  tick(s, t) {
    const ring = bump(1.4, 3.3, t) + bump(4.4, 6.3, t);
    s.act('herald', t < 6.8 && ring > 0.05 ? 'strike' : 'idle', ring, 'toll');
    if (t < 6.8) s.travel('herald', [-8, -10], [0, -10], 0, 6.8);
    else {
      s.get('herald').group.position.copy(s.at(-0.6, -10, 6.55));
      s.face('herald', 2.6);
      s.look('herald', s.at(-2, -28, 16));
      s.actors.get('herald')!.input.extra = (a) => a.rig.pos('hips', 0, -0.54, 0).rot('tail1', -0.85).rot('tail2', 0.65).rot('head', -0.21);
    }
    lumens.get(s)!.forEach(({ sprite }, i) => { sprite.material.opacity = smooth(6.8, 7.5, t) * (0.64 + 0.26 * Math.sin(t * 1.5 + i)); });
  },
};

const heraldFall: Script = {
  id: 'herald-fall', region: 'bellfields', mood: 'throne', duration: 15,
  camera: [
    { t: 0, p: G(2.5, 0.85, -3.8), l: G(0, 0.45, -8), fov: 56 },
    { t: 9, p: G(2, 1.28, -3.9), l: G(-0.5, 1.94, -8.2), fov: 56 },
    { t: 15, p: G(2, 0.95, -4.7), l: G(-0.6, 0.65, -8), fov: 53 },
  ],
  sounds: [{ at: 8.25, kind: 'bell' }],
  lines: [
    { at: 10, until: 14.7, text: 'He lets the cord go before the note is finished. It hangs in the clearing until you reach up and take it in both hands.', kind: 'caption' },
  ],
  build(s) {
    s.actor('herald', PALE_HERALD, 0.2, -8, -0.37, 0, 0.6).group.scale.setScalar(0.77);
    const staff = new THREE.Group();
    staff.position.copy(s.at(-1.05, -8.2));
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 2.8, 9), new THREE.MeshStandardMaterial({ color: '#544030' }));
    shaft.position.y = 1.4;
    const bell = new THREE.Mesh(new THREE.LatheGeometry([
      new THREE.Vector2(0.015, 0.25), new THREE.Vector2(0.11, 0.19), new THREE.Vector2(0.14, 0.08), new THREE.Vector2(0.2, 0), new THREE.Vector2(0.16, 0.02),
    ], 24), new THREE.MeshStandardMaterial({ color: '#b09455', roughness: 0.55, side: THREE.DoubleSide }));
    const mount = new THREE.Group();
    mount.position.set(0.17, 2.72, 0);
    bell.position.y = -0.25;
    const string = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 1, 6), new THREE.MeshStandardMaterial({ color: '#b4a387' }));
    string.position.y = -0.76;
    mount.add(string, bell);
    staff.add(shaft, mount);
    s.add(staff);
    heraldBell.set(s, { mount, string });
    stageHands(s);
    lumens.set(s, [s.lumen('#c6d5da', 0.33)]);
  },
  tick(s, t) {
    const rise = smooth(2, 7.6, t) * (1 - smooth(8.8, 11, t));
    const grab = smooth(5.2, 8.1, t) * (1 - smooth(8.8, 10, t));
    const figure = s.get('herald');
    figure.lift.rotation.x = -1.43 * (1 - rise);
    s.act('herald', 'idle');
    s.actors.get('herald')!.input.extra = (a) => a.rig.scl('staff', -1)
      .rot('shoulderR', -1.08 * grab, 0.18 * grab, -0.34 * grab)
      .rot('elbowR', 0.41 * grab).rot('head', -0.23 * rise);
    figure.overrides.dissolve = smooth(9.1, 14.4, t);
    const ring = Math.max(0, t - 8.25);
    const { mount, string } = heraldBell.get(s)!;
    mount.rotation.z = ring > 0 ? Math.sin(ring * 12) * Math.exp(-ring * 2) * 0.32 : 0;
    const start = new THREE.Vector3(0, -0.27, 0);
    const end = new THREE.Vector3(0, -1.38, 0);
    const fingers = figure.bones.handR.localToWorld(new THREE.Vector3(0, -0.07, -0.015));
    end.lerp(mount.worldToLocal(fingers), grab);
    string.position.copy(start).lerp(end, 0.5);
    const direction = start.sub(end);
    string.scale.y = Math.max(0.001, direction.length());
    string.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
    s.act('hands', 'strike', smooth(9, 12.2, t));
    const note = lumens.get(s)![0];
    note.place(s.at(-0.88, -8.2, 2.4).lerp(palm(s), smooth(9, 12.4, t)));
    note.sprite.material.opacity = bump(8.25, 13.4, t);
    note.trail.opacity = note.sprite.material.opacity;
    if (t > 9.5 && t < 13.8) s.stage.mist.emit({
      x: 0.7 + Math.sin(t * 59) * 0.7, y: s.ground(0, -8) + 0.4, z: -8,
      vx: 0.9, vy: 0.53, vz: -0.3, color: new THREE.Color('#a6aaa3'), size: 0.18, sizeEnd: 0.7, alpha: 0.25, ttl: 1.4, style: 'mist',
    });
  },
};
const heraldBell = new WeakMap<Shot, { mount: THREE.Group; string: THREE.Mesh }>();

const widowMemory: Script = {
  id: 'widow-memory', region: 'loom', mood: 'deeps', memory: true, duration: 12,
  camera: [{ t: 0, p: G(1.6, 1.15, -2.8), l: G(0, 1.25, -8), fov: 62 }, { t: 12, p: G(0.8, 0.87, -4.8), l: G(0, 0.55, -7.3), fov: 55 }],
  lines: [{ at: 5.2, until: 9.6, text: 'She turns her back to the wind. The smallest egg goes cold anyway.', kind: 'caption' }],
  build(s) {
    s.actor('widow', WIDOW, 1.6, -8.7, -0.51, 0, 0.5);
    s.actor('egg', EGG, 0, -7.35, 0, 0, 0.4);
    lumens.set(s, [s.lumen('#f7c487', 0.5)]);
  },
  tick(s, t) {
    s.act('widow', 'idle');
    s.travel('widow', [1.6, -8.7], [0.8, -8.2], 0, 3.4);
    s.look('widow', s.at(0, -7.35, 0.55));
    s.actors.get('widow')!.input.extra = (a) => a.rig.rot('head', 0.48 * smooth(3, 5, t)).pos('hips', 0, -0.36 * smooth(3, 5, t), 0);
    const egg = s.get('egg'), gone = smooth(5.2, 9.6, t);
    egg.overrides.dissolve = gone;
    egg.overrides.eyes = 1 - gone;
    const light = lumens.get(s)![0];
    light.place(s.at(0, -7.35, 0.55));
    light.sprite.material.opacity = (1 - gone) * (0.56 + Math.sin(t * 11) * 0.12);
    if (t < 10) s.stage.mist.emit({
      x: -5, y: s.ground(0, -7.5) + 0.8 + Math.sin(t * 87) * 1.2, z: -8.2 + Math.cos(t * 73) * 2.3,
      vx: 8, vy: 0.42, vz: 0.22, color: new THREE.Color('#828594'), size: 0.55, sizeEnd: 1.6, alpha: 0.22, ttl: 1.6, style: 'mist',
    });
  },
};

const graelMemory: Script = {
  id: 'grael-memory', region: 'heartwood', mood: 'fen', memory: true, duration: 12,
  camera: [{ t: 0, p: G(-5.2, 1.9, 1), l: G(0, 4.1, -12), fov: 58 }, { t: 12, p: G(-3.2, 1.4, -3), l: G(0, 2.9, -11), fov: 58 }],
  lines: [{ at: 4, until: 9.5, text: 'The first tree to fall was the one he planted for shade.', kind: 'caption' }],
  build(s) {
    s.actor('grael', GRAEL, 1.2, -12, -0.57, 0, 0.5);
    for (let i = 0; i < 5; i++) {
      const fallen = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.65, 6.5 - i * 0.48, 12), new THREE.MeshStandardMaterial({ color: i % 2 ? '#44372f' : '#4d4638', roughness: 1 }));
      fallen.position.copy(s.at(-3 + i * 1.3, -7 - i * 1.5, 0.55));
      fallen.rotation.set(0.92 - i * 0.19, i * 0.9, Math.PI * 0.46);
      s.add(fallen);
    }
  },
  tick(s, t) {
    const grief = smooth(1, 6, t);
    s.act('grael', 'idle');
    s.actors.get('grael')!.input.extra = (a) => a.rig.rot('spine', 0.34 * grief).rot('head', 0.53 * grief)
      .rot('shoulderL', -0.8 * grief).rot('elbowL', -0.35 * grief).pos('hips', 0, -0.54 * grief, 0);
    s.look('grael', s.at(-1, -8, 0.4));
  },
};

const keepersMemory: Script = {
  id: 'keepers-memory', region: 'edge', mood: 'edge', memory: true, duration: 15,
  camera: [{ t: 0, p: G(3.7, 2.1, 2), l: G(-1.5, 2.6, -9), fov: 55 }, { t: 7, p: G(2.1, 1.8, 0), l: G(0, 3.1, -9), fov: 53 }, { t: 15, p: G(1.4, 1.3, -2), l: G(0, 3.55, -8), fov: 49 }],
  lines: [
    { at: 1, until: 5.5, text: 'When the Wanderer arrived, his boots were split. A woman from the wood put a bowl on her doorstep and told him to sit.', kind: 'caption' },
    { at: 9.9, until: 14.8, speaker: 'The Wanderer', text: 'Wait. Give me the flowers. I know where the path floods. If I carry them, you’ll have both hands free.' },
  ],
  build(s) {
    s.actor('warden', WARDEN, -3.5, -9, 1.1, 0, 0.4).group.scale.setScalar(0.53);
    const figures = Array.from({ length: 6 }, (_, i) => {
      const shadow = new THREE.Group();
      const cloth = new THREE.MeshStandardMaterial({ color: '#171c20', roughness: 1 });
      const coat = new THREE.Mesh(new THREE.ConeGeometry(0.34, 1.45, 7), cloth); coat.position.y = 0.8;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), cloth); head.position.y = 1.63;
      const legs = [-0.16, 0.16].map((x) => {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.075, 0.78, 6), cloth);
        leg.position.set(x, 0.39, 0); return leg;
      });
      const flower = lanternFlower(0.42); flower.group.position.set(0.31, 0.98, 0.28);
      shadow.add(coat, head, ...legs, flower.group); s.add(shadow);
      return { shadow, flower, legs, start: 5.2 + i * 0.53 };
    });
    runners.set(s, figures);
  },
  tick(s, t) {
    s.act('warden', 'idle');
    s.travel('warden', [-3.5, -9], [0, -8], 0, 5.6);
    const surprise = bump(6, 8.4, t), promise = smooth(9, 12, t);
    s.look('warden', s.at(6, -14, 1.3));
    s.actors.get('warden')!.input.extra = (a) => a.rig.rot('spine', -0.21 * surprise, 0.33 * surprise, 0.16 * Math.sin(t * 2) * a.move)
      .rot('head', -0.26 * surprise - 0.13 * promise, 0.42 * surprise)
      .rot('shoulderL', -0.74 * surprise - 0.65 * promise).rot('shoulderR', -0.48 * surprise - 0.5 * promise)
      .rotPair('elbow', -0.36 * promise);
    for (const [i, { shadow, flower, legs, start }] of runners.get(s)!.entries()) {
      const phase = (t - start) / 2.9;
      shadow.visible = phase > 0 && phase < 1;
      if (!shadow.visible) continue;
      const z = -13.3 - 0.72 * i;
      shadow.position.copy(s.at(-13 + phase * 26, z, Math.abs(Math.sin(t * 14 + i)) * 0.16));
      shadow.rotation.set(-0.22, Math.PI / 2, 0);
      legs.forEach((leg, side) => { leg.rotation.x = Math.sin(t * 14 + i + side * Math.PI) * 1.1; });
      flower.set(0.9, 0.95, t);
    }
  },
};
const runners = new WeakMap<Shot, Array<{ shadow: THREE.Group; flower: ReturnType<typeof lanternFlower>; legs: THREE.Mesh[]; start: number }>>();

const gathering: Script = {
  id: 'gathering', region: 'edge', mood: 'edge', memory: true, duration: 18,
  camera: [
    { t: 0, p: G(3.3, 1.9, 1), l: G(0, 3.6, -8), fov: 56 },
    { t: 5, p: G(4.2, 2.2, 2), l: G(0, 4.5, -8), fov: 58 },
    { t: 10, p: G(3.5, 2.9, 1), l: G(0, 23, -15), fov: 68 },
    { t: 13, p: G(2.2, 2, -1), l: G(0, 4.2, -8), fov: 57 },
    { t: 18, p: G(1.7, 2.6, -2.3), l: G(0, 3.55, -8), fov: 45 },
  ],
  sounds: [{ at: 5.6, kind: 'strain' }],
  lines: [
    { at: 1, until: 5, speaker: 'The Wanderer', text: 'Stay together. If you can hear me, stay where you are. I’ll bring enough for all of us.' },
    { at: 12.5, until: 17.5, text: 'The flowers bent away from him. He planted his feet and pulled again. This time, the roots came with them.', kind: 'caption' },
  ],
  build(s) {
    s.actor('warden', WARDEN, 0, -8, 0, 0, 0.4).group.scale.setScalar(0.58);
    const sparks = Array.from({ length: 32 }, (_, i) => s.lumen(i % 4 === 0 ? '#adf2ca' : '#ffd994', 0.25 + i % 4 * 0.08));
    lumens.set(s, sparks);
  },
  tick(s, t) {
    const lift = smooth(2, 6, t), gather = smooth(10, 16, t);
    s.act('warden', t < 6 ? 'windup' : 'idle', lift, 'devour');
    s.actors.get('warden')!.input.extra = (a) => a.rig.rot('spine', -(lift - gather) * 0.4 + gather * 0.25)
      .rot('head', -(lift - gather) * 0.56).rotPair('shoulder', -1.8 * (lift - gather) - 1.03 * gather, 0, 0.4 * (lift - gather))
      .rotPair('elbow', -0.9 * gather).pos('hips', 0, Math.sin(t * 19) * bump(4.8, 8.6, t) * 0.11, 0);
    const chest = s.at(0, -7.25, 3.25);
    for (const [i, light] of lumens.get(s)!.entries()) {
      const a = i * 2.4, r = 6 + (i % 8) * 1.75;
      const flight = smooth(4.8 + i % 7 * 0.35, 9.4 + i % 4 * 0.37, t);
      const descent = smooth(10.2 + i % 6 * 0.11, 16.3 + i % 5 * 0.19, t);
      const p = s.at(Math.cos(a) * r, -8 + Math.sin(a) * r, 0.25 + 18 * flight + flight * (i % 5));
      p.lerp(chest, descent).add(new THREE.Vector3(Math.sin(t * 2 + i), 0, Math.cos(t * 2 + i)).multiplyScalar(Math.sin(Math.PI * descent) * 2.4));
      light.place(p);
      light.sprite.material.opacity = smooth(4.5, 5.5, t) * (1 - smooth(16.7, 18, t));
      light.trail.opacity = light.sprite.material.opacity;
    }
    s.stage.illuminate(0, chest, luminance, gather * 3, 12);
  },
};

const lightHunger: Script = {
  id: 'light-hunger', region: 'edge', mood: 'edge', memory: true, duration: 21,
  camera: [
    { t: 0, p: G(-5.8, 2.3, -2.3), l: G(-9, 3.4, -7), fov: 55 },
    { t: 6, p: G(-5.8, 2.3, -2.3), l: G(-9, 3.3, -7), fov: 55 },
    { t: 21, p: G(7.9, 1.95, -0.9), l: G(8, 3.85, -7), fov: 56, ease: 'linear' },
  ],
  lines: [
    { at: 1.1, until: 5.7, text: 'It burned between his fingers. He could hear them calling behind him, but he pressed it to his chest and kept walking.', kind: 'caption' },
    { at: 8, until: 12.8, text: 'At first he told himself he was looking for the others. When he passed the woman’s doorstep again, there was frost in her bowl.', kind: 'caption' },
    { at: 15.2, until: 20.8, text: 'By the last winter he had forgotten which houses he was meant to knock at. He could still tell which ones were warm.', kind: 'caption' },
  ],
  build(s) {
    s.actor('warden', WARDEN, -9, -7, 0.6, 0, 0.4).group.scale.setScalar(0.59);
    s.actor('king', UNLIT_KING, -9, -7, 0.6, 0, 0.4).group.scale.setScalar(0.59);
    lumens.set(s, [s.lumen('#fff3b3', 1.2)]);
  },
  tick(s, t) {
    const close = smooth(2, 5.8, t), morph = smooth(7.5, 20, t);
    const p = s.at(-9 + 17 * smooth(6, 21, t), -7);
    const glow = lumens.get(s)![0];
    glow.place(p.clone().add(new THREE.Vector3(0.28 * (1 - close), 3.5 - close * 0.48, 1.32 - close * 0.8)));
    glow.sprite.material.opacity = 1 - close;
    glow.trail.opacity = glow.sprite.material.opacity;
    const phase = t < 6 ? 0 : Math.floor((t - 6) / 2.5) % 2;
    s.cue(`light-hunger-mood-${Math.floor(t / 2.5)}`, () => {
      s.stage.setMood(t < 11 && !phase ? 'dawn' : t < 15 && !phase ? 'fen' : 'throne', t < 6 ? 2 : 0.85);
    });
    for (const [key, dissolve] of [['warden', morph], ['king', 1 - morph]] as const) {
      const figure = s.get(key);
      figure.group.position.copy(p);
      figure.overrides.dissolve = dissolve;
      s.act(key, t > 6 && t < 20.99 ? 'walk' : 'idle');
      s.face(key, t > 6 ? Math.PI / 2 : 0.6);
      const actor = s.actors.get(key)!;
      actor.input.velocity.set(t > 6 && t < 20.99 ? 1.3 : 0, 0, 0);
      actor.input.extra = (a) => a.rig.rotPair('shoulder', -1.4 * (1 - close) - 0.3 * morph).rotPair('elbow', -0.9 * (1 - close))
        .rot('spine', 0.55 * morph).rot('head', Math.sin(t * 1.23) * 0.16 * morph - 0.4 * (1 - close));
    }
    s.stage.illuminate(0, glow.sprite.position, luminance, (1 - close) * 4.3 + close * 0.55, 9);
  },
};

export const BOSS_STORIES: Script[] = [
  widowGift, graelGift, stagFall, fenwyrmFall, gorrikFall, heraldMemory, heraldFall, widowMemory, graelMemory,
  keepersMemory, gathering, lightHunger,
];
