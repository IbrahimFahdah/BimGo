# BimGo: handoff for Round K, build K-C (after K-A and K-B)

**Context:** BimGo is Gavin's personal project:
- publisher **Aussie BIM Guru**, licence **MIT-0**;
- C# / Visual Studio, .NET 8;
- its own OpenGL renderer over Silk.NET;
- a Revit add-in (`BimGo.Revit`), a standalone app (`BimGo.App`) and `BimGo.Core`.

How Gavin works:
- **Rounds:** discuss → AskUserQuestion (recommended option first and marked, at most 4 questions per call) → build → zip.
- **Notes:** each build gets `ai/<yymmdd><letter>_<topic>/` (`0_brief.md`, `1_build notes.md`), a README §8 to-verify
  entry (§8 holds only the open build: drop the previous one once Gavin confirms it), a §9 row, and a project doc
  `claude/BimGo_<Round>_BuildNotes.md`.
- **Each build says what is in, what isn't, and how to check it step by step.**
- Simple build or test errors: he wants **just the fix** (find the cause, fix, re-zip, say it in a few lines).
- He folds requests in mid-build. "Assume recommended options" when he's away. He likes the README kept compact.
- **Ask for a fresh zip of his working copy before editing** (it carries his compile fixes). K-A and K-B needed none.

## 1. Where things are (2026-10-18)

