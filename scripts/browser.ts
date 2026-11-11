// Driving a real browser for the measuring scripts (benchmark.ts, noise.ts):
// a headless Edge or Chrome, controlled over the DevTools protocol. This is
// how test tools like Puppeteer work, but it needs no dependency beyond
// Node's own WebSocket: https://chromedevtools.github.io/devtools-protocol/

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preview } from 'vite';
import { type HudReading, readHud } from './benchmark-report.ts';

export const POLL_MS = 100;
const TIMEOUT_MS = 300_000;

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
export interface Page {
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

export interface Browser {
  page: Page;
  close(): Promise<void>;
}

// Starts a headless browser with a throwaway profile, showing pages at the
// given size. The profile path must be absolute: given a relative one, Edge
// shows an error dialog on the desktop.
export async function startBrowser(width: number, height: number): Promise<Browser> {
  const profile = await mkdtemp(join(tmpdir(), 'hyperion-browser-'));
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
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  return {
    page,
    close: async () => {
      await page.send('Browser.close');
      browser.kill();
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    },
  };
}

// Serves a finished build on a local address.
export async function serve(outDir: string, missing: string): Promise<{ url: string; close(): Promise<void> }> {
  if (!existsSync(join(outDir, 'index.html'))) throw new Error(missing);
  const server = await preview({ logLevel: 'silent', build: { outDir }, preview: { host: '127.0.0.1' } });
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error('The preview server gave no address.');
  return { url, close: () => server.close() };
}

// Opens a scene in a fresh page, so nothing from the last one carries over.
// `options` adds to the address, such as { spin: '0.5' } (camera/spin.ts).
export async function openScene(page: Page, url: string, scene: string, options: Record<string, string> = {}): Promise<void> {
  const loaded = page.waitFor('Page.loadEventFired');
  const query = new URLSearchParams({ scene, ...options });
  await page.send('Page.navigate', { url: `${url}?${query}` });
  await loaded;
}

// Screenshots the canvas alone: the HUD and menus are hidden first. Hiding
// them only changes the page, not what the canvas shows, so it can't trigger
// another frame of rendering.
export async function captureCanvas(page: Page): Promise<Buffer> {
  await page.evaluate(`for (const id of ['hud', 'settings', 'scene-picker']) document.getElementById(id).style.display = 'none'`);
  await sleep(300); // a little longer than the HUD's update interval
  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  return Buffer.from(String(shot['data']), 'base64');
}

// Presses and lets go of a key, by its code ('KeyP'), as a person would.
export async function pressKey(page: Page, code: string, key: string, keyCode: number): Promise<void> {
  for (const type of ['keyDown', 'keyUp']) {
    await page.send('Input.dispatchKeyEvent', { type, code, key, windowsVirtualKeyCode: keyCode });
  }
}

// Sets one of the Renderer panel's menus, by the text its label starts with.
export async function pick(page: Page, menu: string, value: string): Promise<void> {
  await page.evaluate(`(() => {
    const label = [...document.querySelectorAll('#settings label')].find((l) => l.textContent.startsWith(${JSON.stringify(menu)}));
    const select = label.querySelector('select');
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event('change'));
  })()`);
}

// Sets one of the Renderer panel's sliders, by the text its label starts
// with. Returns false if there's no such slider, as in a build from before it.
export async function slide(page: Page, slider: string, value: number): Promise<boolean> {
  const found = await page.evaluate(`(() => {
    const label = [...document.querySelectorAll('#settings label')].find((l) => l.textContent.startsWith(${JSON.stringify(slider)}));
    const input = label?.querySelector('input[type=range]');
    if (!input) return false;
    input.value = ${JSON.stringify(String(value))};
    input.dispatchEvent(new Event('input'));
    return true;
  })()`);
  return found === true;
}

export async function hud(page: Page): Promise<HudReading | null> {
  return readHud(String(await page.evaluate(`document.getElementById('hud').textContent`)));
}

// Polls the HUD until `done` says so, and stops early with the reason if the
// page shows a problem or logs an error.
export async function waitForHud(page: Page, label: string, done: (reading: HudReading) => boolean): Promise<HudReading> {
  for (let waited = 0; waited < TIMEOUT_MS; waited += POLL_MS) {
    if (page.errors.length > 0) throw new Error(`${label}: the page reported: ${page.errors.join(' | ')}`);
    const problem = await page.evaluate(
      `(() => { const m = document.getElementById('message'); return m.hidden ? '' : m.textContent; })()`,
    );
    if (problem) throw new Error(`${label}: the page says: ${String(problem)}`);
    const reading = await hud(page);
    if (reading && done(reading)) return reading;
    await sleep(POLL_MS);
  }
  throw new Error(`${label}: timed out after ${TIMEOUT_MS / 1000} s. HUD: ${JSON.stringify(await hud(page))}`);
}

// getBattery() reports the real power source, which matters because Windows
// slows the GPU on battery.
export async function powerState(page: Page): Promise<string> {
  const charging = await page.evaluate(`navigator.getBattery?.().then((b) => b.charging)`);
  return charging === false ? 'on battery' : charging === true ? 'plugged in' : 'power unknown';
}
