# Handoff notes

For whoever picks this up next, human or agent. Updated 2026-10-31 at the end of a working session. Public file: no personal details here.

## Where things stand

- **Branch:** `c1-path-tracer`, pushed. `main` has C0, the debug views and the editor config fix; C1 merges into `main` when it's finished.
- **C1 chunks 1–3 are done** (see `docs/PLAN.md`):
  - chunk 1: GPU random numbers, progressive accumulation, anti-aliasing;
  - chunk 2: path tracer (bounce light, sky light, soft sun shadows, Russian roulette), the Renderer menu (Whitted kept for comparison), GPU timing;
  - chunk 3: rotated boxes, glowing materials with light sampling, per-scene sun and sky, a mirror coat (`reflectivity`, unused by any scene for now: wet asphalt needs chunk 4's roughness and Fresnel), the `neon-night` scene. The Cornell box is deferred.
  - optimization pass under way: the benchmark and the first speedup are in; see below.
  - also: fly camera (WASD), arrow-key orbit, full 360° turning, scene sliders, the `shadow-heights` and `aliasing-test` scenes.
- **Checks:** `npm run typecheck`, `npm test` (63 passing) and `npm run build` all pass.
- **Learning notes:** `docs/learn/C0.md`, and `docs/learn/C1.md` up to section 20. Keep adding a section per change, in the same plain style.

## Next: testing on a desktop GPU

The next session is benchmarking on a desktop PC with a stronger GPU.

1. Get the code: `git switch c1-path-tracer`, `git pull`, `npm install`. The benchmark needs Edge or Chrome, or `BROWSER_PATH` set to the browser program.
2. Run `npm run benchmark` for a plain table of GPU times. It prints the GPU and power state, so check it's the GPU you meant.
3. Find the noise on this machine before trusting a comparison: `npx vite build --outDir benchmarks/before`, then `npm run benchmark -- --against benchmarks/before`. That compares the code against itself, so it should show about 0% and "not clear". The 5% rule below came from the laptop and may differ here.
4. To retest the first speedup here, build the code from before it. `benchmarks/` is gitignored, so builds don't travel between machines:

   ```sh
   git worktree add ../hyperion-before 87d3f08
   cd ../hyperion-before
   npm install
   npx vite build --outDir <repo>/benchmarks/before --emptyOutDir
   cd <repo>
   git worktree remove --force ../hyperion-before
   npm run benchmark -- --against benchmarks/before
   ```

   `<repo>` is the absolute path of this repo. Ignore `neon-night` in that comparison: its sky and ground changed after that commit, so the two builds draw different pictures.

## Open questions (ask before acting on these)

1. **What's next for optimization.** Other ideas were mentioned but not discussed yet, so ask before starting anything big. The proposed next steps are a BVH over spheres and boxes, lower resolution while the camera moves, and light sampling that skips box faces pointing away. Details are under "Optimization pass" in `docs/PLAN.md`.
2. **Which GPU counts.** Performance decisions target an everyday integrated laptop GPU; a desktop GPU shows the headroom, not whether it's fast enough. `requestAdapter()` passes no `powerPreference`; adding `'high-performance'` was offered but not decided.

## Numbers so far

Never compare numbers from separate runs: on the laptop, identical code differed by up to 13%. Use `npm run benchmark -- --against <before build>`, which alternates both builds in one session. A change counts only if every round agrees on its direction and it's bigger than about 5%.

First speedup (normals computed only for the final closest hit), path tracer, p50 GPU time per sample, 1280×800, Intel Iris Xe on battery saver. Images stayed byte-identical.

| Scene | Before | After | Change |
|---|---|---|---|
| `ball-test-1` | 5.36 ms | 4.15 ms | −22% |
| `aliasing-test` | 7.55 ms | 6.01 ms | −23% |
| `shadow-heights` | 5.48 ms | 4.51 ms | −18% |
| `neon-night` | 21.67 ms | 19.13 ms | −14% |

Tried and dropped, so don't repeat without a reason: "any hit" shadow rays (no gain in open scenes; retest with a BVH), separate shaders per renderer (no clear gain even in the best case), and removing the frame cap to steady the benchmark (noise got much worse).

## Where things live

- `src/render/tracer.wgsl`: both renderers (`traceWhitted`, `tracePath`), debug views, light sampling, accumulation, tone mapping.
- `src/render/tracer-pass.ts`: pipeline, buffers, bind group (binding numbers match the shader).
- `src/scene/scene.ts`: the scene format and `packScene` byte layouts; `src/scene/layouts/` holds the scenes, `registry.ts` lists them.
- `src/render/accumulation.ts`: when to restart, pacing, sample limits.
- `src/camera/orbit.ts`, `src/camera/fly.ts`: the two cameras.
- `src/gpu/timer.ts`: timestamp-query GPU timing.
- `scripts/benchmark.ts`: the benchmark; `benchmark-report.ts` is its tested, pure half.

## Things worth knowing

- **Layouts are locked by tests.** WGSL structs and their TypeScript packers must match byte for byte. The tests also read `tracer.wgsl` with regexes to check the `KIND_*`, `LIGHT_*`, `VIEW_*`, `RENDERER_*` and `NO_GROUND` constants, so keep those as single lines of the form `const NAME = 3u;`.
- **Anything that changes the image must change `FrameParams` or the scene object,** or accumulation won't restart. Sliders replace the scene with a changed copy (`withSphereHeight`) for this reason.
- **WGSL may assume no infinities or NaNs,** so don't rely on `1.0 / 0.0`. The box slab test nudges zero direction components instead.
- **Testing on a real GPU without a visible window:** `scripts/benchmark.ts` shows how. Run Edge (or Chrome) headless with `--remote-debugging-port` and an *absolute* `--user-data-dir`; a relative one makes Edge show an error dialog on the desktop. `--dump-dom` returns before async WebGPU work finishes, so drive the page over the DevTools protocol instead: `Runtime.evaluate` with `awaitPromise`, `Emulation.setDeviceMetricsOverride` for the size, `Page.captureScreenshot`, `Browser.close` when done. The HUD text gives sample counts and GPU times.

## Conventions

- **No runtime dependencies.** Raw WebGPU, no engine or wrapper libraries. Dev dependencies are pinned to exact versions.
- **TypeScript is strict and erasable-only** (no enums, namespaces or parameter properties), because Node strips the types to run the tests. Import with `.ts` extensions and mark type-only imports with `type`.
- **Browser code can't use Node APIs.** `tsconfig.app.json` checks `src/` with web types only; tests use `tsconfig.node.json`; the root `tsconfig.json` only references the two, so editors pick the right one per file. Don't add Node types to the browser config.
- **Pure logic stays apart from browser glue,** so it can be tested in Node. Tests sit next to their code as `*.test.ts`, using `node:test` and `node:assert/strict`.
- **Comments are plain language and explain why.** Cite spec or MDN URLs for API behavior, and date browser-support claims ("checked on YYYY-MM-DD").
- **User-facing errors say what's wrong and how to fix it.** Build DOM with `textContent`, never `innerHTML`.
- **The project is also a way to learn graphics programming,** so explain the reasoning behind graphics decisions, and keep `docs/learn/C<n>.md` up to date, ending with a "Words to know" list.
- **Commit only when asked,** one commit per chunk, titled `C<n>: summary` with a bullet list of what changed.
