# Round K, build K-A: MEDIA panel and camera paths (2026-10-18)

Built on `BimGo_Polish_PC` (Gavin's working copy). **Not compiled here** (no .NET SDK): build first, then the Core tests.

Checked by script:
- Brackets, strings (incl. interpolation holes) and char literals in every changed `.cs` file.
- New member names declared once across the `GameSession` partials; no type-name clash between `Format`, `Scene` and the app.
- UI strings against the font atlas (Latin-1 + `UiFont.EXTRA`).
- Encodings kept (BOMs as they were, LF; new files without a BOM).
- The path maths in a Python port of `CameraPathTimeline` (28 checks): continuity at 120 Hz, constant speed (cruise within
  1 %, a loop exactly 1.5 m/s), eases, holds, look-at, follow (level and not), loop closure (position and heading), sharp
  corners straight, a round path bulging, short segments, a turn on the spot, key view to key view, the sun blend.

One new key: **Shift+M** opens MEDIA (`InputAction.MediaPanel`, `DEFAULTS_VERSION` 2 with a `DefaultsChanges` row, so
users get the one-time toast and a NEW tag). README §3 updated by hand to match the generator (the Tools table's new
row, the tour group's new name and note): if `ControlsTests.Readme_ControlsTablesAreCurrent` reports Inconclusive, commit what
it wrote.

## In

### MEDIA panel (`GameSession.Media.cs`)

| Item | What it does |
|---|---|
| **Opening** | Pause menu → **MEDIA** (under BOOKMARKS), or **Shift+M** while walking (opens on the tab it showed last). Wide panel on the shell; tabs in the header (LB / RB on the gamepad); ← BACK / Esc to the pause menu. |
| **PHOTO** | Photo mode's settings (still / 360°, size, format, field of view, exposure, thirds grid, grid lines): the same fields photo mode's panel shows. Footer: OPEN FOLDER, **OPEN PHOTO MODE (M)**. M still goes straight to photo mode. |
| **TOUR** | The tour settings and per-stop overrides, moved out of BOOKMARKS unchanged (minus the video block). Footer: RECORD VIDEO, PLAY TOUR. BOOKMARKS keeps PLAY TOUR; its **TOUR SETTINGS** opens MEDIA → TOUR. |
| **PATHS** | Camera paths, list + editor (below). Footer: RECORD VIDEO, **PLAY PATH** (two keys or more). |
| **VIDEO** | Source list (the bookmark tour, each path; with stops / keys and length), size (Window / 1080p / 4K) and rate (30 / 60), a summary (frames, length, HUD or clean per the source's own setting, one lap for a loop), the last video. Footer: OPEN FOLDER, **RECORD VIDEO**. After a recording MEDIA → VIDEO opens with the result. |

### Camera paths

| Item | What it does | Where |
|---|---|---|
| **Model** | `CameraPath` (name, keys, speed, smoothness, heading, look-ahead, level, fade, UI, loop; `Clean`, `EasesAt`, `Copy`), `CameraKey` (eye in Revit internal metres, yaw / pitch, optional heading, look-at target, smoothness, speed, hold, ease, sun, colour profile), `CameraPathDocument`, `CameraPathFiles`. Optional fields left null use the path's. | Core `Format/CameraPathModels.cs` |
| **Storage** | `paths.json` inside the `.bimgo` (written only when there are paths; `formatVersion` stays 1) and in the live model folder (`<model>.bimgo-paths.json` beside an older snapshot; mirrored when sharing is on). Saving a file marks it dirty like bookmarks. | `BimGoFormat`, `BimGoReader` / `Writer`, `BimGoDocument.Paths`, `ModelFolders.PATHS_FILE`; App `PathStore.cs`, `GameSession.Document.cs` |
| **Timeline** | `CameraPathTimeline : ITourTimeline`. Shape: centripetal Catmull-Rom tangents per key, Hermite segments, each key's tangent × its smoothness (0 = a sharp corner, straight runs). Speed: constant along the curve (48-sample arc-length table per segment by Simpson's rule, then two Newton steps). Easing: a smoothstep velocity ramp (speed / 1.5 m/s², 0.4–4 s) at a key that eases (it holds, it is an end of a non-loop, or it is set on); a short segment reaches a lower top speed. Time: fade in → key 0 hold → segment → … → last key hold → fade out; a loop adds the last → first segment, no fades. Two keys at one place turn on the spot (1.5 s). | Core `Scene/CameraPathTimeline.cs` |
| **Heading** | Follow (default): looks at the point `LookAhead` m ahead along the path, so it turns before a corner; **Level** keeps the horizon flat (off: pitches with climbs). A key with **own view** or **look at** (a target point) takes over near itself: over the half segment before and after it; between two such keys over the whole segment (view to view). | Same |
| **One player** | `ITourTimeline` (Count, Duration, StartOf, StopAt, Pose): the bookmark tour (`TourTimeline`) and a path both play through `GameSession.Tour` (save / restore of player, sun, cut, visibility, eye height, UI, colour profile; Space / ← → / Esc; the HUD bar says "PATH · KEY n / m" and the path's name) and record through `GameSession.Video` (`StartVideo(path)`; file `<model> path <name> <time>.mp4`). | App `GameSession.Tour.cs` (`SaveWalkthroughForTour`, `BeginTour`), `GameSession.Video.cs` |
| **State along a path** | A path's keys play as records: the **sun** animates (a key without a sun takes one interpolated between its keyed neighbours by time; segments blend with P-C's tour blend; shadows come on for keyed suns), the **colour profile** switches at a key and carries on until another key changes it. | `GameSession.Paths.cs` (`StartPath`, `SunForKey`) |
| **PATHS tab** | Left: NEW PATH, the paths (keys · length · time · loop), RENAME… / DUPLICATE / ↑ ↓ / DELETE (SURE?). Right: the strip (speed, smoothness, follow path / key views, look ahead, fade, level, loop, show UI, the summary); the keys (ADD KEY HERE: the view you left, after the selected key; rows say hold / eases / own speed / heading / sun / profile); the selected key's editor (RENAME…, SET TO THIS VIEW, GO TO, ↑ ↓, DUPLICATE, DELETE, hold, speed and smoothness (own values bright, × back to the path's), ease auto / on / off, heading path / follow / own view / look at with SET TARGET: AIMED (the surface aimed at when the panel opened, else 10 m ahead), sun (USE THE SUN NOW, −30 / +30 MIN, ×), colour profile (leave / none / each profile)). | `GameSession.Paths.cs` |
| **Fly + snap (lists)** | GO TO closes the panel and flies you onto the key (fly mode, same view); fly to adjust, Shift+M → SET TO THIS VIEW. ADD KEY HERE works the same way from wherever you flew. (K-B adds the 3D path and the in-flight keys.) | Same |

