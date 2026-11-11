import { type Pace, SAMPLE_LIMITS } from '../render/accumulation.ts';
import {
  type CameraMode,
  MAX_BOUNCES,
  MAX_DENOISE_LEVEL,
  RENDERER_NAMES,
  type RenderSettings,
  type Renderer,
  VIEW_NAMES,
  type View,
  denoiseLevel,
  denoiseReach,
} from '../render/settings.ts';

export const RENDERER_TEXT: Record<Renderer, string> = {
  whitted: 'Whitted (C0)',
  path: 'Path tracer',
};

// Each view's menu name. How to read their colors is in tracer.wgsl
// (debugView, sunlightView, heat).
const VIEW_TEXT: Record<View, string> = {
  final: 'Final image',
  color: 'Material color',
  normals: 'Normals',
  distance: 'Distance',
  sunlight: 'Sunlight',
  rays: 'Rays per pixel',
};

const PACE_TEXT: Record<Pace, string> = {
  full: 'One per frame',
  slow: '4 per second',
  step: 'One at a time',
};

const CAMERA_TEXT: Record<CameraMode, string> = {
  orbit: 'Orbit',
  fly: 'Fly (WASD)',
};

// Controls that act on the frame loop rather than just change a setting.
export interface PanelActions {
  nextSample(): void;
  restartSamples(): void;
  // Switching camera keeps the current view, which needs the camera state.
  setCameraMode(mode: CameraMode): void;
}

export interface SettingsPanel {
  // Shows `settings` again after something other than the panel changed
  // them (pressing W switches to the fly camera, for example).
  sync(): void;
}

// Builds the panel's controls inside `container` (after its <summary>) and
// edits `settings` in place when one changes; the frame loop reads
// `settings` every frame.
export function attachSettingsPanel(
  container: HTMLElement,
  settings: RenderSettings,
  actions: PanelActions,
): SettingsPanel {
  const rendererSelect = select(
    RENDERER_NAMES.map((name) => [name, RENDERER_TEXT[name]]),
    settings.renderer,
    (value) => {
      settings.renderer = value as Renderer; // only RENDERER_NAMES are offered
      denoise.update();
      bounces.update();
    },
  );

  const cameraSelect = select(
    (Object.keys(CAMERA_TEXT) as CameraMode[]).map((mode) => [mode, CAMERA_TEXT[mode]]),
    settings.cameraMode,
    (value) => actions.setCameraMode(value as CameraMode), // only CAMERA_TEXT's keys are offered
  );

  const viewSelect = select(
    VIEW_NAMES.map((name) => [name, VIEW_TEXT[name]]),
    settings.view,
    (value) => {
      settings.view = value as View; // only VIEW_NAMES are offered
      denoise.update();
    },
  );

  // A moving sun changes the image every frame, so it never refines.
  const sunBox = checkbox(
    'Sun moves',
    settings.sunMoves,
    (on) => {
      settings.sunMoves = on;
    },
  );

  const denoise = slider({
    label: 'Denoise ',
    min: 0,
    max: MAX_DENOISE_LEVEL,
    get: () => settings.denoise,
    set: (value) => {
      settings.denoise = value;
    },
    // Only where it has an effect, so it can't seem broken.
    applies: () => denoiseLevel({ ...settings, denoise: 1 }) > 0,
    notApplying: 'path tracer, final image only',
    text: (level) =>
      level === 0 ? 'off' : `${level} ${level === 1 ? 'pass' : 'passes'}, reach ${denoiseReach(level)} px`,
  });
  const bounces = slider({
    label: 'Bounces ',
    min: 1,
    max: MAX_BOUNCES,
    get: () => settings.bounces,
    set: (value) => {
      settings.bounces = value;
    },
    applies: () => settings.renderer === 'path',
    notApplying: 'path tracer only',
    text: (count) => (count === 1 ? '1 (direct light only)' : String(count)),
  });

  container.append(
    labelled('Renderer ', rendererSelect),
    labelled('Camera ', cameraSelect),
    labelled('View ', viewSelect),
    denoise.element,
    bounces.element,
    sunBox,
    ...antiAliasingControls(settings, actions),
  );

  // On a narrow screen the open panel would cover most of the picture.
  if (container instanceof HTMLDetailsElement && matchMedia('(max-width: 700px)').matches) container.open = false;

  return {
    sync() {
      cameraSelect.value = settings.cameraMode;
    },
  };
}

