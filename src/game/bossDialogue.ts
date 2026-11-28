import type { CreatureKind } from '../world/EncounterState.ts';

export interface BossLine {
  seconds: number;
  text: string;
  turn?: boolean;
}

export const BOSS_DIALOGUE: Partial<Record<CreatureKind, readonly BossLine[]>> = {
  gorrik: [
    { seconds: 4.5, text: 'We took bread. Then there was no bread, so we took the lanterns.' },
    { seconds: 4, text: 'My lot haven’t eaten in days. Put down what you’re carrying.', turn: true },
  ],
  matron: [
    { seconds: 4.5, text: 'Each cocoon holds a little breath. Listen. You can almost hear it.' },
    { seconds: 4.5, text: 'I remember the hands that took the light. Yours shine just like them.', turn: true },
  ],
  fenwyrm: [
    { seconds: 4.5, text: 'There was a river here. I knew its way to the sea.' },
    { seconds: 4, text: 'Its last warm current runs through you. Give it back.', turn: true },
  ],
  grael: [
    { seconds: 5, text: 'I pressed each seed into the mud myself. I knew every tree by the sound of its leaves.' },
    { seconds: 5, text: 'I hear them falling in my sleep. Give me back the light that fed them.', turn: true },
  ],
  stag: [
    { seconds: 4.5, text: 'I knew this path before the trees knew their names. Now it always leads me here.' },
    { seconds: 4.5, text: 'The last hand that carried light put this cold into my bones. Stay back.', turn: true },
  ],
  widow: [
    { seconds: 5, text: 'The wind gets under the silk. I wrap them again, and still they go cold.' },
    { seconds: 4.5, text: 'Last night I held six. Listen carefully. Only two answer now.' },
    { seconds: 4.7, text: 'Your hands. You had light all this time? You let them die. I’ll kill you.', turn: true },
  ],
  herald: [
    { seconds: 4.8, text: 'Forty winters, I think. The path sends me back every time I ring.' },
    { seconds: 4.8, text: 'But you have a light that travels. Give it to me. I can still get out.', turn: true },
  ],
  king: [
    { seconds: 5, text: 'I came here as a stranger. The wood let me stay. I loved it enough to stay forever.' },
    { seconds: 5, text: 'I can feel the light in your hands. Bring it closer. I’m hungry again.', turn: true },
  ],
};
