// Boot sequence: check the browser → get a GPU device → set up the canvas →
// render every frame. If the device is lost, start over.

import { type Orbit, attachOrbitControls, orbitBasis } from './camera/orbit.ts';
import { trackCanvasSize } from './gpu/canvas.ts';
import { createDevice, describeAdapter, shouldRestart } from './gpu/device.ts';
import { deviceFailure, lostTooOften, parseSimulation, probe } from './platform/detect.ts';
import { hideProblem, showProblem } from './platform/unsupported.ts';
import { createWhittedPass } from './render/whitted-pass.ts';
import { DEFAULT_SCENE, SCENES, findScene } from './scene/registry.ts';
import type { Scene } from './scene/scene.ts';
import { createHud } from './ui/hud.ts';
import { attachScenePicker } from './ui/scene-picker.ts';

const VERTICAL_FOV = (50 * Math.PI) / 180;

const canvas = requireElement('view', HTMLCanvasElement);
const hudElement = requireElement('hud', HTMLElement);
const messageElement = requireElement('message', HTMLElement);
const sceneSelect = requireElement('scene', HTMLSelectElement);

// The scene, camera and canvas sizing don't depend on the GPU, so they're set
// up once and survive device restarts. Input changes them; each frame draws
// whatever they are at that moment.
let scene = initialScene();
const orbit: Orbit = { ...scene.camera }; // a copy, so dragging doesn't edit the layout
attachOrbitControls(canvas, orbit);
attachScenePicker(sceneSelect, SCENES, scene, (picked) => {
  scene = picked;
  Object.assign(orbit, picked.camera);
  rememberScene(picked);
});
trackCanvasSize(canvas);

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
  hideProblem(messageElement);

  let running = true;
  const startTime = performance.now();

  // requestAnimationFrame calls us once per display refresh, just before the
  // browser paints. `now` is on the same clock as performance.now().
  const frame = (now: number): void => {
    if (!running) return;
    hud.frame(now, canvas.width, canvas.height);

    // Record GPU commands into an encoder, then submit them as one batch.
    const encoder = device.createCommandEncoder({ label: 'frame' });
    const params = {
      camera: orbitBasis(orbit),
      verticalFovRadians: VERTICAL_FOV,
      width: canvas.width,
      height: canvas.height,
      timeSeconds: (now - startTime) / 1000,
    };
    pass.encode(encoder, context.getCurrentTexture().createView(), params, scene);
    device.queue.submit([encoder.finish()]);
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
