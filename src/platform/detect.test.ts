import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type EnvironmentFacts, applySimulation, browserFamily, diagnose, parseSimulation } from './detect.ts';

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';
const EDGE_UA = `${CHROME_UA} Edg/157.0.0.0`;
const FIREFOX_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:158.0) Gecko/20100101 Firefox/158.0';
const SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';

const healthy: EnvironmentFacts = {
  secureContext: true,
  hasWebGpuApi: true,
  adapterFound: true,
  userAgent: CHROME_UA,
  origin: 'http://localhost:5173',
};

test('a secure context with WebGPU and an adapter has no problem', () => {
  assert.equal(diagnose(healthy), null);
});

test('an insecure context is reported as such, not as a missing API', () => {
  const problem = diagnose({ ...healthy, secureContext: false, hasWebGpuApi: false, adapterFound: false });
  assert.equal(problem?.reason, 'insecure-context');
  assert.match(problem?.explanation ?? '', /localhost:5173/);
});

test('a missing API gives browser-specific advice', () => {
  const firefox = diagnose({ ...healthy, hasWebGpuApi: false, adapterFound: false, userAgent: FIREFOX_UA });
  assert.equal(firefox?.reason, 'no-webgpu');
  assert.ok(firefox?.advice.some((line) => line.includes('Nightly')));

  const safari = diagnose({ ...healthy, hasWebGpuApi: false, adapterFound: false, userAgent: SAFARI_UA });
  assert.ok(safari?.advice.some((line) => line.includes('Safari 26')));
});

test('API present but no adapter points at the GPU/driver, not the browser version', () => {
  assert.equal(diagnose({ ...healthy, adapterFound: false })?.reason, 'no-adapter');
});

test('browserFamily recognizes the major engines', () => {
  assert.equal(browserFamily(CHROME_UA), 'chromium');
  assert.equal(browserFamily(EDGE_UA), 'chromium');
  assert.equal(browserFamily(FIREFOX_UA), 'firefox');
  assert.equal(browserFamily(SAFARI_UA), 'safari');
  assert.equal(browserFamily('curl/8.0'), 'other');
});

test('parseSimulation accepts only known values', () => {
  assert.equal(parseSimulation('?simulate=no-adapter'), 'no-adapter');
  assert.equal(parseSimulation('?simulate=insecure&x=1'), 'insecure');
  assert.equal(parseSimulation('?simulate=bogus'), null);
  assert.equal(parseSimulation(''), null);
});

test('each simulation produces the matching diagnosis', () => {
  assert.equal(diagnose(applySimulation(healthy, 'insecure'))?.reason, 'insecure-context');
  assert.equal(diagnose(applySimulation(healthy, 'no-webgpu'))?.reason, 'no-webgpu');
  assert.equal(diagnose(applySimulation(healthy, 'no-adapter'))?.reason, 'no-adapter');
  assert.equal(diagnose(applySimulation(healthy, null)), null);
});
