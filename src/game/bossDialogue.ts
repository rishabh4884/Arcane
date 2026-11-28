import type { CreatureKind } from '../world/EncounterState.ts';
import { bump, smooth, type Anim } from '../world/rig/Rig.ts';

export interface BossLine {
  seconds: number;
  text: string;
  turn?: boolean;
}

export const BOSS_DIALOGUE: Partial<Record<CreatureKind, readonly BossLine[]>> = {
  gorrik: [
    { seconds: 5.5, text: 'On market days I sent the little ones for crusts. They came back licking flour from the empty sacks.' },
    { seconds: 5, text: 'We stole the lanterns next. Ever tried boiling one? The water tastes of tin.' },
    { seconds: 5.5, text: 'Put down what you’re carrying. I promised them I wasn’t coming back empty again.', turn: true },
  ],
  matron: [
    { seconds: 5.7, text: 'Stay where the branches can feel you. The youngest have never heard a footstep from below.' },
    { seconds: 5.4, text: 'At dusk I count their wings. Tonight there should be one more pair. I keep counting anyway.' },
    { seconds: 5.5, text: 'I remember the hands that reached into my bower. Fold yours. Let me see what you’ve taken.', turn: true },
  ],
  fenwyrm: [
    { seconds: 5.6, text: 'I used to sleep with my head upstream. In spring the river brought salt all the way to my tongue.' },
    { seconds: 5.2, text: 'Now I can bring you to every bend in it without a scale getting wet. What good is that to me?' },
    { seconds: 5, text: 'Hold still. There’s a current in your wrists. I know that pull. Give it back.', turn: true },
  ],
  grael: [
    { seconds: 6, text: 'The first grew crooked. I used to put a stone beneath the lowest branch so it wouldn’t tire of holding itself up.' },
    { seconds: 5.3, text: 'When that one fell, I put my hand in the hole its roots left. The earth was still warm.' },
    { seconds: 5.5, text: 'There’s that same warmth in your fingers. Open them. I have one bare hillside left to sow.', turn: true },
  ],
  stag: [
    { seconds: 5.4, text: 'There was a place beyond the ridge where the snow came up to my knees. I could hear the herd breathing through it.' },
    { seconds: 5.1, text: 'I’ve worn a track around these trees trying to get back there. My own prints are the only ones in it.' },
    { seconds: 5.1, text: 'I know the heat in your hands. I felt it once through my ribs. Take another step and I’ll run you down.', turn: true },
  ],
  widow: [
    { seconds: 6.2, text: 'Walk where I walk. Last night the rain got under the silk. I wove until my legs buckled, and still the smallest went cold.' },
    { seconds: 6.1, text: 'Put your ear to this one. Hear it tapping? There were six shells that answered me yesterday. Now I can hold both in one arm.' },
    { seconds: 4.8, text: 'Your hands. You had that warmth all along. I let you this close because I thought you understood.', turn: true },
    { seconds: 3.8, text: 'You let them die. I’ll kill you for that.', turn: true },
  ],
  herald: [
    { seconds: 5.6, text: 'There’s a nick in this bell for every year I thought someone might answer. I stopped making them when the metal split.' },
    { seconds: 5.5, text: 'At the bend I can almost see the road home. Then I pass the birch with my name cut in it. Again.' },
    { seconds: 5.8, text: 'You’re warm, and your shadow points out of the wood. Give me what’s in your hands. I want to see a road I haven’t walked.', turn: true },
  ],
  king: [
    { seconds: 5.6, text: 'My first night here I slept under a root. In the morning someone had left a flower by my boots so I could find the path.' },
    { seconds: 5.6, text: 'I meant to do the same for them. I remember asking everyone to wait. I don’t remember when they stopped answering.' },
    { seconds: 5.6, text: 'Why are you closing your hands? Come closer. I only want enough to get warm. I’ll stop when I’m warm.', turn: true },
  ],
};

export function actBossDialogue(kind: CreatureKind, index: number, time: number, a: Anim): void {
  const remembering = index === 0 ? bump(0, 1, time) : 0;
  const considering = index === 1 ? bump(0, 1, time) : 0;
  const resolve = index > 2 ? 1 : index === 2 ? smooth(0, 0.42, time) : 0;
  const r = a.rig;
  if (kind === 'widow') {
    r.rot('head', 0.25 * remembering + 0.4 * considering - 0.29 * resolve, 0.25 * considering, -0.12 * resolve);
    r.pos('hips', 0, -0.17 * considering + 0.2 * resolve, 0);
  } else if (kind === 'grael') {
    r.rot('spine', 0.21 * remembering + 0.28 * considering).rot('head', 0.32 * considering - 0.19 * resolve);
    r.rot('shoulderL', -0.47 * considering).rot('elbowL', -0.63 * considering);
  } else if (kind === 'herald') {
    r.rot('head', 0.19 * remembering - 0.22 * considering).rot('shoulderR', -0.37 * remembering);
    r.rot('shoulderL', -0.91 * resolve).rot('elbowL', -0.37 * resolve);
  } else if (kind === 'king') {
    r.rot('head', 0.19 * remembering, -0.17 * considering).rot('chest', 0.21 * resolve);
    r.rot('shoulderR', -1.1 * resolve).rot('elbowR', -0.58 * resolve);
  } else {
    r.rot('head', 0.18 * remembering - 0.22 * resolve, -0.21 * considering, 0.13 * considering);
    r.rot('neck', 0.15 * remembering - 0.12 * resolve).rot('jaw', (remembering + considering) * (0.08 + 0.065 * Math.sin(a.age * 7)) + 0.18 * resolve);
  }
}