### Tests (+11)
`CameraPathTests`: `Continuity_NoJumpsAndASmoothHeading`, `ConstantSpeed_AlongTheCurveAndAroundALoop`,
`Ease_StartsAndStopsGentlyAndShortSegmentsSlowDown`, `Holds_StopAtTheKeyAndSeekToIt`, `Fades_AtTheEndsOnly`,
`Follow_LooksAlongThePathLevelOrNot`, `KeyViews_BlendInAndOut`, `Shape_SharpIsStraightRoundBulges`,
`SunBlend_FollowsTheSegmentAndThePoseStandsOnTheEye`, `Document_CleansAndRoundTrips`, `Bimgo_KeepsPathsAndLeavesThemOutWhenNone`.

### README
§3 (Shift+M row; "Bookmark tour and camera paths" group; notes), §4 files, pause menu line, §5 new **Media panel and
camera paths** bullet and the video bullet, §6 `paths.json` row and model folders, §8 (P-C's entry dropped as confirmed;
K-A's to-verify; a camera paths limitation; Round K roadmap: K-B / K-C), §9 row.

## Not in (K-B / K-C)
- The path drawn in 3D (line, key markers, direction ticks, red through geometry), K / ← / → in flight, the gizmo on a key,
  the scrubber, inserting a key on the nearest segment. `InputContext.PathEditor` is still unused.
- Tour as a path type (SMOOTH, CONVERT TO PATH), a key as a photo, sun animation polish.
- Per-key FOV, section or visibility (the model is open to them: optional fields).
- A blend length for own-view / look-at keys (fixed at half a segment).

## Things to look at when building
- `ITourTimeline` is new in Core `Scene/CameraPathTimeline.cs`; `TourTimeline` implements it (`Pose`).
- `GameSession._tour` is now `ITourTimeline`; `StartTour` lays out the stops and calls `BeginTour`.
- `_tourSettingsOpen` / `ToggleTourSettings` are gone (the view lives in MEDIA → TOUR: `ResetTourSettingsView`).
- `GameSession.CameraPaths` (a `PathStore`) is created in `InitialisePaths()` beside `InitialiseBookmarks()`.
- C# features used: target-typed `?:` and switch expressions to `bool?` / `CameraHeading?`; local functions capturing
  locals (no allocation).

## How to check
1. **Build**, then the **Core tests** (all pass; `ControlsTests` may regenerate README §3: commit it).
2. **Shift+M** while walking opens MEDIA (on PATHS the first time); Esc goes back to the pause menu; the pause menu has
   MEDIA under BOOKMARKS. CONTROLS shows "Media panel" NEW; a one-time toast mentions the changed defaults.
3. **PHOTO:** change the size / format / exposure, OPEN PHOTO MODE → photo mode with the same settings; M still opens it.
4. **TOUR:** the tour settings as before (transition, hold, swivel, UI, loop; per-stop overrides on the right); PLAY TOUR
   plays; BOOKMARKS → TOUR SETTINGS opens this tab.
5. **A path:** PATHS → NEW PATH. Fly (V) to a start point, Shift+M → ADD KEY HERE; fly on, Shift+M → ADD KEY HERE (×4,
   round a corner). The summary shows keys · length · time. PLAY PATH: fades in, glides through the keys at a steady speed,
   turns before the corner, fades out; Esc mid-way returns you where you were.
6. **Smoothness:** path smoothness 0 % → sharp corners; 100 % → round. A key's own smoothness (×, back to the path's).
7. **Speed and holds:** speed 3 m/s → shorter; a key hold 2 s → the camera slows in, stops 2 s, slows out. Ease OFF on an
   end key → it starts at speed.
8. **Heading:** a key "Own view": GO TO, look somewhere, Shift+M → SET TO THIS VIEW; play → the camera turns into that view
   near the key and back out. "Look at": aim at a column, Shift+M → SET TARGET: AIMED; play → it watches the column at that
   key. Path "Key views" → every key's own view, view to view. Untick Level → the camera pitches on a stair run.
9. **Sun:** shadows on; key 1 USE THE SUN NOW at 9:00, last key at 17:00 → the shadows sweep along the whole path.
10. **Profile:** key 2's profile → a profile; play → it switches at key 2 and stays; the original returns at the end.
11. **Loop:** tick Loop → no fades, back to key 1 smoothly, plays on until Esc.
12. **Video:** MEDIA → VIDEO, pick the path, 1080p 30 fps, RECORD VIDEO → `Videos\BimGo\<model> path <name> <time>.mp4`;
    MEDIA → VIDEO reopens with OPEN FOLDER. The tour still records from TOUR or VIDEO.
13. **Saving:** a `.bimgo`: add a path → the title shows unsaved; save, reopen → the path is there (`paths.json` in the zip).
    Live: the path is in the model folder's `paths.json` next session.
