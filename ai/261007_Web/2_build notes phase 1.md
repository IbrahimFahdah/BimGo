# BimGo Web — build notes, Phase 1 (read and walk)

**Ported from:** upstream `develop` @ `82d901e`. **Test model:** Snowdon Towers Sample Architectural (Revit 2026 export, 10.7 MB). It lives outside the repo in `test-models/`, because it is Autodesk's sample and not ours to publish.

## What was built

| Desktop | Web | Notes |
|---|---|---|
| `System.IO.Compression.ZipArchive` | `core/format/Zip.ts` | Central directory read up front. Entries are inflated with the browser's own `DecompressionStream('deflate-raw')`, with progress and cancel. Supports stored and deflated entries and ZIP64. **No package**, so fflate isn't needed. |
| `BimGoFormat`, `FileModels`, `BimGoReader` | `core/format/*` | Same validation and fallbacks: unknown categories read as generic, out-of-range links read as host, bad index ranges are dropped, damaged materials are ignored, an out-of-range vertex index fails the read, and the user-facing messages are the same. `geometry.bin` is used **in place** (no copy): the vertex block uploads to the GPU as read. |
| Comment / bookmark / sun / visibility models, `EditJournal` | `core/format/DocumentModels.ts`, `core/edits/EditJournal.ts` | Read with the desktop `Clean()` rules. The journal is read but not yet replayed (Phase 4). |
| `SceneData`, `CategoryCatalog`, `LightingData`, `MaterialData`, `ModelInfo`, `LinkInfo` | `core/scene/*` | |
| `System.Numerics.Matrix4x4` | `core/math/Matrix4x4.ts` | Same row-vector layout and multiply order, uploaded as is, so ported formulas stay literal. Only the operations used are ported. **No gl-matrix needed.** |
| `Rendering/Shaders.cs` | `engine/gl/Shaders.ts` | **Generated** by `web/scripts/port-shaders.py`: all 25 shaders, bodies unchanged, with an ES 3.00 header and precisions. Re-run after upstream shader changes. |
| `FpsCamera`, `SceneBatches` | `engine/render/*` | Chunk bounds are flat arrays, so culling allocates nothing. |
| `SceneRenderer` | `engine/render/SceneRenderer.ts` | Classic light, sky, ground and plan (minimap) mode. The sun, AO, lights and materials uniforms are wired but off. Multi-draw uses `WEBGL_multi_draw` when present, and a loop otherwise. |
| `GeoMath`, `Bvh`, `CharacterController` | `engine/physics/*` | **Allocation-free**: triangles and nodes in typed arrays, tests on plain numbers. Same constants, edge riding, step-up and snap-down. |
| `Player`, `GameSession` (+ Render), `ProgressScreen` | `game/*` | Walk, fly, crouch, jump, run, levels (PgUp / PgDn), home (H / Shift+H, in memory), rooms and room banner, minimap, status panel, help, toasts, progress screen with cancel. |

## Decisions and differences

- **Sampler units:** the scene and ground shaders declare shadow, array and 2D samplers even when those features are off. WebGL refuses a draw where two sampler types share a unit, or where a sampler has no valid texture. Every sampler therefore gets its desktop unit (1, 2, 3, 5, 6, 7–10) and a 1×1 placeholder texture of the right kind, including a depth array with compare mode.
- **Pause:** the browser takes Esc to release the mouse, so losing the lock opens the pause menu, and P toggles it too. If a browser also delivers that Esc keydown, it is ignored in the same frame so the pause doesn't immediately undo itself.
- **Pause menu:** a stand-in until Phase 2, with RESUME, VIEW (Whitecard / Material colour, saved per browser) and CLOSE MODEL.
- **Help panel:** lists only the keys that work so far.
- **Home:** Shift+H sets the home in memory only. Saving it into the file comes with Phase 4 (saving).
- **`?model=<url>`** opens a model by link, **same origin only**. This is for sample links and for automated testing. In dev, `/BimGo/@fs/<path>` serves the local `test-models/` folder (`vite.config.ts` `server.fs.allow`).
- **Errors** thrown mid-frame close the walkthrough and show the reason on the home screen, instead of freezing the canvas.

## Measured (Snowdon: 949k vertices, 738k triangles, 7,800 elements, 18 levels, 54 rooms)

| Step | Time |
|---|---|
| Read + inflate (Node) | ≈ 0.4–0.6 s |
| Batches | ≈ 30 ms (931 chunks) |
| BVH | ≈ 1.0–1.6 s (524k nodes) |
| Physics tick | ≈ 0.23 ms (120 Hz budget ≈ 8 ms) |

- Headless Chrome (SwiftShader, CPU only) opens Snowdon and shows the facade, sky, ground grid, minimap plan, HUD and level toast. It runs at about 10 fps there, which says nothing about a real GPU.
- Tests: 30 pass. They cover the reader (synthetic ZIPs plus Snowdon), matrices, the camera, GeoMath, the controller on a synthetic floor, and a 5 s Snowdon walk that stays grounded.
- Dependencies: only `@types/node` was added (dev, types for the Node-based tests). Runtime still has **zero packages**.

## Not done yet / to check

- **Real GPU:** fps on a mid-range laptop (Phase 1's done-when is 60 fps or more).
- Pointer-lock mouse look and Esc/P in a real browser. Headless can't lock the mouse.
- Firefox (no `WEBGL_multi_draw`: the loop fallback) and Safari.
- **BVH build on the main thread:** about 1–1.6 s of blocked frames during "Preparing". A Web Worker could do this later if large models make it worse.
- Saved journals aren't replayed yet, so models with edits show the untouched geometry. The opening toast says so.
