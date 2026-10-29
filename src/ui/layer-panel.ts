import { LAYER_NAMES, type Layer, type RenderSettings, VIEW_NAMES, type View } from '../render/layers.ts';

// What each switch is called on screen, and what it does (shown on hover).
const LAYER_TEXT: Record<Layer, { label: string; hint: string }> = {
  sun: { label: 'Sunlight', hint: 'Direct light from the sun, dimmer where it arrives at a grazing angle.' },
  shadows: { label: 'Shadows', hint: 'A shadow ray toward the sun from each sunlit point. Off, the sun shines through objects.' },
  ambient: { label: 'Ambient', hint: 'Fake fill light standing in for sky and bounce light. C1 replaces it.' },
  color: { label: 'Material colors', hint: 'Off, every surface is plain grey, which shows the lighting on its own.' },
  reflections: { label: 'Reflections', hint: 'Mirror bounces. Off, the mirror balls are matte.' },
  fog: { label: 'Distance fade', hint: 'Far surfaces fade into the sky, hiding flicker near the horizon.' },
  sky: { label: 'Sky', hint: 'Off, rays that hit nothing return black, in the background and in reflections.' },
  toneMap: { label: 'Tone mapping', hint: 'Off, anything brighter than the screen can show clips to flat white.' },
  srgb: { label: 'sRGB encoding', hint: 'Off, light values go to the screen unconverted and look too dark.' },
};

// Each view's menu name and how to read its colors.
const VIEW_TEXT: Record<View, { label: string; legend: string }> = {
  final: { label: 'Final image', legend: 'The lit image, built from the layers below. Hover a layer to see what it does.' },
  color: { label: 'Material color', legend: "Each surface's color with no lighting, called albedo." },
  normals: { label: 'Normals', legend: 'Which way each surface faces, as color: red = +x, green = up (+y), blue = +z.' },
  distance: { label: 'Distance', legend: 'How far each ray travelled, mirror bounces included. Near is bright.' },
  sunlight: {
    label: 'Sunlight',
    legend:
      'White: the sun reaches it. Orange: something blocks the sun (a cast shadow). Blue: faces away from the sun. Black: sky.',
  },
  rays: { label: 'Rays per pixel', legend: 'Rays traced for each pixel: 1 blue, 2 teal, 3 green, 4 yellow, 5 red.' },
};

// Builds the panel's controls inside `container` (after its <summary>) and
// edits `settings` in place when one changes; the frame loop reads
// `settings` every frame.
export function attachLayerPanel(container: HTMLElement, settings: RenderSettings): void {
  const viewSelect = document.createElement('select');
  viewSelect.replaceChildren(
    ...VIEW_NAMES.map((name) => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = VIEW_TEXT[name].label;
      return option;
    }),
  );
  viewSelect.value = settings.view;

  const legend = document.createElement('p');
  legend.className = 'legend';
  legend.textContent = VIEW_TEXT[settings.view].legend;

  viewSelect.addEventListener('change', () => {
    const view = VIEW_NAMES.find((name) => name === viewSelect.value);
    if (!view) return;
    settings.view = view;
    legend.textContent = VIEW_TEXT[view].legend;
  });

  const viewLabel = document.createElement('label');
  viewLabel.append('View ', viewSelect);

  const layerBoxes = LAYER_NAMES.map((name) =>
    checkbox(LAYER_TEXT[name].label, LAYER_TEXT[name].hint, settings.layers[name], (on) => {
      settings.layers[name] = on;
    }),
  );

  const sunBox = checkbox('Sun moves', 'Untick to stop the sun and study one shadow.', settings.sunMoves, (on) => {
    settings.sunMoves = on;
  });
  sunBox.classList.add('separated');

  container.append(viewLabel, legend, ...layerBoxes, sunBox);

  // On a narrow screen the open panel would cover most of the picture.
  if (container instanceof HTMLDetailsElement && matchMedia('(max-width: 700px)').matches) container.open = false;
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
