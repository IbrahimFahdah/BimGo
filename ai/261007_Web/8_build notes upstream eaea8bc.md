# BimGo Web — build notes, upstream sync to `eaea8bc`

**Ported from:** upstream `develop` @ `eaea8bc` (was `803c1ff`). One upstream commit covering four rounds:
`261010a` BCF + sun hours round 2 (+ daylight build B), `261010b` section box, `261010c` photo mode, `261010d` handoff
notes. The merge commit brings the C# unchanged (Core tests: 235 pass); this note covers the browser port.

## What was ported

| Upstream round | Web files | Notes |
|---|---|---|
| BCF Core (IFC GUID, models, file, mapping) | `core/format/IfcGuid.ts`, `core/format/Bcf.ts`, `core/format/Xml.ts` (new) | Plain BCF 2.1 out (`extensions.xsd`, PNG snapshots, xsi / xsd namespaces), 2.0 / 2.1 / 3.0 in, merge by GUID. A small namespace-agnostic XML reader / writer replaces System.Xml.Linq (DOMParser isn't in Node's test runner; DTDs refused). `deterministicGuid` reproduces .NET's `new Guid(MD5(...))` byte order, so web and desktop give the same project / comment GUIDs |
| Comment pictures, element UniqueId, IFC GUID | `DocumentModels.ts`, `BimGoReader.ts`, `BimGoWriter.ts`, `SceneData.ts`, `Stores.ts` | `comments/<id>.jpg` entries in the `.bimgo`; `elements.json` `ifcGuid`. The comment capture also keeps a ≤ 1280 px JPEG (`setPictures`). The CSV comment export is gone, as upstream |
| BCF in the COMMENTS panel | `game/CommentsBcf.ts` (new), `Menus.ts` | EXPORT BCF… (the shown comments) downloads; IMPORT BCF… picks a file; BCF COORDS cycles shared / project / internal (remembered in the viewer settings) |
| Sun hours round 2 + daylight | `core/scene/SunHours.ts`, `core/scene/Daylight.ts` (new), `core/format/SunStudyFiles.ts` (new), `game/SunHoursStudy.ts`, `game/SunHoursMode.ts` (rewritten) | Modes Sun hours / Daylight % / Lux, PASS / FAIL toggle and steppers, wall-centre fix, mode legends, CSV, SAVE STUDY… / SAVED STUDIES… |
| Section box | `core/scene/SectionCut.ts` (new), `game/SectionMode.ts` (new), `engine/render/SceneRenderer.ts` (section and cap region), shaders | P / Shift+P / Ctrl+P; cuts saved in visibility, bookmarks, comment views and BCF clipping planes; picking skips cut geometry; stencil caps |
| Photo mode | `core/scene/Panorama.ts`, `game/PhotoMode.ts` (new), `FpsCamera.ts` (custom view), `SceneRenderer.applyExposure` | Stills 1–4× and 360° 4K / 8K with Photo Sphere XMP, exposure, FOV, thirds grid, sun time |
| Render split | `game/GameSession.ts` | `renderScene(width, height, framebuffer, photo)` draws into the canvas or a photo target; photo / section / study / sun panel close each other (`closeModes`) |

Shaders regenerated with `web/scripts/port-shaders.py` (CLIP_GLSL, CAP_*, EXPOSURE_FS).

## Browser differences
- **Stencil:** the WebGL context now asks for `stencil: true` (the caps need it on the canvas). Photos render into an RGBA8 + DEPTH24_STENCIL8 renderbuffer target (no MSAA, as everywhere in the web viewer).
- **Files:** BCF, photos, panoramas and study CSVs download; there is no OPEN FOLDER button. IMPORT BCF uses a file input.
- **Saved studies** live in IndexedDB (`bimgo` / `sunStudies`), keyed like `ModelFolders.KeySourceFor` (cloud / local model path / file name), with the desktop's JSON.
- **Cap colour:** `<input type="color">` instead of the Windows colour picker.
- **Live sessions:** sidecars go through the add-in as JSON, so comment pictures stay in memory; snapshot names written by the desktop are kept untouched so the desktop never deletes its pictures.
- **Keys:** P is no longer a pause alias (Esc pauses); Ctrl+P is blocked from the browser's print. Panorama stitching runs in bands on the main thread (a 4K 360 takes a few seconds; 8K longer).

## Sample
`web/scripts/make-sample.mjs` now gives comments GUID ids (a BCF export imports back as "4 unchanged" instead of
duplicates), IFC GUIDs on every element, shared coordinates near Brisbane's grid (BCF viewpoints in shared
coordinates), a fourth comment with the new keys, and a bookmark **Section through the ground floor** with a plane cut.

## Checks
- `npm test` (124 tests; new `tests/bcfround.test.ts`: IFC GUIDs, BCF mapping / merge / coordinates / files incl. a
  BCF 3.0 layout and a damaged topic, XML, comment pictures / IFC GUIDs / cuts through the `.bimgo`, section cuts,
  daylight maths, study settings and an open-floor DF run, saved studies, panorama mapping and XMP), `npm run lint`,
  both type-checks, `npm run build`. C# Core tests: 235 pass.
- Headless Chrome (SwiftShader) on the sample: section editor with gizmo, quick plane opening the south wall with
  dark caps, picking through the cut; photo still (2560 × 1440 PNG) and 4K 360° JPEG with GPano XMP downloaded; all
  three study modes ran (DF ≈ 10.6 %, ~9 000 lux, sun hours), pass / fail, save + load; BCF export → import (merge and
  fresh import); `gl.getError()` 0 throughout.

## Not verified here
- Real GPUs (only SwiftShader), and 8K panoramas on low-memory devices.
- BCF files from other tools beyond the hand-built 3.0 test (the desktop round checked buildingSMART's samples).
- Desktop BimGo opening a web-saved `.bimgo` with comment pictures (same entry names and JSON; not run here).
