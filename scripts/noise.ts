// Measures noise: how far a path-traced picture with few samples is from a
// clean one with many. The benchmark measures time; a change that makes
// shadow rays smarter (or any sampling change) shows up here instead, as a
// cleaner picture for the same number of samples.
//
//   npx vite build --outDir benchmarks/before     before changing anything
//   (change the code)
//   npm run noise -- --against benchmarks/before   compare the two
//
// Options: --scene <name>, --samples <list> (default 16,64), --denoise
// <list> (Denoise slider levels, default 0), --save <folder> (keeps every
// picture as a PNG, to look at what the numbers mean).
// Set BROWSER_PATH to use a browser other than Edge or Chrome.
//
// The reference is never denoised, so a denoised picture's error counts
// both the noise it leaves and anything it smears.
//
// How it works: random numbers come from the pixel and the sample number, so
// the same build gives the same picture every time, and one comparison is
// enough. Pictures are 640×400: noise per pixel doesn't depend on the size,
// and a quarter of the pixels renders four times as fast.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { SAMPLE_LIMITS } from '../src/render/accumulation.ts';
import { MAX_DENOISE_LEVEL } from '../src/render/settings.ts';
import { SCENES } from '../src/scene/registry.ts';
import { type Page, openScene, pick, powerState, serve, sleep, slide, startBrowser, waitForHud } from './browser.ts';
import { type Picture, decodePng, rmsDifference } from './image.ts';

const WIDTH = 640;
const HEIGHT = 400;
const REFERENCE_SAMPLES = 1024;
const HUD_REFRESH_MS = 300; // a little longer than the HUD's update interval

interface Shot {
  png: Buffer;
  picture: Picture;
}

// Renders a scene with the path tracer to exactly `samples` samples, and
// screenshots the canvas with the HUD and menus hidden. `denoise` sets the
// Denoise slider, if the build has one; a build without it never denoises.
async function render(page: Page, url: string, scene: string, samples: number, denoise: number): Promise<Shot> {
  const label = `${scene} at ${samples} samples`;
  await openScene(page, url, scene);
  await pick(page, 'Renderer', 'path');
  await pick(page, 'Samples', String(samples));
  await slide(page, 'Denoise', denoise);
  await sleep(HUD_REFRESH_MS); // so the HUD no longer shows the count from before the change
  await waitForHud(page, label, (r) => r.sampleLimit === samples && r.samples >= samples);
  await page.evaluate(`for (const id of ['hud', 'settings', 'scene-picker']) document.getElementById(id).style.display = 'none'`);
  await sleep(HUD_REFRESH_MS);
  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  const png = Buffer.from(String(shot['data']), 'base64');
  return { png, picture: decodePng(png) };
}

const value = (error: number): string => error.toFixed(2);

