// Measures how clean the picture is while the camera moves. noise.ts measures
// a still picture; this is the same idea for a moving one, which is what
// C2's temporal steps are meant to improve.
//
//   npm run motion                                   a table of errors
//   npx vite build --outDir benchmarks/before        before changing anything
//   (change the code)
//   npm run motion -- --against benchmarks/before    compare the two
//
// Options: --scene <name> (default motion-test), --spin <degrees per frame>
// (default 0.5), --frames <list> (default 20,60), --denoise <list> (Denoise
// slider levels, default 0,2), --history <list> (History slider values, each
// with every Denoise level; default: the app's own), --save <folder> (keeps
// every picture).
// --against needs a build that has ?spin= (camera/spin.ts).
// Set BROWSER_PATH to use a browser other than Edge or Chrome.
//
// How it works: the orbit camera turns by the same angle on every frame
// drawn (?spin=), and after N frames it holds that last moving picture. It's
// compared with a clean, still picture of the same view (?turn= N × spin),
// 1,024 samples, not denoised. The random numbers are fixed by pixel and
// sample, and the turn by frame, not by time, so every run gives the same
// pictures.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { MAX_DENOISE_LEVEL, MAX_HISTORY } from '../src/render/settings.ts';
import { SCENES } from '../src/scene/registry.ts';
import { type Page, captureCanvas, openScene, pick, powerState, pressKey, serve, sleep, slide, startBrowser, waitForHud } from './browser.ts';
import { errorCells } from './compare.ts';
import { type Picture, decodePng, rmsDifference } from './image.ts';

const WIDTH = 640;
const HEIGHT = 400;
const REFERENCE_SAMPLES = 1024;
const SPIN_TIMEOUT_MS = 120_000;

interface Shot {
  png: Buffer;
  picture: Picture;
}

const shot = async (page: Page): Promise<Shot> => {
  const png = await captureCanvas(page);
  return { png, picture: decodePng(png) };
};

// The clean, still picture of the view the spin reaches after `frames` frames.
async function reference(page: Page, url: string, scene: string, turn: number): Promise<Shot> {
  await openScene(page, url, scene, { turn: String(turn) });
  await pick(page, 'Renderer', 'path');
  await pick(page, 'Samples', String(REFERENCE_SAMPLES));
  await slide(page, 'Denoise', 0);
  await sleep(300); // so the HUD no longer shows the count from before the change
  await waitForHud(page, `${scene} reference`, (r) => r.sampleLimit === REFERENCE_SAMPLES && r.samples >= REFERENCE_SAMPLES);
  return shot(page);
}

// The picture after spinning `frames` frames, as it was while still moving.
// `history` sets the History slider; null leaves the app's default.
async function moving(
  page: Page,
  url: string,
  scene: string,
  spin: number,
  frames: number,
  denoise: number,
  history: number | null,
): Promise<Shot> {
  await openScene(page, url, scene, { spin: String(spin), frames: String(frames) });
  await pick(page, 'Renderer', 'path');
  await slide(page, 'Denoise', denoise);
  if (history !== null) await slide(page, 'History', history);
  await waitForHud(page, `${scene} before spinning`, (r) => r.samples > 0);
  await pressKey(page, 'KeyP', 'p', 80);
  for (let waited = 0; ; waited += 100) {
    const state = await page.evaluate(`document.getElementById('view').dataset.spin`);
    if (state === 'done') break;
    if (page.errors.length > 0) throw new Error(`${scene}: the page reported: ${page.errors.join(' | ')}`);
    if (waited > SPIN_TIMEOUT_MS) {
      throw new Error(
        `${scene}: the spin never finished (state: ${String(state)}). If this is an older build, it has no ?spin= (camera/spin.ts).`,
      );
    }
    await sleep(100);
  }
  return shot(page);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      scene: { type: 'string', default: 'motion-test' },
      spin: { type: 'string', default: '0.5' },
      frames: { type: 'string', default: '20,60' },
      denoise: { type: 'string', default: '0,2' },
      history: { type: 'string' },
      against: { type: 'string' },
      save: { type: 'string' },
    },
  });
  const scene = values.scene;
  if (!SCENES.some((s) => s.name === scene)) throw new Error(`No scene named "${scene}". Scenes: ${SCENES.map((s) => s.name).join(', ')}.`);
  const spin = Number(values.spin);
  if (!Number.isFinite(spin) || spin === 0) throw new Error(`--spin ${values.spin} isn't a number of degrees per frame other than 0.`);
  const frameCounts = values.frames.split(',').map(Number);
  for (const frames of frameCounts) {
    if (!Number.isInteger(frames) || frames < 1) throw new Error(`--frames ${frames} isn't a whole number above 0.`);
  }
  const levels = values.denoise.split(',').map(Number);
  for (const level of levels) {
    if (!Number.isInteger(level) || level < 0 || level > MAX_DENOISE_LEVEL) {
      throw new Error(`--denoise ${level} isn't a Denoise slider level: 0 to ${MAX_DENOISE_LEVEL}.`);
    }
  }
  const histories = values.history === undefined ? [null] : values.history.split(',').map(Number);
  for (const history of histories) {
    if (history !== null && !(Number.isInteger(history) && history >= 0 && history <= MAX_HISTORY)) {
      throw new Error(`--history ${history} isn't a History slider value: 0 to ${MAX_HISTORY}.`);
    }
  }
  if (values.save) await mkdir(values.save, { recursive: true });

  const after = await serve('dist', 'No build found. Run "npm run build" first.');
  const before = values.against
    ? await serve(values.against, `No build in ${values.against}. Make one with "npx vite build --outDir ${values.against}".`)
    : null;
  const browser = await startBrowser(WIDTH, HEIGHT);
  const page = browser.page;

  // The old build (at Denoise 0), then the new one at each level. Each
  // column after the first also shows the change from the first.
  const columns = [
    ...(before ? [{ title: 'Before', url: before.url, level: 0, history: null as number | null }] : []),
    ...histories.flatMap((history) =>
      levels.map((level) => ({
        title: history === null ? `Denoise ${level}` : `History ${history}, Denoise ${level}`,
        url: after.url,
        level,
        history,
      })),
    ),
  ];

  try {
    const header = `| Frames | ${columns.map((c) => c.title).join(' | ')} |`;
    const rows = [header, header.replace(/[^|]+/g, ' --- ')];
    const keep = async (picture: Shot, name: string): Promise<void> => {
      if (values.save) await writeFile(join(values.save, `${name}.png`), picture.png);
    };
    for (const frames of frameCounts) {
      const still = await reference(page, (before ?? after).url, scene, frames * spin);
      await keep(still, `${scene}-${frames}-reference`);
      const errors: number[] = [];
      for (const column of columns) {
        const picture = await moving(page, column.url, scene, spin, frames, column.level, column.history);
        await keep(picture, `${scene}-${frames}-${column.title.toLowerCase().replace(/[ ,]/g, '')}`);
        errors.push(rmsDifference(picture.picture, still.picture));
      }
      rows.push(`| ${frames} | ${errorCells(errors).join(' | ')} |`);
      console.error(`${frames} frames: done`);
    }
    console.log(
      `${scene}, path tracer, ${WIDTH}×${HEIGHT}, turning ${spin}° per frame, ${await powerState(page)}. ` +
        `Error: typical difference per pixel from a still ${REFERENCE_SAMPLES}-sample picture of the same view, in screen values 0–255.\n`,
    );
    console.log(rows.join('\n'));
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
