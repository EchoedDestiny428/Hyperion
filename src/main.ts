// Boot sequence: check the browser → get a GPU device → set up the canvas →
// render every frame. If the device is lost, start over.

import { type Fly, attachFlyControls, flyBasis, flyFromOrbit, moveFly, orbitFromFly } from './camera/fly.ts';
import { type Orbit, attachOrbitControls, orbitBasis, spinOrbit } from './camera/orbit.ts';
import { trackCanvasSize } from './gpu/canvas.ts';
import { createDevice, describeAdapter, shouldRestart } from './gpu/device.ts';
import { createGpuTimer } from './gpu/timer.ts';
import { deviceFailure, lostTooOften, parseSimulation, probe } from './platform/detect.ts';
import { hideProblem, showProblem } from './platform/unsupported.ts';
import { createSampleCounter, targetSamples } from './render/accumulation.ts';
import { type CameraMode, RENDERERS, VIEWS, defaultSettings } from './render/settings.ts';
import { createTracerPass } from './render/tracer-pass.ts';
import { DEFAULT_SCENE, SCENES, findScene } from './scene/registry.ts';
import type { Scene } from './scene/scene.ts';
import { createHud } from './ui/hud.ts';
import { attachScenePicker } from './ui/scene-picker.ts';
import { showSceneSliders } from './ui/scene-sliders.ts';
import { RENDERER_TEXT, attachSettingsPanel } from './ui/settings-panel.ts';

const VERTICAL_FOV = (50 * Math.PI) / 180;
const FLY_SPEED = 2; // meters per second, until the scroll wheel changes it
// Longest step the fly camera and the sun take in one frame, so a hitch (or
// coming back to the tab) doesn't send them flying.
const MAX_FRAME_SECONDS = 0.1;

const canvas = requireElement('view', HTMLCanvasElement);
const hudElement = requireElement('hud', HTMLElement);
const messageElement = requireElement('message', HTMLElement);
const sceneSelect = requireElement('scene', HTMLSelectElement);
const settingsPanel = requireElement('settings', HTMLDetailsElement);
const sceneSliders = requireElement('scene-sliders', HTMLElement);

// The scene, cameras, render settings and canvas sizing don't depend on the
// GPU, so they're set up once and survive device restarts. Input changes
// them; each frame draws whatever they are at that moment.
let scene = initialScene();
const settings = defaultSettings();

// Two cameras; settings.cameraMode says which one is in use. The orbit starts
// as a copy of the scene's view, so moving doesn't edit the layout.
const orbit: Orbit = { ...scene.camera };
const fly: Fly = flyFromOrbit(orbit, FLY_SPEED);
const orbitControls = attachOrbitControls(
  canvas,
  orbit,
  () => settings.cameraMode === 'orbit',
  () => setCameraMode('orbit'), // pressing an arrow key while flying
);
const flyControls = attachFlyControls(
  canvas,
  fly,
  () => settings.cameraMode === 'fly',
  () => setCameraMode('fly'), // pressing W, A, S, D, Q or E while orbiting
);

// The panel's buttons raise these flags, and the next frame acts on them.
let stepRequested = false;
let restartRequested = false;
const panel = attachSettingsPanel(settingsPanel, settings, {
  nextSample: () => {
    stepRequested = true;
  },
  restartSamples: () => {
    restartRequested = true;
  },
  setCameraMode: (mode) => setCameraMode(mode),
});

// Switching cameras keeps the view: the new camera starts where the old one is.
function setCameraMode(mode: CameraMode): void {
  if (mode === settings.cameraMode) return;
  if (mode === 'fly') Object.assign(fly, flyFromOrbit(orbit, fly.speed));
  else Object.assign(orbit, orbitFromFly(fly, orbit.distance));
  settings.cameraMode = mode;
  panel.sync();
}

// A slider moves a sphere by replacing `scene` with a changed copy.
const showSliders = (shown: Scene): void =>
  showSceneSliders(sceneSliders, shown, (changed) => {
    scene = changed;
  });
showSliders(scene);
attachScenePicker(sceneSelect, SCENES, scene, (picked) => {
  scene = picked;
  // Each scene starts from its own orbit view.
  Object.assign(orbit, picked.camera);
  settings.cameraMode = 'orbit';
  panel.sync();
  showSliders(picked);
  rememberScene(picked);
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

  const pass = createTracerPass(device, format);
  const timer = createGpuTimer(device); // null without timestamp-query
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
    const seconds = previousNow === null ? 0 : Math.min((now - previousNow) / 1000, MAX_FRAME_SECONDS);
    previousNow = now;
    if (settings.sunMoves) sunSeconds += seconds;
    if (settings.cameraMode === 'fly') Object.assign(fly, moveFly(fly, flyControls.input(), seconds));
    else Object.assign(orbit, spinOrbit(orbit, orbitControls.input(), seconds));

    const inputs = {
      camera: settings.cameraMode === 'fly' ? flyBasis(fly) : orbitBasis(orbit),
      verticalFovRadians: VERTICAL_FOV,
      width: canvas.width,
      height: canvas.height,
      timeSeconds: sunSeconds,
      renderer: RENDERERS[settings.renderer],
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
      const canvasView = context.getCurrentTexture().createView();
      pass.encode(encoder, canvasView, { ...inputs, sampleIndex }, scene, timer?.passTimestamps());
      timer?.resolve(encoder);
      device.queue.submit([encoder.finish()]);
      timer?.collect();
    }
    hud.frame(now, {
      renderer: RENDERER_TEXT[settings.renderer],
      gpuTimes: timer ? timer.times : null,
      camera: settings.cameraMode === 'fly' ? `Fly · ${fly.speed.toFixed(1)} m/s` : 'Orbit',
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
