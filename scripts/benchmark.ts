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
//
// It runs the browser headless over the DevTools protocol, which is how test
// tools like Puppeteer work, but needs no dependency beyond Node's own
// WebSocket: https://chromedevtools.github.io/devtools-protocol/

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { preview } from 'vite';
import { RENDERER_NAMES } from '../src/render/settings.ts';
import { SCENES } from '../src/scene/registry.ts';
import { type HudReading, type Result, formatReport, readHud } from './benchmark-report.ts';

const WIDTH = 1280;
const HEIGHT = 800;
// Enough for the HUD's last 120 timings to all come from after the renderer
// was picked, even if only one frame in three gets timed.
const SAMPLES_TO_MEASURE = 512;
const MEASURE_TIMEOUT_MS = 180_000;
const POLL_MS = 100;
const HUD_REFRESH_MS = 300; // a little longer than the HUD's update interval

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function findBrowser(): string {
  const candidates = [
    process.env['BROWSER_PATH'],
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  const found = candidates.find((path) => path !== undefined && existsSync(path));
  if (found === undefined) {
    throw new Error('No Edge or Chrome found. Set BROWSER_PATH to the browser program and run this again.');
  }
  return found;
}

// A connection to one browser page.
interface Page {
  send(method: string, params?: object): Promise<Record<string, unknown>>;
  waitFor(event: string): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  errors: string[]; // anything the page logged as an error
}

async function openPage(webSocketUrl: string): Promise<Page> {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', reject);
  });

  let nextId = 1;
  const replies = new Map<number, (message: Record<string, unknown>) => void>();
  const waiters = new Map<string, () => void>();
  const errors: string[] = [];

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      method?: string;
      result?: Record<string, unknown>;
      error?: { message: string };
      params?: { type?: string; args?: { value?: unknown; description?: string }[]; exceptionDetails?: { text: string } };
    };
    if (message.id !== undefined) {
      if (message.error) errors.push(message.error.message);
      replies.get(message.id)?.(message.result ?? {});
      replies.delete(message.id);
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
      errors.push((message.params.args ?? []).map((arg) => arg.value ?? arg.description).join(' '));
    }
    if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params?.exceptionDetails?.text ?? 'an exception');
    }
    if (message.method !== undefined) waiters.get(message.method)?.();
  });

  const send: Page['send'] = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      replies.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });

  return {
    send,
    errors,
    waitFor: (event) =>
      new Promise((resolve) => {
        waiters.set(event, () => {
          waiters.delete(event);
          resolve();
        });
      }),
    evaluate: async (expression) => {
      const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      return (reply['result'] as { value?: unknown } | undefined)?.value;
    },
  };
}

// Starts a headless browser with a throwaway profile. The profile path must
// be absolute: given a relative one, Edge shows an error dialog on the desktop.
async function launchBrowser(profile: string): Promise<{ process: ChildProcess; page: Page }> {
  const browser = spawn(
    findBrowser(),
    [
      '--headless=new',
      '--remote-debugging-port=0', // any free port; the browser writes it to a file
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--enable-unsafe-webgpu',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const portFile = join(profile, 'DevToolsActivePort');
  for (let waited = 0; !existsSync(portFile); waited += POLL_MS) {
    if (waited > 30_000) throw new Error('The browser started but never opened its debugging port.');
    await sleep(POLL_MS);
  }
  await sleep(POLL_MS); // let the browser finish writing the file
  const port = (await readFile(portFile, 'utf8')).split('\n')[0]?.trim();

  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
    type: string;
    webSocketDebuggerUrl: string;
  }[];
  const target = targets.find((t) => t.type === 'page');
  if (!target) throw new Error('The browser opened no page to test in.');

  const page = await openPage(target.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  return { process: browser, page };
}

async function hud(page: Page): Promise<HudReading | null> {
  return readHud(String(await page.evaluate(`document.getElementById('hud').textContent`)));
}

// Polls the HUD until `done` says so, and stops early with the reason if the
// page shows a problem or logs an error.
async function waitForHud(page: Page, label: string, done: (reading: HudReading) => boolean): Promise<HudReading> {
  for (let waited = 0; waited < MEASURE_TIMEOUT_MS; waited += POLL_MS) {
    if (page.errors.length > 0) throw new Error(`${label}: the page reported: ${page.errors.join(' | ')}`);
    const problem = await page.evaluate(
      `(() => { const m = document.getElementById('message'); return m.hidden ? '' : m.textContent; })()`,
    );
    if (problem) throw new Error(`${label}: the page says: ${String(problem)}`);
    const reading = await hud(page);
    if (reading && done(reading)) return reading;
    await sleep(POLL_MS);
  }
  throw new Error(`${label}: timed out after ${MEASURE_TIMEOUT_MS / 1000} s. HUD: ${JSON.stringify(await hud(page))}`);
}

async function measure(page: Page, url: string, scene: string, renderer: string): Promise<HudReading> {
  const label = `${scene}, ${renderer}`;
  // A fresh page each time, so timings from the last measurement can't mix in.
  const loaded = page.waitFor('Page.loadEventFired');
  await page.send('Page.navigate', { url: `${url}?scene=${scene}` });
  await loaded;
  await waitForHud(page, label, (reading) => reading.samples > 0);

  await page.evaluate(`(() => {
    const label = [...document.querySelectorAll('#settings label')].find((l) => l.textContent.startsWith('Renderer'));
    const menu = label.querySelector('select');
    menu.value = ${JSON.stringify(renderer)};
    menu.dispatchEvent(new Event('change'));
  })()`);
  await sleep(HUD_REFRESH_MS);

  const reading = await waitForHud(
    page,
    label,
    (r) => r.samples >= SAMPLES_TO_MEASURE && r.timing !== null,
  );
  if (reading.canvas !== `${WIDTH}×${HEIGHT}`) throw new Error(`${label}: the canvas is ${reading.canvas}, not ${WIDTH}×${HEIGHT}.`);
  return reading;
}

// Serves a finished build on a local address.
async function serve(outDir: string, missing: string): Promise<{ url: string; close(): Promise<void> }> {
  if (!existsSync(join(outDir, 'index.html'))) throw new Error(missing);
  const server = await preview({ logLevel: 'silent', build: { outDir }, preview: { host: '127.0.0.1' } });
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error('The preview server gave no address.');
  return { url, close: () => server.close() };
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

  const profile = await mkdtemp(join(tmpdir(), 'hyperion-benchmark-'));
  const { process: browser, page } = await launchBrowser(profile);

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
          const reading = await measure(page, build.url, result.scene, result.renderer);
          gpu = reading.gpu;
          (build === after ? result.after : result.before).push(reading.timing?.p50 ?? Number.NaN);
          if (build === after) result.p99.push(reading.timing?.p99 ?? Number.NaN);
          const label = !before ? '' : build === after ? ' (after)' : ' (before)';
          console.error(`round ${round}/${rounds}: ${result.scene}, ${result.renderer}${label}: ${reading.timing?.p50} ms`);
        }
      }
    }

    // getBattery() reports the real power source, which matters because
    // Windows slows the GPU on battery.
    const charging = await page.evaluate(`navigator.getBattery?.().then((b) => b.charging)`);
    const power = charging === false ? 'on battery' : charging === true ? 'plugged in' : 'power unknown';
    console.log(formatReport({ gpu, canvas: `${WIDTH}×${HEIGHT}`, power, rounds, results }));
  } finally {
    await page.send('Browser.close');
    browser.kill();
    await after.close();
    await before?.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
