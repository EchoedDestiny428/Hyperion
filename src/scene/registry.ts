import { ballTest1 } from './layouts/ball-test-1.ts';
import type { Scene } from './scene.ts';

// Every scene layout the menu offers, in menu order. To add one, create a
// file in layouts/ and list it here.
export const SCENES: readonly Scene[] = [ballTest1];

// Shown when the URL doesn't name a scene.
export const DEFAULT_SCENE: Scene = ballTest1;

export function findScene(name: string): Scene | undefined {
  return SCENES.find((scene) => scene.name === name);
}
