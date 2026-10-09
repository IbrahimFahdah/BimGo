# BimGo Web — build notes, upstream sync to `803c1ff`

**Ported from:** upstream `develop` @ `803c1ff` (was `82d901e`). Two upstream commits: `1b30df4` (reflection probes,
water, UX cleanup) and `803c1ff` (sun hours, comments as issues, family library). The merge commit brings the C#
unchanged; this note covers the browser port.

## What was ported

| Upstream round | Web files | Notes |
|---|---|---|
| Reflection probes, build A (tiers, water, debug colours) | `engine/gl/Shaders.ts` (regenerated with `scripts/port-shaders.py`), `engine/render/MaterialTextures.ts` (texel 5), `core/scene/MaterialData.ts`, `core/format/BimGoWriter.ts` | `shine`, `roughness`, `metallic`, `water`, `waterBump`, `reflectSource` read and written; defaults left out on write as on the desktop |
| Reflection probes, build B + leak fixes | `engine/render/ReflectionProbes.ts` (new), `engine/render/SceneRenderer.ts`, `game/Reflections.ts` (new) | Same placement, lookup grid, open-boundary blending and progressive bake. Units 11–13 always carry a placeholder. **WebGL difference:** the mip blits draw into a colour-only framebuffer (WebGL rejects attachments of different sizes; desktop GL accepts the depth buffer left attached) |
| UX cleanup A | `game/GameSession.ts`, `game/QualityProfiles.ts` (new), `game/Menus.ts`, `game/ViewerSettings.ts` | Hide UI (U), important toasts, quality profiles, right column tabs. The browser has no MSAA, so profiles don't set anti-aliasing (otherwise the same values) |
| UX cleanup B (Options tabs, model folders) | none (Revit and desktop only) | The browser's live sidecars go through `LiveSidecars`, which now writes into the model folder like the desktop; it also cleans comment issue fields |
| Next round: probe leaks, drop to surface, family library, Place gun, ground offset | `game/guns/EditGuns.ts` (`dropToSurface`, aim + F, `PlaceGun`), `game/LibraryPanel.ts` (new), `core/scene/FamilyLibrary.ts` (new), reader / writer, `engine/render/SceneBatches.ts`, `engine/physics/DynamicSet.ts` | Templates never batched, picked or collided; `place` journal entries replay; previews decoded with `createImageBitmap` |
| Comments as issues | `core/format/DocumentModels.ts`, `game/Stores.ts`, `game/Menus.ts`, `game/guns/CommentGun.ts` | Status, priority, assignee, replies, saved view, thumbnail; list filters, detail view, text boxes over the menu |
| Find room | `game/RoomFinder.ts` (new) | Ctrl+F is now blocked from the browser's own find |
| Sun hours | `core/scene/SunHours.ts`, `game/SunHoursStudy.ts`, `game/SunHoursMode.ts` (new), `engine/physics/Bvh.ts` (glass flag) | 10 ms per frame on the main thread, as on the desktop. Screenshot = Shift+F12 or the panel's SCREENSHOT (to Downloads) |

## Fixed on the way
- The UI font atlas had no `‹ › ≥` (sun hours date buttons and summary). Added to the web atlas. **The desktop atlas
  (`BimGo.App/Rendering/UiFont.cs`, `EXTRA`) has the same gap**: upstream should add them too.
- Letters typed into the Find room and library search boxes no longer act as shortcuts (P paused the menu).

## Checks
- `npm test` (92 tests, new `tests/nextround.test.ts`: library read / write and validation, `place` journal and
  protocol, comment issue cleaning, ground offset, reflection fields, quality profiles, sun directions and legend,
  room containment), `npm run lint`, both type-checks, `npm run build`.
- Headless Chrome (SwiftShader) on a generated model with shiny, metal, water and glass materials, rooms and a library
  template: no WebGL errors after the blit fix; probes placed and baked (11 in 3 s); pause menu tabs, comments list,
  GO, Find room, sun hours grid and run, library panel with preview, Place gun holding a desk.
- C# Core tests: 192 pass on the merged tree.

## Not verified here
- Real Revit exports with reflectivity and a family library (the add-in side is upstream's and unchanged).
- Committing a placement live against Revit (needs the add-in; same `place` op as the desktop).
- Probe bake time and FPS on real GPUs (only SwiftShader here).