// How many samples each pixel averages, and how fast they're added, so you
// can compare "1x" with "16x" or watch the image build up sample by sample.
function antiAliasingControls(settings: RenderSettings, actions: PanelActions): HTMLElement[] {
  const heading = document.createElement('p');
  heading.className = 'heading';
  heading.textContent = 'Anti-aliasing';

  const limitSelect = select(
    SAMPLE_LIMITS.map((n) => [String(n), n === 1 ? '1 (none)' : String(n)]),
    String(settings.sampleLimit),
    (value) => {
      settings.sampleLimit = Number(value);
    },
  );

  const next = button('Next sample', actions.nextSample);
  next.disabled = settings.pace !== 'step';
  const paceSelect = select(
    (Object.keys(PACE_TEXT) as Pace[]).map((pace) => [pace, PACE_TEXT[pace]]),
    settings.pace,
    (value) => {
      settings.pace = value as Pace; // only PACE_TEXT's keys are offered
      next.disabled = settings.pace !== 'step';
      actions.restartSamples(); // so a slower pace shows the image building up from the start
    },
  );

  const buttons = document.createElement('div');
  buttons.className = 'buttons';
  buttons.append(next, button('Restart', actions.restartSamples));

  return [heading, labelled('Samples ', limitSelect), labelled('Pace ', paceSelect), buttons];
}

interface SliderOptions {
  label: string;
  min: number;
  max: number;
  get(): number;
  set(value: number): void;
  applies(): boolean; // false disables it
  notApplying: string; // shown while disabled
  text(value: number): string;
}

// A whole-number slider with its value shown beside the label.
// - Denoise: 0 is off, and each step adds a filter pass that reaches twice
//   as far (denoise.wgsl), removing coarser blotches but able to smear finer
//   detail. It moves freely on a finished image: the frame loop redraws from
//   the samples already taken.
// - Bounces: the most surfaces a path visits (tracePath). Changing it
//   changes the picture, so the samples start over.
function slider(options: SliderOptions): { element: HTMLLabelElement; update(): void } {
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(options.min);
  input.max = String(options.max);
  input.step = '1';
  input.value = String(options.get());

  const value = document.createElement('span');
  const update = (): void => {
    const applies = options.applies();
    input.disabled = !applies;
    value.textContent = applies ? options.text(options.get()) : options.notApplying;
  };
  update();

  // 'input' fires continuously while dragging, so the image follows live.
  input.addEventListener('input', () => {
    options.set(Number(input.value));
    update();
  });
  // Give the keyboard back to WASD once the slider is let go.
  input.addEventListener('change', () => input.blur());

  const label = document.createElement('label');
  label.className = 'slider';
  label.append(options.label, value, input);
  return { element: label, update };
}

function labelled(text: string, control: HTMLElement): HTMLLabelElement {
  const label = document.createElement('label');
  label.append(text, control);
  return label;
}

function select(options: [value: string, text: string][], value: string, onPick: (value: string) => void): HTMLSelectElement {
  const element = document.createElement('select');
  element.replaceChildren(
    ...options.map(([optionValue, text]) => {
      const option = document.createElement('option');
      option.value = optionValue;
      option.textContent = text;
      return option;
    }),
  );
  element.value = value;
  element.addEventListener('change', () => {
    onPick(element.value);
    // Give the keyboard back to WASD. A focused menu would otherwise take
    // letter keys as "jump to the option starting with W".
    element.blur();
  });
  return element;
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = text;
  element.addEventListener('click', onClick);
  return element;
}

function checkbox(text: string, checked: boolean, onToggle: (on: boolean) => void): HTMLLabelElement {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onToggle(input.checked));

  const label = document.createElement('label');
  label.append(input, ` ${text}`);
  return label;
}
