# Hyperion plan

> Draft, 2026-10-28. Rebuilt from the code comments and README, because the original plan was lost. Items marked *proposed* aren't decided yet.

**Goal:** a WebGPU tech demo. First, real-time path tracing in the browser. Then, large scenes that load in seconds.

## How the work is organized

- **Acts** are the big goals. **Milestones** (C0, C1, …) are the steps inside them.
- **Each milestone ends with:**
  - a working demo;
  - unit tests for the logic that doesn't need a GPU;
  - a plain-language learning note in `docs/learn/C<n>.md`.
- **Ground rules:**
  - Raw WebGPU, with no engine and no runtime dependencies.
  - Explain every failure to the user in specific, fixable terms.
  - Report metrics honestly: say what a number does and doesn't measure.

| Milestone | Status |
|---|---|
| C0: WebGPU skeleton, Whitted ray tracer | done |
| C1: path tracer | next |
| Act 2: large scenes | later |

## Act 1: real-time ray tracing

### C0: WebGPU skeleton and a Whitted ray tracer (done)

- Capability checks, recovery from device loss, a canvas sized to real pixels, an orbit camera, and a HUD.
- A full-screen fragment-shader ray tracer: spheres, a ground plane, hard shadows, mirror reflections, ACES tone mapping.
- Scene layouts as data (`src/scene/layouts/`), chosen from a menu or with `?scene=`. Material kinds: diffuse, mirror, checker.

### C1: path tracer (next)

**From the code comments:**
- real bounce light, replacing the fake `ambient` term;
- anti-aliasing;
- GPU timing;
- frame-time percentiles in the HUD.

**Steps,** in five chunks. Each chunk ends with something you can check by eye.

*Chunk 1: an image that refines itself*

1. **Random numbers on the GPU:** a per-pixel hash seeded by pixel position and frame number.
2. **Progressive accumulation:** add each frame's sample to a running total per pixel, and show the average. Reset when the camera moves, the canvas resizes, or the scene or layers change.
3. **Anti-aliasing** by shifting each frame's ray slightly within its pixel. Accumulation turns this into smooth edges for free.
   - Check: with the camera still, jagged edges smooth out and the far checkerboard stops flickering.

*Chunk 2: real light*

4. **Diffuse bounces** in random directions (cosine-weighted), with the sky as a light source. Keep the sun's shadow ray at each bounce ("next-event estimation") so noise stays low. This replaces `ambient`.
5. **Soft sun shadows:** aim each shadow ray at a random point on the sun's disk (about 0.5° wide) instead of its center.
   - Check: color bleeds between nearby surfaces, objects darken where they touch the ground, and shadow edges blur more the farther they fall from the object.

*Chunk 3: boxes, glowing objects and the Cornell box*

6. **Boxes,** with a center, a size and a rotation. Each ray is turned into the box's own coordinates, where the box is axis-aligned, and tested with the "slab" method. The ground plane becomes optional, since a room has its own floor.
7. **Glowing objects:** any sphere or box can give off light, set by an `emission` color and strength in its material.
   - There's no separate light object. The sun stays the one special light, because it's infinitely far away.
   - The renderer keeps a list of glowing objects and aims shadow rays at them ("light sampling"). Rays that only find a small light by chance would make a very noisy image.
8. **The Cornell box,** a small room with a red wall, a green wall and a light panel in the ceiling. It's the standard test for bounce light, and the reference scene for the rest of C1.
   - It's built from the measurements Cornell published. Their original data page now redirects elsewhere (checked 2026-10-29), so the numbers need another source, such as an archived copy.
   - Check: red and green light on the white walls, and soft shadows under the blocks.

*Chunk 4: real materials*

9. **One parameterized material instead of kinds.** It follows glTF's material model, so imported models map straight onto it in Act 2.
   - Parameters: `baseColor`, `roughness`, `metallic`, `transmission`, `ior` and `emission` (from step 7), with defaults so scene files stay short.
   - The path tracer samples each one: matte, rough or smooth metal (GGX microfacet), and glass (refraction with Fresnel).
   - "Checker" stops being a material kind and becomes a pattern on `baseColor`.
10. **A showcase scene** that uses every material: glass, rough and smooth metal, matte, and glowing objects. It shows off lighting and materials; detailed objects come with Act 2's meshes.

*Chunk 5: measuring and explaining*

11. **GPU timing** with the `timestamp-query` feature where the browser offers it, clearly labelled when it doesn't. The HUD shows p50/p95/p99 frame times.
12. *Proposed:* keep the Whitted tracer selectable, to compare the two side by side.
13. The learning note `docs/learn/C1.md`.

**Done when:**
- a still camera converges to a clean image with soft shadows and color bleeding;
- the `ambient` hack is gone;
- the Cornell box shows red and green light bleeding onto its white walls, lit only by its ceiling panel;
- materials are set by parameters, and a partly transparent or rough sphere renders correctly;
- the HUD shows GPU time where it's supported.

### After C1 (candidates, not scheduled)

- **A shared material library** that all layouts can use.
- **Per-scene sun and sky.**
- **Lighting from a photo (HDRI):** light the scene with a 360° HDR photograph of a real place instead of the painted sky gradient.
  - Read the Radiance `.hdr` format directly; it's simple enough to need no library.
  - Aim more random rays at the bright parts, like the sun ("importance sampling"), or the image stays noisy.
  - Poly Haven's HDRIs are CC0, so they can ship with the public demo.
- **Camera effects:**
  - depth of field from a thin-lens camera: each ray starts from a random point on the lens, so things away from the focus distance blur;
  - exposure control;
  - bloom, the glow that bleeds around very bright light.
- **Denoising** while the camera moves.

## Act 2: large scenes that load in seconds

1. **Triangle meshes** in storage buffers, alongside the spheres.
2. **A BVH:**
   - build it on the CPU first, with the surface area heuristic (SAH);
   - flatten it into an array;
   - traverse it in WGSL with a small stack;
   - measure rays per second before and after.
3. **An asset pipeline:** source models live in `assets-src/` (gitignored) and are converted offline into a compact binary format the browser can upload with little parsing. Third-party assets are credited, with their licenses, in the README.
4. **Fast loading:**
   - stream data in chunks and show something early;
   - parse in Web Workers;
   - use compressed textures.
5. *Proposed:* build the BVH on the GPU with compute shaders, once the CPU version is correct and measured.

## Open questions

- **Performance targets:** which hardware, and what frame rate counts as "real time" for path tracing here?
- **Act 2 test scenes:** which large scenes, with licenses that allow redistribution?
- **Hosting:** where the public demo will live (it needs HTTPS for WebGPU).
- **Load-time target:** what "loads in seconds" means as a number, and on what connection.
