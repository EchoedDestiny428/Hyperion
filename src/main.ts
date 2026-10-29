// Boot sequence: check the browser → get a GPU device → set up the canvas →
// render every frame. If the device is lost, start over.

import { type Orbit, attachOrbitControls, orbitBasis } from './camera/orbit.ts';
import { trackCanvasSize } from './gpu/canvas.ts';
import { createDevice, describeAdapter, shouldRestart } from './gpu/device.ts';
import { deviceFailure, lostTooOften, parseSimulation, probe } from './platform/detect.ts';
import { hideProblem, showProblem } from './platform/unsupported.ts';
import { createSampleCounter, targetSamples } from './render/accumulation.ts';
import { VIEWS, defaultSettings, layerBits } from './render/layers.ts';
import { createWhittedPass } from './render/whitted-pass.ts';
import { DEFAULT_SCENE, SCENES, findScene } from './scene/registry.ts';
import type { Scene } from './scene/scene.ts';
import { createHud } from './ui/hud.ts';
import { attachLayerPanel } from './ui/layer-panel.ts';
import { attachScenePicker } from './ui/scene-picker.ts';

const VERTICAL_FOV = (50 * Math.PI) / 180;

const canvas = requireElement('view', HTMLCanvasElement);
const hudElement = requireElement('hud', HTMLElement);
const messageElement = requireElement('message', HTMLElement);
const sceneSelect = requireElement('scene', HTMLSelectElement);
const layerPanel = requireElement('layers', HTMLDetailsElement);

// The scene, camera, render settings and canvas sizing don't depend on the
// GPU, so they're set up once and survive device restarts. Input changes
// them; each frame draws whatever they are at that moment.
let scene = initialScene();
const orbit: Orbit = { ...scene.camera }; // a copy, so dragging doesn't edit the layout
attachOrbitControls(canvas, orbit);
attachScenePicker(sceneSelect, SCENES, scene, (picked) => {
  scene = picked;
  Object.assign(orbit, picked.camera);
  rememberScene(picked);
});
const settings = defaultSettings();
// The panel's buttons raise these flags, and the next frame acts on them.
let stepRequested = false;
let restartRequested = false;
attachLayerPanel(layerPanel, settings, {
  nextSample: () => {
    stepRequested = true;
  },
  restartSamples: () => {
    restartRequested = true;
  },
});
trackCanvasSize(canvas);

// The sun's position comes from this clock, which only runs while "Sun moves"
// is ticked. A moving sun changes the image every frame, so the image can
// only refine (accumulation.ts) while it stands still.
let sunSeconds = 0;

const deviceLossTimes: number[] = [];

async function start(): Promise<void> {
  const result = await probe(parseSimulation(location.search));
  if ('problem' in result) {
    showProblem(messageElement, result.problem);
    return;
  }
  const { adapter } = result;

  let device: GPUDevice;
  try {
    device = await createDevice(adapter);
  } catch (error) {
    showProblem(messageElement, deviceFailure(error));
    return;
  }

  // The canvas hands us a new texture to draw into each frame. configure()
  // ties it to our device; calling it again after a restart re-ties it.
  // https://developer.mozilla.org/en-US/docs/Web/API/GPUCanvasContext/configure
  const context = canvas.getContext('webgpu');
  if (!context) {
    showProblem(messageElement, deviceFailure(new Error('canvas.getContext("webgpu") returned null')));
    return;
  }
  // The texture format the display works with most efficiently on this system.
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  const pass = createWhittedPass(device, format);
  const hud = createHud(hudElement, describeAdapter(adapter));
  // Per device: a new device has a new, empty accumulation buffer.
  const samples = createSampleCounter();
  hideProblem(messageElement);

  let running = true;
  let previousNow: number | null = null;
  let lastSampleTime = -Infinity;

  // requestAnimationFrame calls us once per display refresh, just before the
  // browser paints. `now` is on the same clock as performance.now().
  const frame = (now: number): void => {
    if (!running) return;
    if (previousNow !== null && settings.sunMoves) sunSeconds += (now - previousNow) / 1000;
    previousNow = now;

    const inputs = {
      camera: orbitBasis(orbit),
      verticalFovRadians: VERTICAL_FOV,
      width: canvas.width,
      height: canvas.height,
      timeSeconds: sunSeconds,
      layers: layerBits(settings.layers),
      view: VIEWS[settings.view],
    };
    samples.check(inputs, scene);
    // Restart, or lower the limit below what the image already holds: start over.
    if (restartRequested || samples.held > settings.sampleLimit) samples.restart();
    restartRequested = false;
    const target = targetSamples({
      held: samples.held,
      limit: settings.sampleLimit,
      pace: settings.pace,
      msSinceLastSample: now - lastSampleTime,
      stepRequested,
    });
    stepRequested = false;

    // Draw only when the image needs another sample. Otherwise skip the GPU
    // work: without a new texture from getCurrentTexture(), the canvas keeps
    // showing the last image.
    if (samples.held < target) {
      const sampleIndex = samples.take();
      lastSampleTime = now;
      // Record GPU commands into an encoder, then submit them as one batch.
      const encoder = device.createCommandEncoder({ label: 'frame' });
      pass.encode(encoder, context.getCurrentTexture().createView(), { ...inputs, sampleIndex }, scene);
      device.queue.submit([encoder.finish()]);
    }
    hud.frame(now, {
      width: canvas.width,
      height: canvas.height,
      samples: samples.held,
      sampleLimit: settings.sampleLimit,
      pace: settings.pace,
    });
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  // Resolves if the device stops working. Everything made with it is now
  // dead, so the only cure is to start over from a new adapter.
  // https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/lost
  void device.lost.then((info) => {
    running = false;
    if (info.reason === 'destroyed') return; // we destroyed it on purpose
    const now = performance.now();
    if (!shouldRestart(deviceLossTimes, now)) {
      showProblem(messageElement, lostTooOften(info.message));
      return;
    }
    deviceLossTimes.push(now);
    console.warn(`[WebGPU] device lost (${info.reason}): ${info.message} Restarting.`);
    void start();
  });
}

// ?scene=<name> picks the layout. An unknown name falls back to the default
// with a console warning, rather than refusing to start.
function initialScene(): Scene {
  const requested = new URLSearchParams(location.search).get('scene');
  if (requested === null) return DEFAULT_SCENE;
  const found = findScene(requested);
  if (!found) {
    const available = SCENES.map((s) => s.name).join(', ');
    console.warn(`[scene] No layout named "${requested}" (available: ${available}). Showing ${DEFAULT_SCENE.name}.`);
  }
  return found ?? DEFAULT_SCENE;
}

// Puts the scene in the address bar, so a reload or a shared link opens the
// same one. replaceState changes the URL without reloading or adding a
// history entry: https://developer.mozilla.org/en-US/docs/Web/API/History/replaceState
function rememberScene(picked: Scene): void {
  const url = new URL(location.href);
  url.searchParams.set('scene', picked.name);
  history.replaceState(null, '', url);
}

function requireElement<T extends HTMLElement>(id: string, type: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`index.html is missing <${type.name} id="${id}">`);
  return element;
}

void start();
