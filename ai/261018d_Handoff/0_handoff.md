# BimGo: handoff for Round K (keyframed flythrough), after Round P

**Context:** BimGo is Gavin's personal project:
- publisher **Aussie BIM Guru**, licence **MIT-0**;
- C# / Visual Studio, .NET 8;
- its own OpenGL renderer over Silk.NET;
- a Revit add-in (`BimGo.Revit`), a standalone app (`BimGo.App`) and `BimGo.Core`.

How Gavin works:
- **Rounds:** discuss → AskUserQuestion (recommended option first and marked, at most 4 questions per call) → build → zip.
- **Notes:** each build gets `ai/<yymmdd><letter>_<topic>/` (`0_brief.md`, `1_build notes.md`), a README §8 to-verify
  entry (§8 now holds only the open build: drop the previous one once Gavin confirms it), a §9 row, and a project doc
  `claude/BimGo_<Round>_BuildNotes.md`.
- **Each build says what is in, what isn't, and how to check it step by step.**
- Simple build or test errors: he wants **just the fix**. He folds requests in mid-build. "Assume recommended options"
  when he's away. He likes the README kept compact.
- **Ask for a fresh zip of his working copy before editing** (it carries his compile fixes).

## 1. Where things are (2026-10-18)

| Build | Folder | State |
|---|---|---|
| Roadmap brief | `261017j_Handoff`, project doc `claude/BimGo_Roadmap_Polish_Flythrough_Brief.md` | Round P done; next Round K (K-A, K-B, K-C), then Round W (weather), then Round X |
| P-A1 / P-A2 / P-B | `261017k`, `261017m`, `261018b` | Confirmed |
| P-C leftovers + colour follow-ups | `261018c_Polish_PC`, project doc `claude/BimGo_Polish_PC_BuildNotes.md` | Confirmed ("all works"): drop its README §8 entry in K-A |
| This handoff | `ai/261018d_Handoff/0_handoff.md`, project doc `claude/BimGo_RoundK_Handoff.md` | |
| **K-A** | next: `261018e_Flythrough_KA` (or the next day's letter) | Answers in §2b; stage K-A's own questions, then build |


## 2. Round K: the agreed brief (roadmap) plus Gavin's additions

**Brief (roadmap, "full editor chosen"):**
- Core `Format/CameraPathModels.cs`: `CameraPath` (name, keys, loop, default speed, `Clean()`), `CameraKey` (position,
  yaw / pitch or quaternion, FOV, time *or* speed to the next key, ease in / out, hold seconds, optional state: sun
  date-time, colour profile id, section, visibility, eye / fly; optional `LookAt`).
- Stored as `paths.json` in the model folder and inside `.bimgo` (additive; `formatVersion` stays 1).
- Core `Scene/CameraPathTimeline.cs`: centripetal Catmull-Rom for position; arc-length table for constant speed;
  quaternion slerp / squad or look-at; ease curves; holds; `Duration`, `Evaluate(t)`. `CameraPathTests` (continuity,
  constant speed, holds, look-at, loop). Port the maths to Python to check, as was done for `TourTimeline`.
- App: PATH EDITOR mode (add key at the current view, insert / delete / reorder, edit a key's fields); path drawn in 3D
  (line, key markers, direction ticks); selected key draggable with the gizmo; segments through geometry flagged red;
  timeline scrubber (keys as ticks, Space preview, ← / → previous / next key); look-at target; **tour → path**.
- Playback reuses the tour's save / restore (player, sun, cut, visibility, eye) and quiet setters; video through the A2
  pipeline (`GameSession.Video`: fixed-step clock, off-screen `RenderScene(..., photo: true)`).
- Split: **K-A** Core + playback + video from a path, simple key list; **K-B** 3D path drawing, gizmo editing, scrubber,
  collision flags, tour → path.

**Gavin's additions (2026-10-18), to fold in when staging the questions:**
- The path editor should **also live in tour mode** as an alternative approach (a tour made of bookmark stops, or a
  path; or bookmarks as keys on a path).
- **Spline corner logic:** how smoothly it turns between keyframes (a tension / corner-radius control), and the camera
  **pivots to face progressively along the path** (a "follow the path" heading mode beside fixed key headings / look-at).
- Editing in flight: **fly around and adjust nodes** on the spline, **add frames on the path** (insert a key where you
  are on it), and **snap into a frame** (camera to that key) and **move it yourself** by flying, then set it.
- A **sun animation** along the path (key state sun times blend; P-C's tour sun blend is the pattern).
- **Photo / video / tour integrated:** a Visualize / Media / Production area (one place, or close links: a path frame
  as a photo, a tour or path as a video, shared state such as sun and colour profile). Ask whether this is part of K or
  its own round.

## 2b. Round K answers (AskUserQuestion, 2026-10-18; all the recommended options)

| Question | Answer |
|---|---|
| Where paths live | **A new MEDIA panel** (pause menu, on the panel shell): tabs PHOTO · TOUR · PATHS · VIDEO. Tours and paths share stops / settings; any of them records to video. This starts the Visualize / Media area. |
| Tour vs path | **A tour is a path type:** one player. A tour is a path whose keys are the bookmarks (fade or glide, as now); SMOOTH plays it as a spline path; CONVERT TO PATH copies it into free keys. |
| Heading | **Follow + per-key override:** by default the camera pivots progressively to look ahead along the spline; a key can hold its own view or look at a target, blending in and out. |
| Corners and speed | **Smoothness per path + per key:** Catmull-Rom with a tension slider (sharp ↔ round) on the path and an override per key; **constant speed** (m/s) along the curve (arc-length table); holds and ease at keys. |
| In-flight editing | **Fly + snap:** the path drawn in 3D; **K** adds a key where you are (inserted on the nearest segment when you're on the path); **← / →** snaps the camera into a key; fly to adjust it and SET; drag a node with the gizmo; a scrubber at the bottom (Space previews). |
| Key state | **Sun time** (blends between keys: the sun animation) and **colour profile** (switches at the key). Not section / visibility or FOV for now (keep the model open to adding them: optional fields). |
| Split | **K-A** Core path + timeline + playback + video + the MEDIA shell (PHOTO / VIDEO tabs move in; TOUR and PATHS tabs with a simple key list). **K-B** 3D editing (path drawing, fly + snap, K / ← / →, gizmo drag, scrubber, collision flags). **K-C** tour as a path type (SMOOTH, CONVERT TO PATH), photo / video links (a key as a photo, a path or tour as a video), sun animation polish. |
| Weather | **After K, as Round W:** moon on / off, moonlight brightness, procedural stars, rain and lens drops. |

Open points for K-A's own questions (stage before building): the MEDIA panel's layout (left list + right editor
like CLASHES, or one column); whether PHOTO / VIDEO move into MEDIA in K-A or stay and get linked; the path file
(`paths.json` beside `bookmarks.json`, and in `.bimgo`); keyboard entry point (a key for MEDIA? photo mode M stays);
how a key's tension and hold are edited in K-A's simple list.

## 3. What the code looks like (pointers)

- **Keys reserved (P-B):** `InputContext.PathEditor` and situation `InputCatalog.SIT_PATH` ("Path editor (Round K)"):
  `PathAddKey` K, `PathDeleteKey` Del, `PathPreview` Space, `PathPreviousKey` ←, `PathNextKey` → (pad X / LB+X / Y /
  D-pad ← →). No app code reads them. The situation has no movement: ← / → are taken, so K-B decides how the camera
  moves there (WASD only, or fly keys) and adds them to the situation (the clash test will check). Add the situation to
  `GameSession.CurrentSituation()` (`GameSession.Gamepad.cs`) and `UpdateFrame` together.
- **Tour:** `GameSession.Tour.cs` (start / stop save and restore, `ApplyTourStop`, quiet setters `SetSunQuiet`,
  `SetSectionQuiet`, `ApplyVisibility(record: false)`, `ApplyBookmarkProfile(quiet: true)`), Core `TourTimeline`
  (`TourPose` with P-C's `BlendFrom / BlendTo / BlendT`). P-C's `BlendTourSun` blends the sun's day-of-year and
  fractional minutes (`_sunBlendMinutes` read by `RecomputeSun`).
- **Bookmarks:** Core `BookmarkModels.cs` (`EyeHeight`, `Crouched`, `ColourProfile`, tour fields), App
  `BookmarkStore.cs` (`Stamp` hook), `GameSession.Bookmarks.cs`.
- **Video:** `GameSession.Video.cs` (`StartVideo`, `UpdateVideo`, `FinishVideo`), `VideoRecorder`,
  `Native/MediaFoundation.cs`. The tour clock is driven by video frames while recording.
- **Photo:** `GameSession.Photo.cs` (stills, 360s, `RenderPhotoView(…, legendScale)`, grids in photos).
- **Gizmo:** `Guns/GizmoController.cs` / `GizmoGun.cs` (for K-B's key dragging).
- **Overlay drawing:** `Rendering/Overlay3D.cs` (lines, dots; depth-tested + x-ray copy) for the 3D path.
- **Panels:** the panel shell (`GameSession.PanelShell.cs`: `BeginPanel` / scroll regions / footer) and docks
  (`BeginDock`…`EndDock`); every `Hover` is a gamepad focus target (README AI notes 14–16).

## 4. Things to watch
- **Compiling:** no .NET SDK in the sandbox (nuget / dotnet hosts blocked): say so. Script-check brackets, strings and
  `'\uXXXX'` char literals, new member names across the `GameSession` partials, and UI strings against the font atlas
  (Latin-1 + `UiFont.EXTRA`: `Δ − — – … • ↑ ↓ ← → “ ” ’ ≈ ≤ ≥ ‹ › ↔`). Shaders: compile in headless WebGL2 (Playwright
  is installed: `/opt/npm-tools/node_modules/playwright`, Chromium in `/opt/pw-browsers`; swap `#version 330 core` for
  `#version 300 es` + precision lines).
- **Name clashes:** `InputState` (alias, or `using BimGo.Platform;`); `DB.` qualifiers in BimGo.Revit; colour profiles
  are `AppearanceProfile`, not the quality `Profiles`; `Guns.Gun` from `GameSession` partials without the using.
- **Encodings:** keep them (some files have a BOM, most don't; `UiBatch.cs`, `UiTheme.cs` ASCII). LF.
- **Compatibility:** additive only (`.bimgo` 1, `clashes.json` 1, live protocol 1; settings migrate quietly in
  `LaunchSettings.Sanitise`). **Never rename an `InputAction` id.** A changed default raises
  `InputCatalog.DEFAULTS_VERSION` and adds `DefaultsChanges` rows (AI note 16).
- No per-frame allocations; labels cached (`KeyHint`).

## 5. Future goals (README §8 → Roadmap)
- Round W (after K): night sky (moon on / off, moonlight brightness slider, procedural stars with controls like the clouds).
- Round W: rain on / off with falling rain, and drops hitting the screen now and then.
- Round X: sun time-lapse + batch stills (X-A); sequence playback ("4D-lite") and two-way Revit camera sync (X-B).
