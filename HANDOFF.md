# Handoff notes

For whoever picks this up next, human or agent. Updated 2026-11-01 at the end of a working session. Public file: no personal details here.

## Where things stand

- **Branch:** `c1-path-tracer`, pushed. `main` has C0, the debug views and the editor config fix; C1 merges into `main` when it's finished.
- **C1 chunks 1–3 are done** (see `docs/PLAN.md`):
  - chunk 1: GPU random numbers, progressive accumulation, anti-aliasing;
  - chunk 2: path tracer (bounce light, sky light, soft sun shadows, Russian roulette), the Renderer menu (Whitted kept for comparison), GPU timing;
  - chunk 3: rotated boxes, glowing materials with light sampling, per-scene sun and sky, the `neon-night` scene. The Cornell box is deferred.
  - optimization pass paused: the benchmark, the first speedup and the desktop GPU test are in; see below.
  - chunk 4 in progress, stage 1 of 4 done: one material set by numbers instead of kinds, Fresnel on polished surfaces and metals, the `material-test` scene.
  - also: fly camera (WASD), arrow-key orbit, full 360° turning, scene sliders, the `shadow-heights` and `aliasing-test` scenes.
- **Checks:** `npm run typecheck`, `npm test` (64 passing) and `npm run build` all pass.
- **Learning notes:** `docs/learn/C0.md`, and `docs/learn/C1.md` up to section 23. Keep adding a section per change, in the same plain style.

## Next: chunk 4, real materials

Photo quality comes before more optimization (decided 2026-11-01). Chunk 4's materials and the dreamspace room will change what's slow, so the rest of the optimization pass waits for them. That part of `docs/PLAN.md` holds the order for afterward.

Step 10 in `docs/PLAN.md` is being built in four stages, each reviewed before the next. Stage 2 is next, once it's approved: GGX rough metal, with multiple importance sampling (MIS) so rough surfaces can use both shadow rays and bounce rays. Check the sources for sampling GGX and for MIS before coding; they weren't checked when this was planned.

## Testing on another machine

This is done on a desktop GPU; the results are under "Numbers so far". These steps repeat it anywhere else, such as on another vendor's GPU.

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

1. **Several samples per frame.** The renderer adds one sample per frame, so 1,024 samples takes about 17 seconds on a 60 Hz display, however fast the GPU is. Drawing several per frame when the GPU has room would speed up stills and smooth moving views on a fast GPU. Left out for now (decided 2026-11-01): C1 aims at still images, and moving views can stay rough until C2.
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

The same speedup on a desktop GPU, path tracer, p50, 1280×800, plugged in, no game running, 5 rounds. `neon-night` is left out because its picture changed between the two builds. The speedup mostly helps the integrated GPU; why isn't known.

| Scene | Before | After | Change |
|---|---|---|---|
| `ball-test-1` | 0.23 ms | 0.23 ms | 0.0% (not clear) |
| `aliasing-test` | 0.36 ms | 0.34 ms | −5.6% |
| `shadow-heights` | 0.21 ms | 0.21 ms | 0.0% (not clear) |

Desktop GPU time per sample, p50 / p99, same conditions:

| Scene | Whitted | Path |
|---|---|---|
| `ball-test-1` | 0.14 / 0.14 ms | 0.23 / 0.25 ms |
| `aliasing-test` | 0.19 / 0.36 ms | 0.35 / 0.67 ms |
| `shadow-heights` | 0.14 / 0.16 ms | 0.21 / 0.37 ms |
| `neon-night` | 0.73 / 1.09 ms | 1.10 / 1.45 ms |

What the desktop runs showed:

