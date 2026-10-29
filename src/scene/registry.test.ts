import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SCENE, SCENES, findScene } from './registry.ts';
import { heightAboveGround, packScene } from './scene.ts';

test('every layout packs without errors', () => {
  for (const scene of SCENES) assert.doesNotThrow(() => packScene(scene), scene.name);
});

test('layout names are unique and safe to put in a URL', () => {
  const names = SCENES.map((scene) => scene.name);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) assert.match(name, /^[a-z0-9-]+$/);
});

test("every slider lifts a sphere that exists, from a height within the slider's range", () => {
  for (const scene of SCENES) {
    for (const slider of scene.sliders ?? []) {
      const sphere = scene.spheres[slider.sphere];
      assert.ok(sphere, `${scene.name}: "${slider.label}" points at sphere ${slider.sphere}, which doesn't exist`);
      const height = heightAboveGround(sphere);
      assert.ok(height >= 0 && height <= slider.max, `${scene.name}: "${slider.label}" starts out of range`);
    }
  }
});

test('the default is a registered layout, and lookup is by name', () => {
  assert.ok(SCENES.includes(DEFAULT_SCENE));
  assert.equal(findScene(DEFAULT_SCENE.name), DEFAULT_SCENE);
  assert.equal(findScene('no-such-scene'), undefined);
});
