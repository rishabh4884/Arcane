# Performance

Arcane ran smoothly on Apple silicon and poorly almost everywhere else: other Macs, Windows laptops
and Android phones dropped frames, stuttered in fights and lost picture quality the longer they played.
This document records why, what was changed, and how to measure any device.

## Measuring a device

Open the game with `?bench` (for example `https://<host>/?bench` or `http://localhost:5173/?bench`).
It plays real levels with nobody at the camera, so every device can be measured the same way:

- the webcam runs through MediaPipe exactly as in play (its detections are measured, then ignored);
- two synthetic hands sweep the wood and hold signs through the real gesture engine;
- every spell is cast in turn and the caster never falls, so the fight never stops.

Frame times, main-thread time, draw calls, triangles, GPU resource counts, memory, hand-tracking
cost and the quality level are recorded in five-second windows, so a slow drift over a session shows
as clearly as a slow frame. The table appears on screen at the end, and the full JSON is in
`window.__arcaneBench` (and logged to the console as `[arcane-bench]`).

| Parameter | Meaning |
| --- | --- |
| `bench=30` | seconds recorded per level |
| `levels=3,10,20,30,40` | which levels to play (one per region by default) |
| `warm=3` | seconds to let a level settle before recording |
| `camera=0` / `hands=0` / `casts=0` | leave out the camera, the synthetic hands, or the casting |

A benchmark never touches saved progress or settings, and skips cutscenes.

To compare a quality level by hand: `?quality=high|balanced|low|auto`, `?rung=N` (one rung of the
device's ladder), or `?q=ratio,shadows,smaa,ink,post` (an exact level, e.g. `?q=1,0,1,1,1`). Press
**D** in play for the tracking view, which also shows the frame rate and quality level.

`?nocutscenes` skips every cutscene. Any cutscene can also be skipped with its Skip button or Esc.

### Finding what a device is short of

- `?bench&diagnose` plays one level at one fixed quality level and takes one thing away at a time
  (the page's overlays, the moon's shadows, the inner ink, SMAA, the bloom, the whole post stack,
  half the resolution, the spells, and last the camera). What each one gives back is what it costs
  on that device, GPU timers or not; where the browser has them, each post pass's GPU time is
  recorded too. `level=`, `phase=<seconds>`, `rung=` pick what is measured.
- `?bench&draws` records the GPU time of every draw call, grouped by what drew it (needs GPU timers:
  desktop Chrome and Edge).
- `?tracking=main|worker` and `?delegate=cpu|gpu` hold hand tracking in one place for comparison.

To collect results from a phone or another computer, serve the production build with
`node tools/bench-serve.mjs` (after `npm run build`) and put an https tunnel in front of it (cameras
need https); every benchmark posts its results back, and they are saved in `bench-results/`.

## What was wrong

Measured on a Windows laptop (Snapdragon X, Adreno X1-45, 1536×864 at 1.25×) with the benchmark
above, headless Chrome on the real GPU with a simulated camera:

1. **The picture collapsed in fights.** The inner-ink composite (and other full-screen passes)
   kept three.js's default depth test. On some GPUs (seen through ANGLE on Windows) the full-screen
   draw was then rejected outright: from the first spell of a fight the whole wood turned into a
   flat dark wash with blocky stair-step edges. Apple GPUs never showed it.
2. **Shader compiles mid-fight.** Every spell and creature disposes its materials when it ends, and
   three.js then frees the shader program; custom shaders even lose the id that names their source,
   so the next cast compiled the same shaders again. Shader compilation is slow on Windows (D3D) and
   on most phones: the first cast froze the game for about a second, and casts kept costing
   70–300 ms stalls. The renderer also checked every compiled shader for errors, which forces each
   compile to finish synchronously.
3. **Hitches at every spawn.** three.js sizes a skinned mesh for culling by skinning every vertex on
   the CPU the first time it is tested: 30–50 ms per creature, at every wave.
4. **The adaptive resolution made things worse.** `FrameBudget` averaged every frame interval,
   including loading, shader compiles and camera stalls, which lower resolution cannot fix. It cut
   the resolution during the loading screen, recovered only above 45 fps, and switched the whole post
   stack off for good once it reached its floor. Quality drained away and never came back.
5. **The GPU was shared badly.** MediaPipe runs its hand model on the same GPU, and it can only
   start once the game's queued work is done. With the game keeping the GPU nearly full, each
   tracking frame waited 30–50 ms on the main thread, which also stalled the game's next frame.
   The same model takes about 16 ms on this GPU when the game leaves room, and a few ms on Apple
   silicon.
6. **Avoidable GPU work.** The cel-light pass re-drew the whole scene for its depth every frame
   a spell was in the air (about 1.2 million triangles and a hundred draw calls); the canvas was
   multisampled although the post stack anti-aliases with SMAA; every cast redrew and re-uploaded a
   blurred 1024×256 label texture.

## What changed

- **Full-screen passes never depth-test** (`PostFX.fullScreenOnly`, `InkEdgePass`, `CelLightPass`).
- **Shader programs are kept for the life of the game** (`World.pinPrograms`), together with one
  material per custom shader so its id survives; **every spell is rehearsed behind the loading
  screen** (`World.rehearseSpells`) through the whole pipeline, cel light included, so no spell
  compiles a shader in a fight. Shader error checks run in development only.
- **Creatures get their culling sphere from the bind pose** (`Character`), not from CPU skinning.
- **A quality governor replaces `FrameBudget`** (`src/world/Quality.ts`, tested in
  `tests/quality.test.ts`). A ladder of levels trades resolution above the screen's density first,
  then the moon's figure shadows (contact shadows remain), edge anti-aliasing, the inner ink, and
  only at the very bottom the post stack. The governor:
  - ignores hitches (frames over 100 ms) and the slowest 15% of each window;
  - uses the GPU's own frame time where the browser exposes it (`GpuTimer`), and does not lower the
    resolution when the GPU is not what is slow;
  - while the camera is on, keeps the game's GPU time to about 60% of a frame, leaving room for
    hand tracking;
  - undoes a step down that did not make frames faster, climbs back when there is room (on
    probation, with growing back-off), and needs two slow windows in a row before stepping down;
  - remembers the level a device settles on, so the next session starts there.
  Shadows are turned off by hiding their catcher and pausing the shadow map, not by switching shadow
  maps off, which would recompile every material.
- **Graphics setting** in the Spellbook panel: Auto (default), High, Balanced, Low.
- **The cel-light pass copies the scene's solid depth** with one GPU blit, taken by a marker drawn
  last among the solid objects, instead of drawing the scene again. Where the copy is unavailable it
  falls back to drawing the depth itself. (It also no longer shows dark holes where a figure is still
  rising out of the ground.)
- The canvas is no longer multisampled when the post stack runs; spell labels are drawn once and
  reused; the loading screen's canvas only resizes when the window does.

## Results

Same laptop and benchmark, five levels (one per region), from a fresh profile (the first ~20 seconds
include the governor settling):

| | Before | After |
| --- | --- | --- |
| Frames per second (average) | 40.0 | 53.7 |
| 95th / 99th percentile frame | 50 / 79 ms | 24 / 36 ms |
| Frames over 33 ms | 27% | 5% |
| Worst frame | 899 ms | 105 ms |
| Main-thread render time per frame | 5.0 ms | 2.7 ms |
| Draw calls / triangles per frame | 333 / 2.9 M | 220 / 1.3 M |
| Hand-tracking inference | 36 ms | 18 ms |
| Hand-tracking rate | 14 Hz | 21 Hz |
| Main-thread long tasks | 253 ms/s | 27 ms/s |
| Fights turn into a dark wash | yes | no |

Once settled, levels hold 54–56 fps with under 2–5% of frames over 33 ms on that laptop. The level it
settles on there renders at 0.85× the screen's pixels; a faster GPU keeps a higher level (not yet
measured on Apple silicon).

