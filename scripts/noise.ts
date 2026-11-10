// Measures noise: how far a path-traced picture with few samples is from a
// clean one with many. The benchmark measures time; a change that makes
// shadow rays smarter (or any sampling change) shows up here instead, as a
// cleaner picture for the same number of samples.
//
//   npx vite build --outDir benchmarks/before     before changing anything
//   (change the code)
//   npm run noise -- --against benchmarks/before   compare the two
//
// Options: --scene <name>, --samples <list> (default 16,64).
// Set BROWSER_PATH to use a browser other than Edge or Chrome.
//
// How it works: random numbers come from the pixel and the sample number, so
// the same build gives the same picture every time, and one comparison is
// enough. Pictures are 640×400: noise per pixel doesn't depend on the size,
// and a quarter of the pixels renders four times as fast.

import { parseArgs } from 'node:util';
import { SAMPLE_LIMITS } from '../src/render/accumulation.ts';
import { SCENES } from '../src/scene/registry.ts';
import { type Page, openScene, pick, powerState, serve, sleep, startBrowser, waitForHud } from './browser.ts';
import { type Picture, decodePng, rmsDifference } from './image.ts';

const WIDTH = 640;
const HEIGHT = 400;
const REFERENCE_SAMPLES = 1024;
const HUD_REFRESH_MS = 300; // a little longer than the HUD's update interval

// Renders a scene with the path tracer to exactly `samples` samples, and
// screenshots the canvas with the HUD and menus hidden.
async function render(page: Page, url: string, scene: string, samples: number): Promise<Picture> {
  const label = `${scene} at ${samples} samples`;
  await openScene(page, url, scene);
  await pick(page, 'Renderer', 'path');
  await pick(page, 'Samples', String(samples));
  await sleep(HUD_REFRESH_MS); // so the HUD no longer shows the count from before the change
  await waitForHud(page, label, (r) => r.sampleLimit === samples && r.samples >= samples);
  await page.evaluate(`for (const id of ['hud', 'settings', 'scene-picker']) document.getElementById(id).style.display = 'none'`);
  await sleep(HUD_REFRESH_MS);
  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  return decodePng(Buffer.from(String(shot['data']), 'base64'));
}

const value = (error: number): string => error.toFixed(2);

// "−29% (2.0× the samples)": a picture with 29% less error is as clean as one
// with 2× the samples would be, since error falls with the square root of the
// sample count.
function change(before: number, after: number): string {
  const percent = (after / before - 1) * 100;
  const samples = (before / after) ** 2;
  return `${percent > 0 ? '+' : ''}${percent.toFixed(1)}% (${samples.toFixed(2)}× the samples)`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      scene: { type: 'string' },
      samples: { type: 'string', default: '16,64' },
      against: { type: 'string' },
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

  const after = await serve('dist', 'No build found. Run "npm run build" first.');
  const before = values.against
    ? await serve(values.against, `No build in ${values.against}. Make one with "npx vite build --outDir ${values.against}".`)
    : null;
  const browser = await startBrowser(WIDTH, HEIGHT);
  const page = browser.page;

  try {
    const header = before ? '| Scene | Samples | Before | After | Change |' : '| Scene | Samples | Error |';
    const rows: string[] = [header, header.replace(/[^|]+/g, ' --- ')];
    const notes: string[] = [];
    for (const scene of scenes) {
      // The reference comes from the old build, so a change that shifts the
      // picture (a bias, not just noise) shows up as error that won't go away.
      const reference = await render(page, (before ?? after).url, scene, REFERENCE_SAMPLES);
      console.error(`${scene}: reference done`);
      const errors: { before: number; after: number }[] = [];
      for (const count of counts) {
        const a = rmsDifference(await render(page, after.url, scene, count), reference);
        const b = before ? rmsDifference(await render(page, before.url, scene, count), reference) : Number.NaN;
        errors.push({ before: b, after: a });
        rows.push(before ? `| ${scene} | ${count} | ${value(b)} | ${value(a)} | ${change(b, a)} |` : `| ${scene} | ${count} | ${value(a)} |`);
      }
      if (before) {
        // If the new build draws the same picture with less noise, its own
        // fully refined picture differs from the reference only by the two
        // pictures' leftover noise. Much more than that means it draws a
        // different picture. Leftover noise at 1,024 samples is estimated from
        // the highest count measured, falling with the square root of samples.
        const converged = rmsDifference(await render(page, after.url, scene, REFERENCE_SAMPLES), reference);
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
