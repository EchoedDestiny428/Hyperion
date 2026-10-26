// Boot sequence: check the browser → get a GPU device → set up the canvas →
// render every frame. If the device is lost, start over.

import { type Orbit, attachOrbitControls, orbitBasis } from './camera/orbit.ts';
import { trackCanvasSize } from './gpu/canvas.ts';
import { createDevice, describeAdapter, shouldRestart } from './gpu/device.ts';
import { deviceFailure, lostTooOften, parseSimulation, probe } from './platform/detect.ts';
import { hideProblem, showProblem } from './platform/unsupported.ts';
import { createWhittedPass } from './render/whitted-pass.ts';
import { createHud } from './ui/hud.ts';

const VERTICAL_FOV = (50 * Math.PI) / 180;

const canvas = requireElement('view', HTMLCanvasElement);
const hudElement = requireElement('hud', HTMLElement);
const messageElement = requireElement('message', HTMLElement);

// Camera and canvas sizing don't depend on the GPU, so they're set up once
// and survive device restarts.
const orbit: Orbit = { target: [0, 0.8, 0], yaw: 0.6, pitch: 0.35, distance: 9 };
attachOrbitControls(canvas, orbit);
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
    pass.encode(encoder, context.getCurrentTexture().createView(), {
      camera: orbitBasis(orbit),
      verticalFovRadians: VERTICAL_FOV,
      width: canvas.width,
      height: canvas.height,
      timeSeconds: (now - startTime) / 1000,
    });
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

function requireElement<T extends HTMLElement>(id: string, type: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`index.html is missing <${type.name} id="${id}">`);
  return element;
}

void start();
