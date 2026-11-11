# Hyperion

A WebGPU tech demo: real-time ray tracing in the browser, and later, large scenes that load in seconds.

**Status:** early development. Milestone **C1** is done: a path tracer with real bounce light, glTF-style materials (metal, plastic, glass, glowing surfaces), and a BVH, refining to a clean still image in the browser. **C2**, keeping the image clean while the camera moves, is in progress: so far a denoiser that smooths away leftover grain in still images. Plain-language explanations of how each part works are in [`docs/learn/`](docs/learn/).

## Run it

You need **Node.js 24.12+** and a browser with WebGPU:

- Chrome or Edge 113+ on Windows, macOS or ChromeOS;
- Safari 26+ (on macOS, Tahoe 26+);
- Firefox 141+ on Windows.

```sh
npm install
npm run dev        # then open the printed http://localhost:5173 URL
```

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with instant reload |
| `npm test` | Unit tests (Node's built-in test runner) |
| `npm run typecheck` | TypeScript checks for browser code and tests |
| `npm run build` | Type-check, then produce an optimized build in `dist/` |
| `npm run preview` | Serve `dist/` locally |
| `npm run benchmark` | Measure GPU time for every scene and renderer in a headless browser; see `scripts/benchmark.ts` for options |
| `npm run noise` | Measure how noisy each scene is at a few sample counts and Denoise levels, against a clean reference picture; see `scripts/noise.ts` |
| `npm run motion` | Measure how clean the picture stays while the camera moves, against still pictures of the same views; see `scripts/motion.ts` |

## Controls

| Camera | Controls |
|---|---|
| **Orbit** (circles a point) | Drag or arrow keys to circle · scroll to zoom |
| **Fly** (moves freely) | WASD to move · Q/E down/up · hold Shift for faster · `[` and `]` for slower and faster · drag to look · scroll to zoom |

Pressing W, A, S or D switches to Fly; pressing an arrow key switches back to Orbit. Both cameras turn all the way around, upside down included. Hover the Camera menu for a reminder.

To preview the "can't run here" messages, add `?simulate=no-webgpu`, `?simulate=no-adapter` or `?simulate=insecure` to the URL.

## Scenes

Pick a scene layout from the menu in the bottom-left corner, or open one directly with `?scene=ball-test-1`. Layouts are plain data in [`src/scene/layouts/`](src/scene/layouts/). To add one, create a file there and list it in `src/scene/registry.ts`.

Some scenes have sliders under the Scene menu; `shadow-heights` lifts a ball to show how shadows soften with height. `neon-night` is lit by a glowing neon sign, with wet asphalt, puddles and a field of mirror balls. `material-test` compares metal, plastic and glass at every roughness. `cornell-box` is the classic test for bounce light; switch the Renderer to Whitted to see the same room without it. `dreamspace` is a tiled hall with a pool, lit by ceiling panels and sunlight through tall windows; it starts in the Fly camera, and takes the longest to refine. `motion-test` is a small stone plaza in low afternoon sun, built as a test bench for moving cameras. Add `&spin=0.5` to the address and press P to orbit any scene at a steady 0.5° per frame.

The **Renderer** panel in the top-right corner switches between the C0 Whitted ray tracer and the C1 path tracer, picks the camera, and shows debug views such as normals, shadows, rays per pixel, motion vectors and history length. Its Denoise slider sets how hard the path tracer's grain is smoothed away, from 0 (off) to 10 passes (2 by default), its Bounces slider how many surfaces a path can visit, from 1 (direct light only) to 64 (8 by default), its Exposure slider how bright the picture is, in stops (each scene starts at its own), and its History slider how many samples each pixel carries over while the camera moves (4 by default; 0 starts over every frame). Its anti-aliasing controls set how many samples each pixel averages, and can add them one at a time; the `aliasing-test` scene shows the difference best. The HUD in the top-left shows how long the GPU spends per frame, where the browser can measure it.

## License

The code is under the [MIT License](LICENSE). Third-party assets added in later milestones keep their own licenses, which will be listed with attribution.

The `cornell-box` scene uses the measurements of the Cornell box published by the Cornell University Program of Computer Graphics, and the RGB colors from [Benedikt Bitterli's public-domain (CC0) Cornell box](https://benedikt-bitterli.me/resources/).