## Full screen on a small GPU (second pass)

The numbers above were taken at 1536×864. Full screen on the same laptop (1920×1200) in a real
browser fell below 30 fps, and the quality fell with it. Measured with `?bench&diagnose` and
`?bench&draws` at 1920×1200:

- **Full quality costs 15–25 ms of GPU a frame there**, and it is spread out: the post stack about
  4.4 ms (SMAA 1.8), the painted trees and rocks 3.1, the sky 2.2, mist and fog 1.5, shadows 1.5, the
  figures 1.2. At half resolution the scene took 6 ms instead of 17: the cost is per pixel.
- **Hand tracking on the page blocked every camera frame for 24–80 ms** while the GPU was busy, and
  on a real 60 Hz display each of those frames is shown twice. It also misled the governor: slow
  frames that resolution cannot fix.
- **The governor set aside the slowest 15% of frames**, so a fifth of frames missing the display's
  refresh (a visible stutter) still counted as fast enough.

Changes:

- **Hand tracking chooses where it runs** (`HandTracker`). It starts on the page (fastest where the
  device is fast); when the median inference there is over 10 ms it moves to a worker running the
  model on the CPU, so it neither blocks the game's frames nor queues behind them on the GPU, and the
  device remembers it. The worker always takes the newest camera frame. While the model is off the
  GPU, the governor gives the game the GPU's whole budget.
- **The sky is drawn last among the solid objects, on the far plane**, so only the sky that shows is
  shaded (it was shading the whole frame before the wood was painted over it).
- **The governor drops only the slowest 5% of each window**, so missed refreshes count; it still
  lowers the resolution only where the GPU's own time says the GPU is what is slow.

At 1920×1200 on that laptop, two levels, camera on:

| | fps | frames over 33 ms | hand-tracking delay | picture |
| --- | --- | --- | --- | --- |
| Full quality, tracking on the page (before) | 32 | 39% | 40 ms | full |
| Full quality, tracking chosen per device | 38 | 30% | 130 ms | full |
| Auto quality, tracking chosen per device | 52–56 | 5% | 40–60 ms | 0.75×, no moon shadows, SMAA or inner ink |

## Still open

- **Full quality at 60 fps on a small GPU at full screen** needs the drawing itself to be cheaper
  (about 40% on that laptop): the painted trees, mist, figures and post passes. The governor reaches
  60 fps there by trading detail.
- **Phones** have not been measured yet: `?bench&diagnose` through `tools/bench-serve.mjs` will show
  what they are short of.
- Tracking in the CPU worker gets slower when the GPU is saturated (the camera frame has to come
  back from the GPU first): about 12 Hz and 130 ms of delay at full quality on that laptop, against
  18–22 Hz and 40–55 ms when the governor leaves the GPU room.
- Headless Chrome does not snap late frames to the display's refresh the way a real screen does,
  so frames between 16.7 and 20 ms look better in these numbers than they would on a 60 Hz display.
