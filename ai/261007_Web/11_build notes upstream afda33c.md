# BimGo Web — build notes, upstream sync to `afda33c`

**Ported from:** upstream `develop` @ `afda33c` (was `f19fbf2`). The upstream rounds in between: **grids** A / B (grid
lines, level tags, nodes, minimap, clash grid locations), **colour profiles** A / B (by value / by set / ranges, legend,
hidden rows, ghosts, profile files), **sky / water / grass** (clouds, the night sky and moon, water rules, grass blades),
**clash groups** C-C (groups, grouping tools, HTML / XML reports, setup files, nested rule groups), **polish** P-A1 /
P-A2 / P-B / P-C (the panel shell and docks, the generated F1 sheet, NEW / CHANGED controls defaults, leftovers),
**flythrough** K-A / K-B / K-C (MEDIA panel, camera paths, the 3D path editor, key photos) and **night** W-A. Merged as
`378cb96`; this note covers the browser port and the one add-in change it needs.

## What was ported

| Upstream round | Web files | Notes |
|---|---|---|
| Core (all rounds) | `core/scene/GridData.ts`, `AppearanceProfiles.ts`, `CameraPathTimeline.ts`, `GrassField.ts`, `LunarPosition.ts`, `MaterialOverrides.ts`, `core/clashes/ClashGroups.ts`, `ClashReports.ts`, `ClashSetupFiles.ts`, format models (grids, paths, bookmarks, comments, sun, visibility), `InputCatalog.ts` / `KeyMap.ts` (situations, help entries, defaults version 3) | Same file formats and rules as the C# Core; `tests/sync-afda33c.test.ts` covers them |
| Shaders and renderer | `engine/gl/Shaders.ts` (regenerated), `engine/render/SceneRenderer.ts`, `GridOverlay.ts`, `SunLighting.ts`, `MaterialTextures.ts` | Clouds, night sky / moon / stars, profile pass and ghosts, profile-coloured section caps, grass (also in the reflection probes), grid lines and nodes, the water override |
| Panel shell and docks (P-A1 / P-A2) | `game/PanelShell.ts`, every big panel and dock | Big panels: header, clipped pixel scroll regions, footer ← BACK · actions · CLOSE, notice strip. Docks: right-hand column, scrolling body, footer. On the shell now: comments (list and detail), bookmarks, categories & links, Find Room, family library, textures (and its folder search), CONTROLS, CLASHES, MEDIA, colour profiles. Docks: sun, sun study, section box, grids, clash mode |
| Colour profiles, Appearance (colour A / B, P-C) | `game/ColourProfiles.ts`, `Appearance.ts`, `Menus.ts` (DISPLAY / REFLECTIONS / APPEARANCE tabs) | Shift+C, the legend in the info column / screenshots / photos (scaled for 2–4× stills), hidden rows (their moved copies too), bin methods, BREAKS…, import reconciliation, a profile per bookmark |
| Sky, water, grass | `game/SunPanel.ts` (SKY and NIGHT tabs), `SunState.ts`, `Grass.ts`, `Appearance.ts` | The grass field is built in slices on the main thread after the scene settles (the desktop uses a worker) |
| Grids (A / B) | `game/Grids.ts`, `TeleportGun`, Measure snap, minimap | Grid lines in photos (P-C), grid locations on clash rows and comments |
| Clash groups and tools (C-C) | `game/clashes/ClashGroupUi.ts`, `ClashTools.ts`, `ClashReportUi.ts`, `ClashPanel.ts`, `Clashes.ts` | Auto-grouping, pick points, sphere, box (the section box handles), group cards and pictures, HTML / XML reports and setup files to Downloads (import by file pick, with the reconcile card) |
| MEDIA, paths, key photos (K-A / K-B / K-C) | `game/MediaPanel.ts`, `PathStore.ts`, `Paths.ts`, `PathEditor.ts`, `KeyPhotos.ts`, `Tour.ts`, `VideoMode.ts`, `PhotoMode.ts` | PHOTO / TOUR / PATHS / VIDEO tabs, smooth tours as paths, the sun blend, crouched / profile bookmarks, the 3D editor (Shift+K). Key photos download one file per key |
| Polish P-B | `platform/Hotkeys.ts`, `game/ControlsPanel.ts`, `GameSession.ts` | NEW / CHANGED tags (searchable), the one-time "defaults changed" toast (the version seen is kept in the viewer settings), RESET ALL lists what it changes and asks first, the F1 sheet generated for the current situation (with a gamepad column), A + LB / RB is a chord, not a click |
| Polish P-C small items | `CommentsBcf.ts`, `GameSession.ts`, `Overlays.ts`, `Reflections.ts`, `GunWheel.ts`, `shell/HomeScreen.ts` | Views keep the eye height (GO, BCF export / import), BCF group comments list every member's elements once, right-click closes an open dropdown, probes re-bake on cloud cover / grass changes, "None" in the gun wheel, bookmarks don't carry the profile in their visibility, the trademark line |
| Live paths | `core/live/LiveProtocol.ts`, `core/sources/LiveSessionSource.ts`, `shell/AppShell.ts`; C# `BimGo.Core/Live/LiveProtocol.cs`, `LiveSidecars.cs` | A new `paths` sidecar kind beside `clashes`: the add-in reads / writes `paths.json` with the desktop's files. An older add-in answers "unknown sidecar" and the viewer keeps paths in the session only |

## Browser differences
- **Not ported:** the D-pad focus ring and LB / RB tabs in menus (P-A2 `PadFocus`): the pad cursor and A still work
  everywhere. The window-size layout check (`SetClientSize`) has no browser equivalent.
- The textures folder search has no "remember this folder for all models" (a browser folder handle is per pick).
- Moved / cloned copies are not drawn as profile ghosts (they hide or show with their rows).
- Grids settings ride in `visibility.json` like the desktop; saved studies, the water rule and video settings stay per
  browser.
- Reports, setup files, key photos and videos go to Downloads; imports pick a file.

## Checks
- `npm test`: 248 tests (`sync-afda33c.test.ts` new; clashes / controls / writer / bcf tests updated). `npm run lint`,
  the type-check and `npm run build` pass.
- C#: `BimGo.Core` builds; Core tests 431 / 431 pass; `BimGo.Revit` (Debug R26) compiles with the add-in folder pointed
  at a scratch directory (not installed).
- Headless Chrome (SwiftShader) on the sample through `window.__bimgo`: colour profiles and the legend, grids and
  nodes, MEDIA (photo, tour, paths, video tab), the path editor, clash groups (an "everything" clearance test: 109
  clashes, auto groups by level, a group card, pick / sphere / box tools, the report card, the panel), the section
  dock, the sun study dock, categories / comments / Find Room / library / textures on the shell, CONTROLS with the
  defaults toast and NEW tags (settings with an older defaults version), the F1 sheet per situation and the info
  column. No console errors.

## Not verified here
- The `paths` sidecar against a real Revit (the add-in compiled; not installed this round).
- Real gamepads (chords, the F1 gamepad column) — checked with the code paths only.
- Large models: grass fields, clash grouping and reports on thousands of elements, on a real GPU.
