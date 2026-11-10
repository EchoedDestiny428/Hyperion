// Measures the GPU time of every scene and renderer in a real browser, so an
// optimization comes with a before and after number.
//
//   npm run benchmark                         print a table of GPU times
//
//   npx vite build --outDir benchmarks/before     before changing anything
//   (change the code)
//   npm run benchmark -- --against benchmarks/before   compare the two
//
// Comparing means alternating the two builds in one session. A laptop GPU
// jumps between clock speeds, so identical code measured in separate runs
// differed by up to 13% on battery (checked on 2026-10-30), which would hide
// most optimizations. Alternating exposes both builds to the same conditions.
//
// Options: --rounds <n> (default 5), --scene <name>, --renderer <name>.
// Set BROWSER_PATH to use a browser other than Edge or Chrome.
// Time is only half the story for changes meant to reduce noise; noise.ts
// measures the other half.

import { parseArgs } from 'node:util';
import { RENDERER_NAMES } from '../src/render/settings.ts';
import { SCENES } from '../src/scene/registry.ts';
import { type HudReading, type Result, formatReport } from './benchmark-report.ts';
import { type Page, openScene, pick, powerState, serve, sleep, startBrowser, waitForHud } from './browser.ts';

const WIDTH = 1280;
const HEIGHT = 800;
// Enough for the HUD's last 120 timings to all come from after the renderer
// was picked, even if only one frame in three gets timed.
const SAMPLES_TO_MEASURE = 512;
const HUD_REFRESH_MS = 300; // a little longer than the HUD's update interval

async function measure(page: Page, url: string, scene: string, renderer: string): Promise<HudReading> {
  const label = `${scene}, ${renderer}`;
  // A fresh page each time, so timings from the last measurement can't mix in.
  await openScene(page, url, scene);
  await waitForHud(page, label, (reading) => reading.samples > 0);
  await pick(page, 'Renderer', renderer);
  await sleep(HUD_REFRESH_MS);

  const reading = await waitForHud(page, label, (r) => r.samples >= SAMPLES_TO_MEASURE && r.timing !== null);
  if (reading.canvas !== `${WIDTH}×${HEIGHT}`) throw new Error(`${label}: the canvas is ${reading.canvas}, not ${WIDTH}×${HEIGHT}.`);
  return reading;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      rounds: { type: 'string', default: '5' },
      scene: { type: 'string' },
      renderer: { type: 'string' },
      against: { type: 'string' },
    },
  });
  const rounds = Number(values.rounds);
  const scenes = SCENES.map((scene) => scene.name).filter((name) => !values.scene || name === values.scene);
  if (scenes.length === 0) throw new Error(`No scene named "${values.scene}". Scenes: ${SCENES.map((s) => s.name).join(', ')}.`);
  const renderers = RENDERER_NAMES.filter((name) => !values.renderer || name === values.renderer);
  if (renderers.length === 0) throw new Error(`No renderer named "${values.renderer}". Renderers: ${RENDERER_NAMES.join(', ')}.`);

  const after = await serve('dist', 'No build found. Run "npm run build" first.');
  const before = values.against
    ? await serve(values.against, `No build in ${values.against}. Make one with "npx vite build --outDir ${values.against}".`)
    : null;
  const browser = await startBrowser(WIDTH, HEIGHT);

  try {
    const results: Result[] = scenes.flatMap((scene) =>
      renderers.map((renderer) => ({ scene, renderer, after: [], before: [], p99: [] })),
    );
    let gpu = 'unknown';
    for (let round = 1; round <= rounds; round++) {
      for (const result of results) {
        // Take turns going first, so warming up doesn't favor one build.
        const order = !before ? [after] : round % 2 === 1 ? [before, after] : [after, before];
        for (const build of order) {
          const reading = await measure(browser.page, build.url, result.scene, result.renderer);
          gpu = reading.gpu;
          (build === after ? result.after : result.before).push(reading.timing?.p50 ?? Number.NaN);
          if (build === after) result.p99.push(reading.timing?.p99 ?? Number.NaN);
          const label = !before ? '' : build === after ? ' (after)' : ' (before)';
          console.error(`round ${round}/${rounds}: ${result.scene}, ${result.renderer}${label}: ${reading.timing?.p50} ms`);
        }
      }
    }
    const power = await powerState(browser.page);
    console.log(formatReport({ gpu, canvas: `${WIDTH}×${HEIGHT}`, power, rounds, results }));
  } finally {
    await browser.close();
    await after.close();
    await before?.close();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
