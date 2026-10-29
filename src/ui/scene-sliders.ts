import { type Scene, heightAboveGround, withSphereHeight } from '../scene/scene.ts';

// Shows the current scene's sliders (Scene.sliders) inside `container`, and
// hides the container for scenes that have none. Moving a slider passes a
// changed copy of the scene to `onChange`.
export function showSceneSliders(container: HTMLElement, scene: Scene, onChange: (scene: Scene) => void): void {
  const sliders = scene.sliders ?? [];
  container.hidden = sliders.length === 0;
  let current = scene;

  container.replaceChildren(
    ...sliders.map((slider) => {
      const sphere = scene.spheres[slider.sphere];
      const start = sphere ? heightAboveGround(sphere) : 0;

      const value = document.createElement('span');
      const input = document.createElement('input');
      input.type = 'range';
      input.min = '0';
      input.max = String(slider.max);
      input.step = '0.05';
      input.value = String(start);
      const showValue = (): void => {
        value.textContent = ` ${Number(input.value).toFixed(2)} m`;
      };
      showValue();

      // 'input' fires continuously while dragging, so the ball follows the
      // slider live. Each change restarts accumulation, like moving the camera.
      input.addEventListener('input', () => {
        showValue();
        current = withSphereHeight(current, slider.sphere, Number(input.value));
        onChange(current);
      });
      // Give the keyboard back to WASD once the slider is let go.
      input.addEventListener('change', () => input.blur());

      const label = document.createElement('label');
      label.append(slider.label, value, input);
      return label;
    }),
  );
}