// "−29%, 2.0× the samples": a picture with 29% less error is as clean as one
// with 2× the samples would be, since error falls with the square root of the
// sample count.
function change(before: number, after: number): string {
  const percent = (after / before - 1) * 100;
  const samples = (before / after) ** 2;
  return `${percent > 0 ? '+' : ''}${percent.toFixed(1)}%, ${samples.toFixed(2)}× the samples`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      scene: { type: 'string' },
      samples: { type: 'string', default: '16,64' },
      against: { type: 'string' },
      denoise: { type: 'string', default: '0' },
      save: { type: 'string' },
    },
  });
  const scenes = SCENES.map((scene) => scene.name).filter((name) => !values.scene || name === values.scene);
  if (scenes.length === 0) throw new Error(`No scene named "${values.scene}". Scenes: ${SCENES.map((s) => s.name).join(', ')}.`);
  const counts = values.samples.split(',').map(Number);
  // The menu only offers these, and anything else from a script leaves a very noisy picture.
  const allowed: readonly number[] = SAMPLE_LIMITS;
  for (const count of counts) {
    if (!allowed.includes(count)) throw new Error(`--samples ${count} isn't on the Samples menu: ${SAMPLE_LIMITS.join(', ')}.`);
  }
  const levels = values.denoise.split(',').map(Number);
  for (const level of levels) {
    if (!Number.isInteger(level) || level < 0 || level > MAX_DENOISE_LEVEL) {
      throw new Error(`--denoise ${level} isn't a Denoise slider level: 0 to ${MAX_DENOISE_LEVEL}.`);
    }
  }
  if (values.save) await mkdir(values.save, { recursive: true });

  const after = await serve('dist', 'No build found. Run "npm run build" first.');
  const before = values.against
    ? await serve(values.against, `No build in ${values.against}. Make one with "npx vite build --outDir ${values.against}".`)
    : null;
  const browser = await startBrowser(WIDTH, HEIGHT);
  const page = browser.page;

  // One column per picture compared: the old build's (not denoised), then the new
  // build's at each Denoise level. Each after the first also shows the change
  // from the first.
  const columns = [
    ...(before ? [{ title: 'Before', url: before.url, level: 0 }] : []),
    ...levels.map((level) => ({ title: `Denoise ${level}`, url: after.url, level })),
  ];
  if (columns.length === 1 && columns[0]) columns[0].title = 'Error';
  else if (before && levels.length === 1 && levels[0] === 0 && columns[1]) columns[1].title = 'After';

  try {
    const header = `| Scene | Samples | ${columns.map((c) => c.title).join(' | ')} |`;
    const rows: string[] = [header, header.replace(/[^|]+/g, ' --- ')];
    const notes: string[] = [];
    const keep = async (shot: Shot, name: string): Promise<void> => {
      if (values.save) await writeFile(join(values.save, `${name}.png`), shot.png);
    };
    for (const scene of scenes) {
      // The reference comes from the old build, so a change that shifts the
      // picture (a bias, not just noise) shows up as error that won't go away.
      const reference = await render(page, (before ?? after).url, scene, REFERENCE_SAMPLES, 0);
      await keep(reference, `${scene}-reference`);
      console.error(`${scene}: reference done`);
      const errors: { before: number; after: number }[] = [];
      for (const count of counts) {
        const cells: number[] = [];
        for (const column of columns) {
          const shot = await render(page, column.url, scene, count, column.level);
          await keep(shot, `${scene}-${count}-${column.title.toLowerCase().replace(/ /g, '')}`);
          cells.push(rmsDifference(shot.picture, reference.picture));
        }
        const first = cells[0] ?? Number.NaN;
        const text = cells.map((error, i) => (i === 0 ? value(error) : `${value(error)} (${change(first, error)})`));
        rows.push(`| ${scene} | ${count} | ${text.join(' | ')} |`);
        errors.push({ before: first, after: cells[1] ?? Number.NaN });
      }
      if (before) {
        // If the new build draws the same picture with less noise, its own
        // fully refined picture differs from the reference only by the two
        // pictures' leftover noise. Much more than that means it draws a
        // different picture. Leftover noise at 1,024 samples is estimated from
        // the highest count measured, falling with the square root of samples.
        const converged = rmsDifference((await render(page, after.url, scene, REFERENCE_SAMPLES, 0)).picture, reference.picture);
        const last = errors[errors.length - 1] ?? { before: Number.NaN, after: Number.NaN };
        const shrink = Math.sqrt((counts[counts.length - 1] ?? 1) / REFERENCE_SAMPLES);
        const expected = Math.hypot(last.before * shrink, last.after * shrink);
        notes.push(`${scene}: both at ${REFERENCE_SAMPLES} samples differ by ${value(converged)}; leftover noise alone would give about ${value(expected)}.`);
      }
      console.error(`${scene}: done`);
    }
    console.log(`Path tracer, ${WIDTH}×${HEIGHT}, ${await powerState(page)}. Error: typical difference per pixel from a ${REFERENCE_SAMPLES}-sample reference, in screen values 0–255.\n`);
    console.log(rows.join('\n'));
    if (notes.length > 0) console.log(`\nSame picture? ${notes.join('\n')}`);
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