| Build | Folder / project doc | State |
|---|---|---|
| Roadmap brief | `261017j_Handoff`, `claude/BimGo_Roadmap_Polish_Flythrough_Brief.md` | Round P done; Round K: K-A, K-B built, **K-C next**; then Round W (weather), Round X |
| Round K handoff (answers) | `261018d_Handoff` §2b, `claude/BimGo_RoundK_Handoff.md` | The agreed Round K design |
| K-A: MEDIA panel + camera paths | `261018e_Flythrough_KA`, `claude/BimGo_Flythrough_KA_BuildNotes.md` | Confirmed ("all good") |
| K-B: 3D path editor | `261018f_Flythrough_KB`, `claude/BimGo_Flythrough_KB_BuildNotes.md` | Built; one test fix after (below); Gavin happy ("amazing work"): **drop its README §8 entry in K-C once he confirms the tests pass** |
| This handoff | `ai/261018g_Handoff/0_handoff.md`, `claude/BimGo_RoundK_KC_Handoff.md` | |
| **K-C** | next: `261018h_Flythrough_KC` (or the next day's letter) | Stage its questions, then build |

**K-B test fix:** `ControlsTests.Gamepad_StoredApartFromKeys` assigns pad RB+A to Fly without a swap (it assumes RB+A is
free while walking). K-B had given the path editor RB+A, so the assign was refused. The editor now has **no** pad default
(gamepad: MEDIA → PATHS → EDIT IN 3D, DONE). **Lesson:** before giving a new action a gamepad default, grep the tests
for chords they assume are free (RB+A, LB+Y…).

## 2. What Round K has built

**K-A** (MEDIA panel, `GameSession.Media.cs`; paths, `GameSession.Paths.cs`, `PathStore.cs`; Core
`Format/CameraPathModels.cs`, `Scene/CameraPathTimeline.cs`):
- MEDIA (pause menu, Shift+M): tabs PHOTO (photo settings, OPEN PHOTO MODE) · TOUR (tour settings, moved from
  BOOKMARKS) · PATHS (list + editor) · VIDEO (source tour / path, size, rate, RECORD).
- Camera paths (`paths.json` in the `.bimgo` / model folder): centripetal Catmull-Rom with smoothness per path / key,
  constant speed (arc length, Simpson + Newton), smoothstep ease ramps, holds, fades, loop; heading follow-the-path
  (look-ahead, level) with per-key own view / look-at blending over half segments; key sun (interpolated between keyed
  neighbours, segments blend) and colour profile (switches at a key, carries on).
- **One player:** `ITourTimeline` (Count, Duration, StartOf, StopAt, Pose) implemented by `TourTimeline` and
  `CameraPathTimeline`; `GameSession.Tour` (`SaveWalkthroughForTour`, `BeginTour(timeline, records, run, path)`) plays
  either; a path's keys play as synthetic `BookmarkRecord`s (name, sun, colour profile). Video: `StartVideo(path)`.

**K-B** (`GameSession.PathEditor.cs`): the 3D editor (Shift+K, or MEDIA → PATHS → EDIT IN 3D): clash-mode style dock,
free cursor, own fly actions (WASD, E / Q, Shift fast; ← / → snap keys); path drawn (red where it hits visible static
geometry), chevrons, numbered keys, view lines, targets; K adds (scrubber spot / into the nearest segment within 1 m /
after selected), Del, ← / → snap, Enter SET, click picks key or target; X / Y / Z handles (5 cm, Shift free) and a
view handle (5°); PICK THE TARGET; scrubber drives the camera, Space previews; Ctrl+Z (snapshots, 40). Core added
`CameraPathTimeline.Nearest`, `SegmentAt`, `TimeAtDistance`; `CameraPath.Snapshot / CopyFrom`, `CameraKey.Snapshot`.
Inputs: `DEFAULTS_VERSION` 3 (`PathEditMode` Shift+K; `PathSetKey`, `PathMove*`, `PathFlyUp/Down`, `PathFlyFast`,
`PathUndo`); `SIT_PATH` live.

## 3. K-C: the agreed scope (handoff §2b) and what to ask

**Scope:** the tour as a path type (one player: a tour is a path whose keys are the bookmarks; **SMOOTH** plays it as a
spline; **CONVERT TO PATH** copies it into free keys); photo / video links (**a key as a photo**, a path or tour as a
video: the VIDEO tab already records either); **sun animation polish**.

Questions to stage (recommended first; check the code before asking):
1. **SMOOTH tour**: a TOUR-tab setting "Between stops: Fade · Glide · Smooth" (Smooth = a `CameraPathTimeline` built
   from the ticked bookmarks: holds from the tour's hold, swivel as a key-view blend or dropped, speed from a new tour
   setting) vs a separate PLAY SMOOTH button.
2. **CONVERT TO PATH**: copy the ticked bookmarks into a new path (keys = bookmark eyes and views, hold, sun, profile;
   heading Key views or Follow?), name "<model> tour", open it in PATHS / the 3D editor.
3. **A key as a photo**: from the key (dock / PATHS: PHOTO AT THIS KEY: snap, open photo mode with the key's sun and
   profile applied) vs batch (PHOTOS OF ALL KEYS with the PHOTO settings: stills / 360s into a folder, Round X's batch
   stills come early).
4. **Sun polish**: the editor's preview with sun / profile / fades (as PLAY PATH), a sun-time row on the key in the
   3D dock, a "sun along the path" strip on the scrubber (time-of-day under the keys), sun date blending across years?
   Also: bookmarks → path keys keep section / visibility? (CameraKey has no section / visibility / FOV yet: optional
   fields, additive).

Code pointers for K-C:
- Tour: `GameSession.Tour.cs` (`StartTour` builds `TourStop`s and calls `BeginTour`; `BlendTourSun`, `ApplyTourStop`,
  `SetSunQuiet`, `SetSectionQuiet`); `TourSettings` / `TourTransition` in Core `BookmarkModels.cs` (enum: add `Smooth`
  only if older builds never see it: `JsonStringEnumConverter` throws on an unknown value, and `bookmarks.json` is read
  with `ReadJson` (not `ReadOptionalJson`), so an older build would fail to open the file. Prefer a separate optional
  field such as `smooth: true` / `smoothSpeed` on `TourSettings`).
- Paths: `GameSession.Paths.cs` (`PathPoints`, `PathTimeline`, `StartPath`, `SunForKey`), `PathStore` (`AddPath`,
  `AddKey`, `Touch`), PATHS tab UI `BuildPathsTab` / `BuildKeyEditor`.
- Editor preview: `GameSession.PathEditor.cs` (`PlacePathCamera`, `AdvancePathPreview`: camera only today).
- Photo: `GameSession.Photo.cs` (`OpenPhotoMode`, `RequestPhoto`, `TakePhoto`, `RenderPhotoView(…, legendScale)`,
  `PhotoPath`); MEDIA PHOTO tab `BuildPhotoTab`.
- Video: `GameSession.Video.cs` (`StartVideo(CameraPath)`), MEDIA VIDEO tab `BuildVideoTab` (source list).

## 4. Things to watch
- **Compiling:** no .NET SDK in the sandbox (nuget / dotnet hosts blocked; pip / npm can't reach tree-sitter): say so.
  Script-check brackets, strings (incl. interpolation holes) and `'\uXXXX'` char literals, new member names across the
  `GameSession` partials, type-name clashes between `Format`, `Scene`, `Physics` and the app, and UI strings against the
  font atlas (Latin-1 + `UiFont.EXTRA`: `Δ − — – … • ↑ ↓ ← → “ ” ’ ≈ ≤ ≥ ‹ › ↔`). Port new maths to Python and check it
  (as for `TourTimeline` and `CameraPathTimeline`).
- **Inputs:** a new default raises `InputCatalog.DEFAULTS_VERSION` (now 3) and adds `DefaultsChanges` rows; update README
  §3 by hand to match `KeyMap.DefaultsMarkdown` (or let `Readme_ControlsTablesAreCurrent` regenerate it); keep every
  situation clash-free (exact chords; `Shift` bare counts) and its F1 rows ≤ 16 and live; never rename an `InputAction`.
  A binding without modifiers fires with extra modifiers held unless a live binding uses that key with them.
- **Name clashes:** `InputState` (`using BimGo.Platform;`); `DB.` qualifiers in BimGo.Revit; colour profiles are
  `AppearanceProfile`; `Guns.Gun` from `GameSession` partials; `RayHit` is `BimGo.Physics`.
- **Encodings:** keep them (some files have a BOM, e.g. `InputCatalog.cs`, `Player.cs`; most don't; the Revit
  template files have CRLF: leave them). New files: LF, no BOM.
- **Compatibility:** additive only (`.bimgo` 1, `paths.json` 1, `clashes.json` 1, live protocol 1; settings migrate in
  `LaunchSettings.Sanitise`). Unknown enum strings throw in System.Text.Json: add fields, not enum values, to
  existing files.
- No per-frame allocations; labels cached (`KeyHint`, `PathStatsLabel`). Path timelines rebuild only when
  `PathStore.Revision` changes (drags count changes with `save: false`, write on release via `Touch`).

## 5. After K-C
- **Round W**, weather and atmosphere: night sky (moon on / off, moonlight brightness slider, procedural stars with
  controls like the clouds); rain on / off with falling rain and drops hitting the screen now and then.
- **Round X:** sun time-lapse + batch stills (X-A); sequence playback ("4D-lite") and two-way Revit camera sync (X-B).
- Later: find element search, accessibility checks, travel-distance tape, kiosk launch, profile schedule CSV, OpenXR VR,
  IFC import, occlusion culling / LOD, multiplayer.
