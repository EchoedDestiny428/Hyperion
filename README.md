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

To preview the "can't run here" messages, add `?simulate=no-webgpu`, `?simulate=no-adapter` or `?simulate=insecure` to the URL.

## Scenes

Pick a scene layout from the menu in the bottom-left corner, or open one directly with `?scene=ball-test-1`. Layouts are plain data in [`src/scene/layouts/`](src/scene/layouts/). To add one, create a file there and list it in `src/scene/registry.ts`.

The **Layers** panel in the top-right corner switches parts of the renderer off one at a time (sunlight, shadows, reflections, tone mapping, …). It also shows debug views such as normals, shadows and rays per pixel. Its anti-aliasing controls set how many samples each pixel averages, and can add them one at a time; the `aliasing-test` scene shows the difference best.

## License

The code is under the [MIT License](LICENSE). Third-party assets added in later milestones keep their own licenses, which will be listed with attribution.
