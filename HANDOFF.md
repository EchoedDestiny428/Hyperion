# Handoff notes

For whoever picks this up next, human or agent. Written 2026-10-30 at the end of a working session. Public file: no personal details here.

## Where things stand

- **Branch:** `c1-path-tracer`, pushed. `main` has C0, the debug views and the editor config fix; C1 merges into `main` when it's finished.
- **C1 chunks 1–3 are done** (see `docs/PLAN.md`):
  - chunk 1: GPU random numbers, progressive accumulation, anti-aliasing;
  - chunk 2: path tracer (bounce light, sky light, soft sun shadows, Russian roulette), the Renderer menu (Whitted kept for comparison), GPU timing;
  - chunk 3: rotated boxes, glowing materials with light sampling, per-scene sun and sky, a mirror coat (`reflectivity`), the `neon-night` scene. The Cornell box is deferred.
  - also: fly camera (WASD), arrow-key orbit, full 360° turning, scene sliders, the `shadow-heights` and `aliasing-test` scenes.
- **Checks:** `npm run typecheck`, `npm test` (56 passing) and `npm run build` all pass.
- **Learning notes:** `docs/learn/C0.md`, and `docs/learn/C1.md` up to section 17. Keep adding a section per change, in the same plain style.

## Open questions (ask before acting on these)

1. **`neon-night` looks too reflective.** Checked with renders at 2% and 0% sheen:
   - the only real reflection is the neon sign's sharp mirror image in the asphalt's 2% coat. It's sharp and the same strength at every angle, unlike real wet asphalt (which needs roughness and Fresnel, chunk 4);
   - the rest of the "shine" is moonlight: the moon is at 20% of daylight but the sky is at 1.2%, so the ground looks brighter than the sky.
   - **Proposed, not yet agreed:** set the asphalt's `reflectivity` to 0 until chunk 4, and raise `environment.sky` to about 0.06.
2. **An optimization pass before chunk 4.** Proposed order, not yet agreed:
   1. a benchmark script (fixed camera per scene, prints p50 GPU time);
   2. compute the hit normal only for the final closest hit, not every candidate;
   3. "any hit" shadow rays that stop at the first blocker;
   4. separate pipelines per renderer and view instead of one big shader (to win back the `ball-test-1` slowdown below);
   5. a BVH over spheres and boxes, pulled forward from Act 2;
   6. lower resolution while the camera moves;
   7. light sampling that skips box faces pointing away from the surface.
3. **Which GPU.** On a machine with two GPUs, the browser picked the integrated one. `requestAdapter()` passes no `powerPreference`; adding `'high-performance'` was offered but not decided. On Windows the per-app setting (Settings → System → Display → Graphics) usually decides anyway. VS Code's built-in browser uses VS Code's own setting (`Code.exe`).

## Baseline numbers

p50 GPU time per sample, 1280×800, headless Edge, Intel Iris Xe (integrated) laptop GPU. They only compare on the same GPU, so take a fresh baseline on a new machine.

| Scene | Path tracer | Whitted |
|---|---|---|
| `ball-test-1`, before chunk 3 | 3.4 ms | 3.1 ms |
| `ball-test-1`, after chunk 3 | 5.0 ms | 3.4 ms |
| `neon-night` | 16.5 ms | 14.3 ms |

`ball-test-1` has no boxes, so its slowdown comes from the bigger shader, not the new features.

## Where things live

- `src/render/tracer.wgsl`: both renderers (`traceWhitted`, `tracePath`), debug views, light sampling, accumulation, tone mapping.
- `src/render/tracer-pass.ts`: pipeline, buffers, bind group (binding numbers match the shader).
- `src/scene/scene.ts`: the scene format and `packScene` byte layouts; `src/scene/layouts/` holds the scenes, `registry.ts` lists them.
- `src/render/accumulation.ts`: when to restart, pacing, sample limits.
- `src/camera/orbit.ts`, `src/camera/fly.ts`: the two cameras.
- `src/gpu/timer.ts`: timestamp-query GPU timing.

## Things worth knowing

- **Layouts are locked by tests.** WGSL structs and their TypeScript packers must match byte for byte. The tests also read `tracer.wgsl` with regexes to check the `KIND_*`, `LIGHT_*`, `VIEW_*`, `RENDERER_*` and `NO_GROUND` constants, so keep those as single lines of the form `const NAME = 3u;`.
- **Anything that changes the image must change `FrameParams` or the scene object,** or accumulation won't restart. Sliders replace the scene with a changed copy (`withSphereHeight`) for this reason.
- **WGSL may assume no infinities or NaNs,** so don't rely on `1.0 / 0.0`. The box slab test nudges zero direction components instead.
- **Testing on a real GPU without a visible window:** run Edge (or Chrome) headless with `--remote-debugging-port` and an *absolute* `--user-data-dir`; a relative one makes Edge show an error dialog on the desktop. `--dump-dom` returns before async WebGPU work finishes, so drive the page over the DevTools protocol instead: `Runtime.evaluate` with `awaitPromise`, `Emulation.setDeviceMetricsOverride` for the size, `Page.captureScreenshot`, `Browser.close` when done. The HUD text gives sample counts and GPU times.

## Conventions

- **No runtime dependencies.** Raw WebGPU, no engine or wrapper libraries. Dev dependencies are pinned to exact versions.
- **TypeScript is strict and erasable-only** (no enums, namespaces or parameter properties), because Node strips the types to run the tests. Import with `.ts` extensions and mark type-only imports with `type`.
- **Browser code can't use Node APIs.** `tsconfig.app.json` checks `src/` with web types only; tests use `tsconfig.node.json`; the root `tsconfig.json` only references the two, so editors pick the right one per file. Don't add Node types to the browser config.
- **Pure logic stays apart from browser glue,** so it can be tested in Node. Tests sit next to their code as `*.test.ts`, using `node:test` and `node:assert/strict`.
- **Comments are plain language and explain why.** Cite spec or MDN URLs for API behavior, and date browser-support claims ("checked on YYYY-MM-DD").
- **User-facing errors say what's wrong and how to fix it.** Build DOM with `textContent`, never `innerHTML`.
- **The project is also a way to learn graphics programming,** so explain the reasoning behind graphics decisions, and keep `docs/learn/C<n>.md` up to date, ending with a "Words to know" list.
- **Commit only when asked,** one commit per chunk, titled `C<n>: summary` with a bullet list of what changed.
