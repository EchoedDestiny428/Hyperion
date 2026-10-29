# Hyperion

A WebGPU tech demo: real-time ray tracing in the browser, and later, large scenes that load in seconds.

**Status:** early development. Milestone **C0** is a live Whitted-style ray tracer of a small procedural scene. Plain-language explanations of how each part works are in [`docs/learn/`](docs/learn/).

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

## Controls

| Camera | Controls |
|---|---|
| **Orbit** (circles a point) | Drag or arrow keys to circle · scroll to zoom |
| **Fly** (moves freely) | WASD to move · Q/E down/up · hold Shift for faster · `[` and `]` for slower and faster · drag to look · scroll to zoom |

Pressing W, A, S or D switches to Fly; pressing an arrow key switches back to Orbit. Both cameras turn all the way around, upside down included. Hover the Camera menu for a reminder.

To preview the "can't run here" messages, add `?simulate=no-webgpu`, `?simulate=no-adapter` or `?simulate=insecure` to the URL.

## Scenes

Pick a scene layout from the menu in the bottom-left corner, or open one directly with `?scene=ball-test-1`. Layouts are plain data in [`src/scene/layouts/`](src/scene/layouts/). To add one, create a file there and list it in `src/scene/registry.ts`.

Some scenes have sliders under the Scene menu; `shadow-heights` lifts a ball to show how shadows soften with height.

The **Renderer** panel in the top-right corner switches between the C0 Whitted ray tracer and the C1 path tracer, picks the camera, and shows debug views such as normals, shadows and rays per pixel. Its anti-aliasing controls set how many samples each pixel averages, and can add them one at a time; the `aliasing-test` scene shows the difference best. The HUD in the top-left shows how long the GPU spends per frame, where the browser can measure it.

## License

The code is under the [MIT License](LICENSE). Third-party assets added in later milestones keep their own licenses, which will be listed with attribution.