- **Noise is low.** Identical code showed 0.0% on 7 of 8 combinations and −1.4% (not clear) on the other.
- **Rounding is the real limit.** Times are reported to 0.01 ms, which is about 4% of 0.23 ms but only 1% of 1.10 ms. Use `neon-night` to measure small gains on a fast GPU.
- **Headroom:** the path tracer ran about 17–21× faster than the laptop did on battery saver, on the three scenes that can be compared. That's a rough figure from separate machines.
- **A game in the background barely moved p50.** With one running, every p50 stayed within 0.01 ms of the table above, but `neon-night` path p99 reached 6.87 ms. That spike didn't repeat with the game closed.
- **Unexplained:** other p99 values were higher with the game closed, such as `aliasing-test` path (0.37 to 0.67 ms) and `neon-night` Whitted (0.74 to 1.09 ms). This is one run of each and hasn't been investigated. The GPU dropping to lower clocks while lightly loaded is a guess.

Stage 1 of the new materials made the path tracer slightly slower on the desktop GPU, with every round agreeing: `ball-test-1` 0.23 to 0.25 ms (+8.7%), `aliasing-test` 0.34 to 0.37 ms (+8.8%), `shadow-heights` 0.21 to 0.22 ms (+4.8%, a single rounding step) and `neon-night` 1.11 to 1.17 ms (+5.4%). The cause hasn't been looked into, and it hasn't been measured on the laptop. The material struct grew from 48 to 64 bytes, and each hit does a little more work.

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

- **Layouts are locked by tests.** WGSL structs and their TypeScript packers must match byte for byte. The tests also read `tracer.wgsl` with regexes to check the `LIGHT_*`, `VIEW_*`, `RENDERER_*` and `NO_GROUND` constants, so keep those as single lines of the form `const NAME = 3u;`, and the order of `Material`'s fields.
- **Anything that changes the image must change `FrameParams` or the scene object,** or accumulation won't restart. Sliders replace the scene with a changed copy (`withSphereHeight`) for this reason.
- **WGSL may assume no infinities or NaNs,** so don't rely on `1.0 / 0.0`. The box slab test nudges zero direction components instead.
- **Testing on a real GPU without a visible window:** `scripts/benchmark.ts` shows how. Run Edge (or Chrome) headless with `--remote-debugging-port` and an *absolute* `--user-data-dir`; a relative one makes Edge show an error dialog on the desktop. `--dump-dom` returns before async WebGPU work finishes, so drive the page over the DevTools protocol instead: `Runtime.evaluate` with `awaitPromise`, `Emulation.setDeviceMetricsOverride` for the size, `Page.captureScreenshot`, `Browser.close` when done. The HUD text gives sample counts and GPU times. One screenshot early in a session once came back tiled, and retaking it was fine, so retake a surprising result before trusting it.
- **Same image, same bytes.** Random numbers come from the pixel and sample number, so at a fixed sample count identical code gives a byte-identical picture, as long as each pixel asks for the same random numbers in the same order. That makes before and after screenshots a strong check on any change that shouldn't alter the image.

## Conventions

- **No runtime dependencies.** Raw WebGPU, no engine or wrapper libraries. Dev dependencies are pinned to exact versions.
- **TypeScript is strict and erasable-only** (no enums, namespaces or parameter properties), because Node strips the types to run the tests. Import with `.ts` extensions and mark type-only imports with `type`.
- **Browser code can't use Node APIs.** `tsconfig.app.json` checks `src/` with web types only; tests use `tsconfig.node.json`; the root `tsconfig.json` only references the two, so editors pick the right one per file. Don't add Node types to the browser config.
- **Pure logic stays apart from browser glue,** so it can be tested in Node. Tests sit next to their code as `*.test.ts`, using `node:test` and `node:assert/strict`.
- **Comments are plain language and explain why.** Cite spec or MDN URLs for API behavior, and date browser-support claims ("checked on YYYY-MM-DD").
- **User-facing errors say what's wrong and how to fix it.** Build DOM with `textContent`, never `innerHTML`.
- **The project is also a way to learn graphics programming,** so explain the reasoning behind graphics decisions, and keep `docs/learn/C<n>.md` up to date, ending with a "Words to know" list.
- **Commit only when asked,** one commit per chunk, titled `C<n>: summary` with a bullet list of what changed.
