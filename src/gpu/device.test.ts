import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_RESTARTS_PER_WINDOW, RESTART_WINDOW_MS, shouldRestart } from './device.ts';

test('restarts are allowed until the limit is reached within the window', () => {
  const now = 1_000_000;
  const losses: number[] = [];
  for (let i = 0; i < MAX_RESTARTS_PER_WINDOW; i++) {
    assert.equal(shouldRestart(losses, now), true);
    losses.push(now - i * 1000);
  }
  assert.equal(shouldRestart(losses, now), false);
});

test('losses older than the window no longer count', () => {
  const now = 1_000_000;
  const old = Array.from({ length: MAX_RESTARTS_PER_WINDOW }, () => now - RESTART_WINDOW_MS - 1);
  assert.equal(shouldRestart(old, now), true);
});
