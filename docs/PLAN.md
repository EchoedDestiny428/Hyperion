# Hyperion plan

> Draft, 2026-10-28. Rebuilt from the code comments and README, because the original plan was lost. Items marked *proposed* aren't decided yet.

**Goal:** a WebGPU tech demo. First, real-time path tracing in the browser. Then, large scenes that load in seconds.

**Long-term target:** a dreamlike space (empty hallways, pools, soft glowing light) that you can walk through in first person and that looks like a photograph. Each milestone moves toward it: C1 makes it look real while you stand still, C2 keeps it real while you move, and Act 2 brings the detail and textures.

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
| C1: path tracer | in progress |
| C2: temporal reprojection and denoising | later |
| Act 2: large scenes | later |

## Act 1: real-time ray tracing

### C0: WebGPU skeleton and a Whitted ray tracer (done)

- Capability checks, recovery from device loss, a canvas sized to real pixels, an orbit camera, and a HUD.
- A full-screen fragment-shader ray tracer: spheres, a ground plane, hard shadows, mirror reflections, ACES tone mapping.
- Scene layouts as data (`src/scene/layouts/`), chosen from a menu or with `?scene=`. Material kinds: diffuse, mirror, checker.

### C1: path tracer (in progress)

**From the code comments:**
- real bounce light, replacing the fake `ambient` term;
- anti-aliasing;
- GPU timing;
- frame-time percentiles in the HUD.

**Steps,** in five chunks. Each chunk ends with something you can check by eye.

*Chunk 1: an image that refines itself (done)*

1. **Random numbers on the GPU:** a per-pixel hash seeded by pixel position and frame number.
2. **Progressive accumulation:** add each frame's sample to a running total per pixel, and show the average. Reset when the camera moves, the canvas resizes, or the scene or layers change.
3. **Anti-aliasing** by shifting each frame's ray slightly within its pixel. Accumulation turns this into smooth edges for free.
   - Check: with the camera still, jagged edges smooth out and the far checkerboard stops flickering.
   - Also built: the `aliasing-test` scene, and panel controls for the sample count (1 to 1,024) and the pace, down to one sample at a time.

*Chunk 2: real light (done)*

4. **Diffuse bounces** in random directions (cosine-weighted), with the sky as a light source. Keep the sun's shadow ray at each bounce ("next-event estimation") so noise stays low. This replaces `ambient`. Paths end by Russian roulette after a few bounces.
5. **Soft sun shadows:** aim each shadow ray at a random point on the sun's disk (about 0.5° wide) instead of its center.
   - Check: color bleeds between nearby surfaces, objects darken where they touch the ground, and shadow edges blur more the farther they fall from the object.
   - Also in chunk 2: the **Renderer menu** keeps the Whitted tracer selectable (decided; it was step 13), replacing the layer switches, and **GPU timing** moved here from chunk 5 (step 12).
   - Known gaps: no caustics, and the painted sky is brighter than a real one next to the sun, so shadows look a little washed out.

*Chunk 3: boxes, glowing objects and a night scene (done, except the Cornell box)*

6. **Boxes,** with a center, a size and a rotation (any angles about x, y and z). Each ray is turned into the box's own coordinates, where the box is axis-aligned, and tested with the "slab" method. The ground plane becomes optional, since a room has its own floor.
7. **Glowing objects:** any sphere or box can give off light, set by an `emission` color and strength in its material.
   - There's no separate light object. The sun stays the one special light, because it's infinitely far away.
   - The renderer keeps a list of glowing objects and aims shadow rays at them ("light sampling"), picking brighter and bigger ones more often. Rays that only find a small light by chance would make a very noisy image.
   - The Whitted renderer treats each glowing object as a single point of light, with hard shadows and no bounce light, for comparison.
   - Also in chunk 3: **per-scene sun and sky** (brightness and color, an early piece of the "per-scene sun and sky" candidate), and a **mirror coat** on matte materials (`reflectivity`), an early piece of chunk 4's materials.
8. **The `neon-night` scene** (instead of the Cornell box, for now): a bright bluish moon (a fifth of daylight), a hot-pink neon sign floating in the sky as the main light, three puddles, a field of 36 small mirror balls, and grey asphalt with a 2% mirror sheen.
   - Check: pink light pooling under the sign, soft shadows behind the balls, the sign reflected in a puddle and faintly in the asphalt.
   - It costs about 16.5 ms of GPU time per sample at 1280×800 on an Intel Iris Xe laptop: every ray is tested against all 40 objects. This is the first scene where a BVH (Act 2) would clearly pay off.
9. **The Cornell box** (deferred): a small room with a red wall, a green wall and a light panel in the ceiling, the standard test for bounce light.
   - It's built from the measurements Cornell published. Their original data page now redirects elsewhere (checked 2026-10-29), so the numbers need another source, such as a reproduction in a well-known open renderer's test scenes.
   - Check: red and green light on the white walls, and soft shadows under the blocks.

*Chunk 4: real materials*

10. **One parameterized material instead of kinds.** It follows glTF's material model, so imported models map straight onto it in Act 2.
   - Parameters: `baseColor`, `roughness`, `metallic`, `transmission`, `ior` and `emission` (from step 7), with defaults so scene files stay short.
   - The path tracer samples each one: matte, rough or smooth metal (GGX microfacet), and glass (refraction with Fresnel).
   - "Checker" stops being a material kind and becomes a pattern on `baseColor`.
