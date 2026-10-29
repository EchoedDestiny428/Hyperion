import { type Pace, SAMPLE_LIMITS } from '../render/accumulation.ts';
import {
  type CameraMode,
  RENDERER_NAMES,
  type RenderSettings,
  type Renderer,
  VIEW_NAMES,
  type View,
} from '../render/settings.ts';

export const RENDERER_TEXT: Record<Renderer, string> = {
  whitted: 'Whitted (C0)',
  path: 'Path tracer',
};

// Each view's menu name, and how to read its colors (shown on hover).
const VIEW_TEXT: Record<View, { label: string; hint: string }> = {
  final: { label: 'Final image', hint: 'The lit image.' },
  color: { label: 'Material color', hint: "Each surface's color with no lighting, called albedo." },
  normals: { label: 'Normals', hint: 'Which way each surface faces, as color: red = +x, green = up (+y), blue = +z.' },
  distance: { label: 'Distance', hint: 'How far each ray travelled, mirror bounces included. Near is bright.' },
  sunlight: {
    label: 'Sunlight',
    hint: 'White: the sun reaches it. Orange: something blocks the sun (a cast shadow). Blue: faces away from the sun. Black: sky.',
  },
  rays: {
    label: 'Rays per pixel',
    hint: 'Average rays traced per sample: 1 blue, 2 teal, 4 green, 8 yellow, 16 or more red.',
  },
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
    },
  );

  const cameraSelect = select(
    (Object.keys(CAMERA_TEXT) as CameraMode[]).map((mode) => [mode, CAMERA_TEXT[mode]]),
    settings.cameraMode,
    (value) => actions.setCameraMode(value as CameraMode), // only CAMERA_TEXT's keys are offered
  );
  cameraSelect.title =
    'Orbit: drag or arrow keys to circle, scroll to zoom. Fly: WASD to move, Q/E down/up, hold Shift for faster, [ and ] for slower and faster, drag to look, scroll to zoom.';

  const viewSelect = select(
    VIEW_NAMES.map((name) => [name, VIEW_TEXT[name].label]),
    settings.view,
    (value) => {
      settings.view = value as View; // only VIEW_NAMES are offered
      viewSelect.title = VIEW_TEXT[settings.view].hint;
    },
  );
  viewSelect.title = VIEW_TEXT[settings.view].hint;

  const sunBox = checkbox(
    'Sun moves',
    'Tick to make the sun circle. The image only refines while nothing moves, so it stays rough.',
    settings.sunMoves,
    (on) => {
      settings.sunMoves = on;
    },
  );

  container.append(
    labelled('Renderer ', rendererSelect),
    labelled('Camera ', cameraSelect),
    labelled('View ', viewSelect),
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

function checkbox(text: string, hint: string, checked: boolean, onToggle: (on: boolean) => void): HTMLLabelElement {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onToggle(input.checked));

  const label = document.createElement('label');
  label.title = hint;
  label.append(input, ` ${text}`);
  return label;
}
