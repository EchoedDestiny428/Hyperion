import type { Scene } from '../scene/scene.ts';

// Fills a <select> with the scene layouts and reports when the user picks
// one. Returns a function that removes the listener.
export function attachScenePicker(
  select: HTMLSelectElement,
  scenes: readonly Scene[],
  current: Scene,
  onPick: (scene: Scene) => void,
): () => void {
  select.replaceChildren(
    ...scenes.map((scene) => {
      const option = document.createElement('option');
      option.value = scene.name;
      option.textContent = scene.name;
      return option;
    }),
  );
  select.value = current.name;

  const onChange = (): void => {
    const scene = scenes.find((s) => s.name === select.value);
    if (scene) onPick(scene);
  };
  select.addEventListener('change', onChange);
  return () => select.removeEventListener('change', onChange);
}
