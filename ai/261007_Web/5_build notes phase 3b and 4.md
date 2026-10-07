# BimGo Web — build notes, Phases 3b (realistic materials) and 4 (editing and saving)

**Ported from:** upstream `develop` @ `82d901e`.

## Phase 3b: what was built

| Desktop | Web | Notes |
|---|---|---|
| `Rendering/MaterialTextures.cs` | `engine/render/MaterialTextures.ts` | Material table on unit 6 and texture arrays on units 7–10 (grouped by size). Images decode asynchronously with `createImageBitmap`, so the model is walkable before its textures arrive. |
| `Rendering/ProxyPack.cs` | `engine/render/ProxyPack.ts` + `public/proxies/` | The 21 CC0 proxy JPEGs and `proxies.json`, copied unchanged from `BimGo.App/Resources/Proxies` and loaded on demand. |
| `Scene/ProxyCatalog.cs` | `core/scene/ProxyCatalog.ts` | Automatic proxy choice by material name and class. |
| `Scene/TextureSearch.cs` | `core/scene/TextureSearch.ts` | Folder search uses `showDirectoryPicker` (Chrome / Edge). Other browsers can still pick single images. |
| `GameSession.Textures` | `game/Textures.ts` | TEXTURES panel: missing / proxy / all filters, pick image, pick proxy, UNDO, folder search. Picked images are stored in the file on save. |
| `SceneRenderer` realistic path | `engine/render/SceneRenderer.ts` | `uRealistic`, `uReflections` (glass and polished floors reflect the sky colours), `uTintMode` (Revit tint), material and UV streams. |

## Phase 4: what was built

| Desktop | Web | Notes |
|---|---|---|
| `Physics/DynamicSet.cs` | `engine/physics/DynamicSet.ts` | Moved and cloned instances: picking (ray into source space), and triangles for the character controller. |
| `CharacterController` dynamics | `engine/physics/CharacterController.ts` | You collide with moved and cloned elements. |
| `SceneRenderer` dynamic pass | `engine/render/SceneRenderer.ts` | One shared index buffer for dynamic copies; drawn in the opaque, transparent, shadow, AO, light-shadow and minimap passes. |
| `Guns/HammerGun.cs`, `GizmoController.cs`, `GizmoGun.cs`, `CloneGun.cs`, `GizmoPanel.cs` | `game/guns/EditGuns.ts` | Tools 6–8: DEMOLISH, GIZMO and CLONE. |
| `Edits/EditMessages.cs`, `Sources/FileEditSource.cs` | `core/edits/EditMessages.ts`, `core/sources/ModelSource.ts` | `ModelSource` is the interface the Phase 5 live link implements. |
| `GameSession.Edits` / `.Document` | `game/GameSession.ts` | Optimistic edits, journal record and replay, undo / redo, dirty tracking, Save / Save As. |
| `Format/BimGoWriter.cs` | `core/format/BimGoWriter.ts` + `ZipWriter.ts` | Same entries and JSON shapes as the desktop: camelCase, nulls omitted, float32 values in shortest form. Geometry is written byte-for-byte as read. Uses CompressionStream with a slicing-by-8 CRC-32. |
| `GameSession.Lights` (moved fixtures) | `game/Lights.ts` | Moved and cloned light fixtures carry their light, keyed per instance so their shadow maps cache correctly. |

## Keys

- **6 · 7 · 8** select DEMOLISH, GIZMO and CLONE.
- **DEMOLISH:**
  - Left-click primes an element; left-click it again to demolish it. Right-click unprimes.
  - **T** toggles delete mode.
  - Demolish follows the desktop's phase rules: existing elements only. New work, clones and unphased elements must be deleted instead.
- **GIZMO / CLONE:**
  - Left-click locks on (or makes the clone); right-click commits.
  - **Esc** cancels and puts the element back. In the browser, Esc also releases the mouse, but it does not pause here.
  - **WASD** moves, **E / Q** raise and lower, **R** switches to rotate (then **A / D** turn).
  - **Shift** moves finely. **G** toggles snapping, and holding **Ctrl** flips it. **Z / X** step the increment.
- **Ctrl+S** saves, **Ctrl+Shift+S** saves as, **Ctrl+Z** undoes and **Ctrl+Y** (or **Ctrl+Shift+Z**) redoes.
- **Pause menu:** SAVE (shows **\*** when there are unsaved changes) and SAVE AS. The footer shows the edit count and "unsaved changes".

## Browser-specific decisions

- **Save:**
  - **In place:** a file opened with the Open dialog in Chrome or Edge has a File System Access handle. SAVE asks for write permission once, then overwrites it.
  - **No handle** (Firefox, Safari, drag-and-drop, or `?model=` links): SAVE opens the Save picker where available, and otherwise downloads the file.
  - **SAVE AS** always picks a new file, or downloads one.
  - The location is chosen before writing, while the click or key press still counts as a user gesture.
  - Cancelling the progress screen aborts the writable, so the file on disk is left unchanged.
- **Unsaved changes:**
  - The tab title shows **\***.
  - Closing or reloading the tab asks first (`beforeunload`).
  - CLOSE MODEL asks "Close without saving?". Cancel keeps you in the model so you can save.
- **What counts as a change:** edits, comments, bookmarks (including home), sun settings, visibility (hidden elements, categories and links) and texture changes, as on the desktop.
- **Journal user name:** the viewer's name setting ("Web user" by default).
- **Dev-only hook:** `window.__bimgo` exists only on the Vite dev server, for automated browser checks; production builds strip it.

## Verified

- Lint, type-check and 79 tests pass.
  - New writer tests: CRC-32, shortest float32 output, a full round trip of every entry, and a Snowdon-with-materials round trip (geometry, materials, UVs and textures identical).
  - The build is 319 kB (106 kB gzip).
- Headless Chrome, Snowdon (a script calling the tool methods directly, because headless has no pointer lock):
  - Deleting a wall also hid the door it hosts: "Deleted: Core - Concrete 12" + 1 dependent element".
  - A column moved 1 m and turned 0.5 rad; a clone of it was placed 2 m away.
  - Undo removed the clone; redo put it back.
  - The title showed **\*** until saved. Save produced a 10.3 MB file and cleared the **\***.
  - Reopening the saved file replayed all 3 edits: same hidden count, same offsets and angles.
  - With the column category isolated, the moved column and its clone render and pick correctly.
- **Not tested headless:** pointer-lock mouse use of the tools, the Save picker and in-place overwrite. These need a real browser.

## For Phase 5

- `ModelSource` (`core/sources/ModelSource.ts`) is the seam for the live link: `LiveSessionSource` implements `submit` / `takeResult` / `pump`, with `isRevit = true`.
  - The tools already word their messages for Revit when `editsGoToRevit` is true.
- Undo and redo are file-only on the desktop ("undo in Revit, then F5"). The live source should block them in the same way.
- Building the add-in's Debug configuration copies it into `%AppData%\Autodesk\Revit\Addins`. Ask before doing that: the user's installed BimGo add-in lives there.