11. **A first-person camera:** done early, as a floating "Fly" camera (WASD, Q/E, drag to look, all the way around) next to the orbit camera. Still open: pointer lock for mouse look, walking with gravity and collisions for the dreamspace, and letting each scene choose its starting camera.
12. **The dreamspace room,** the showcase scene and a first step toward the long-term target. It's built from boxes: a tiled room or hallway with a pool, lit by glowing ceiling panels and daylight through an opening. It uses every material: glass or water, rough and smooth metal, matte, and glowing surfaces. Tiles are checker patterns until image textures arrive.
    - Check: standing still inside it, the room refines into an image that could pass for a photo.

*Chunk 5: measuring and explaining*

13. ~~GPU timing~~: done early, in chunk 2. The HUD shows p50/p95/p99 GPU time where the browser offers `timestamp-query`.
14. ~~Keep the Whitted tracer selectable~~: done in chunk 2, as the Renderer menu.
15. Finish the learning note `docs/learn/C1.md`.

**Done when:**
- a still camera converges to a clean image with soft shadows and color bleeding;
- the `ambient` hack is gone;
- the Cornell box shows red and green light bleeding onto its white walls, lit only by its ceiling panel;
- materials are set by parameters, and a partly transparent or rough sphere renders correctly;
- the HUD shows GPU time where it's supported.

### C2: temporal reprojection and denoising (later)

**Goal:** keep the image clean while the camera moves, so you can walk through the dreamspace. C1 makes each sample correct and as low-noise as possible; C2 makes samples last, by reusing them across frames and between neighboring pixels. C1's accumulation is the special case where nothing moved.

**Steps** (first draft):
1. **A G-buffer:** for each pixel, keep the distance and normal of the surface the camera ray hit, next to the running total. The debug views already compute both.
2. **Two history buffers,** swapped each frame: read last frame's, write this frame's. Today's single buffer only works because each pixel reads its own slot; after reprojection, pixels read each other's.
3. **Reprojection:** project each pixel's hit point through last frame's camera to find where it was on screen (its *motion vector*), and read the history there.
4. **Rejecting wrong history:** if the stored distance or normal doesn't match, the surface has just come into view (a *disocclusion*), and that pixel starts over.
5. **Fading history:** blend each new sample in with a minimum weight instead of averaging forever, so lighting changes show within a few frames instead of smearing. Each pixel keeps its own sample count in the history's spare 4th value. Standing still, the image still converges fully, as in C1.
6. **Split the light by what the surface did:** keep matte light (scattered evenly) and mirror-like light (reflections) in separate histories, each with its own rules. Divide out the surface's own color first and multiply it back afterwards ("demodulation"), so filtering smooths only the lighting and never blurs checker edges or textures.
7. **Reflections that move correctly:** a reflection looks like a copy of the object behind the mirror (its "virtual image"), as far behind as the reflected ray is long. Reproject reflections by that virtual point instead of the mirror's surface. Roughness sets how much history and blur they get: almost none for a sharp mirror, as much as matte light for a frosted one. Glass follows the same idea through refraction.
8. **Responding to lighting changes:**
   - direct sunlight is cheap and changes most, so it gets a short history; bounced light is noisy and changes slowly, so it gets a long one;
   - history far outside the range of the current frame's neighboring pixels, allowing for each pixel's noise, is pulled back into that range ("variance clipping");
   - *proposed:* a change map as in A-SVGF (Schied et al., 2018). Re-render a few pixels with last frame's random numbers, so any difference is a real change, not noise, and cut history short only there.
9. **Edge-aware denoising:** blur freshly revealed, noisy pixels with neighbors that show the same surface (similar distance and normal), in a few passes of widening reach, guided by how noisy each pixel is. This is SVGF (Schied et al., 2017), the common baseline for real-time path tracing.
10. **Debug views:** motion vectors, history length, where history was thrown away, and the matte and mirror-like light on their own.
11. *Proposed:* ReSTIR, which reuses *which light was worth sampling* across pixels and frames, for scenes with many glowing objects.
12. The learning note `docs/learn/C2.md`.

**Done when:**
- walking through the dreamspace in first person stays free of heavy noise, with little smearing behind moving edges;
- orbiting the mirror ball doesn't smear its reflections;
- moving the sun or switching a light updates the image within a fraction of a second, without long ghosts;
- standing still converges to the same clean image as C1;
- the debug views show where history was kept and where it was thrown away.

### Candidates for later (not scheduled)

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
- **Prefiltered patterns:** fade a checker pattern toward its average color as more squares fit in one pixel, the way mipmaps do for textures. It removes moiré even with one sample, which helps while moving.

## Act 2: large scenes that load in seconds

1. **Triangle meshes** in storage buffers, alongside the spheres.
2. **A BVH:**
   - build it on the CPU first, with the surface area heuristic (SAH);
   - flatten it into an array;
   - traverse it in WGSL with a small stack;
   - measure rays per second before and after.
3. **An asset pipeline:** source models live in `assets-src/` (gitignored) and are converted offline into a compact binary format the browser can upload with little parsing. Third-party assets are credited, with their licenses, in the README.
4. **Image textures** for color, roughness and surface bumps (normal maps), so the dreamspace gets real tile, carpet and concrete.
5. **Fast loading:**
   - stream data in chunks and show something early;
   - parse in Web Workers;
   - use compressed textures.
6. *Proposed:* build the BVH on the GPU with compute shaders, once the CPU version is correct and measured.

## Open questions

- **Performance targets:** which hardware, and what frame rate counts as "real time" for path tracing here?
- **Act 2 test scenes:** which large scenes, with licenses that allow redistribution?
- **Hosting:** where the public demo will live (it needs HTTPS for WebGPU).
- **Load-time target:** what "loads in seconds" means as a number, and on what connection.
