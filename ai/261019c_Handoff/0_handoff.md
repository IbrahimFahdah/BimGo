# BimGo: handoff for Round X (sun time-lapse, batch stills, 4D-lite, Revit camera sync), after Round W

**Context:** BimGo is Gavin's personal project: publisher **Aussie BIM Guru**, licence **MIT-0**; C# / Visual Studio,
.NET 8; its own OpenGL renderer over Silk.NET; a Revit add-in (`BimGo.Revit`), a standalone app (`BimGo.App`) and
`BimGo.Core`.

How Gavin works:
- **Rounds:** discuss → AskUserQuestion (recommended option first and marked, at most 4 questions per call; he sometimes
  types his own answer: follow it) → build → zip.
- **Notes:** each build gets `ai/<yymmdd><letter>_<topic>/` (`0_brief.md`, `1_build notes.md`), a README §8 to-verify
  entry (§8 holds only the open build: drop the previous one once Gavin confirms it), a §9 row, and a project doc
  `claude/BimGo_<Round>_BuildNotes.md` (sent as a file beside the zip).
- **Each build says what is in, what isn't, and how to check it step by step.** Send headless test renders when visual.
- Simple build / test errors: **just the fix** (find the cause, fix, re-zip, a few lines). He folds requests in mid-build
  (handle them in the same build). "Assume recommended options" when he's away. README kept compact.
- **Ask whether his working copy changed** (compile fixes) before editing; if so, wait for his zip. He is often near his
  daily usage limit: split big rounds into builds that each zip on their own.

## 1. Where things are (2026-10-19)

| Build | Folder / project doc | State |
|---|---|---|
| W-A night sky | `261018i_Night_WA` | Confirmed |
| W-B rain and snow | `261019a_Weather_WB`, `claude/BimGo_Weather_WB_BuildNotes.md` | Confirmed ("amazing, worked perfectly") |
| W-C lightning, lens drops, rain sound | `261019b_WeatherFx_WC`, `claude/BimGo_WeatherFx_WC_BuildNotes.md` | Confirmed ("great") |
| This handoff | `ai/261019c_Handoff/0_handoff.md`, `claude/BimGo_RoundX_Handoff.md` | |
| **X-A** | next: `261019d_TimeLapse_XA` (or the next day's letter) | Questions, then build |

README §8 has no open build now. Naming: an older "water round W" exists (`BimGo_Water_W_BuildNotes.md`); Round X has no
clash.

## 2. Round W in brief (what X builds on)
- **Sun panel tabs:** LIGHTING · SKY · NIGHT · WEATHER (`SUN_TABS`, `GameSession.Sun`, `GameSession.Weather`); everything
  saved in `sun.json` (`SunSettings`, Core `Format/SunModels.cs`, additive fields with defaults).
- **W-A:** `LunarPosition`, moonlight (`SunLighting.SunDirection` = "the light", the real sun = `SkySunDirection`), stars.
- **W-B:** `SunSettings.Weather` ("off" / "rain" / "snow" string), `CoverMap` (Core; R32F on texture unit 16), `WEATHER_GLSL`
  in the scene / ground / grass shaders, `PRECIP_VS/FS`, `SunLighting.WithWeather`, `GameSession.Weather` (cover map
  build on a worker, settle rule shared with grass).
- **W-C:** Core `LightningStorm` (strikes from the clock alone, WCAG limits, tests), `SKY_FS` lightning, `LENS_VS/FS` +
  `SceneRenderer.DrawLensDrops` (main view only), `Audio/WeatherSound` (its own streamed waveOut, rain + thunder),
  `SunLighting.WithLightning` / `ApplyFlash`, `FrameLighting()` (probes keyed without the flash).
- **Clocks that matter for X:** the weather clock (`_weatherClock`; video frames use `_videoFrame / _videoFps`), the
  cloud drift (`AdvanceSky`), the water clock (`AdvanceWater`): a time-lapse or batch render should drive these
  deterministically (see 4).

## 3. Round X: scope as it stands (from the roadmap; nothing asked yet)
- **X-A: sun time-lapse + batch stills.** A time-lapse video of the sun (and moon / stars / weather) moving across a day
  (or a date range) from a fixed view or along a camera path; batch stills: renders of a set of views × times (K-C's
  PHOTOS OF ALL KEYS is the start: `GameSession.KeyPhotos`).
- **X-B: sequence playback ("4D-lite") and two-way Revit camera sync.** Elements appear / disappear by phase (or a
  parameter / date) as a slider or animation; BimGo's camera follows Revit's 3D view and vice versa in live sessions.

### Questions to ask before X-A (recommended first)
1. **Time-lapse source:** a fixed view (current camera / a bookmark) over a day (recommended), or along a camera path
   with the sun animating too, or both.
2. **Range and output:** one day sunrise → sunset (recommended), a custom start / end time, or several dates (e.g. the
   solstices and equinox side by side: 4 clips or a 2 × 2 grid?). Output MP4 through the existing `VideoRecorder`
   (recommended) and / or a PNG sequence.
3. **Batch stills:** which views (bookmarks, path keys, comments?) × which times (a list of times / dates), named and
   saved to one folder with a contact sheet / CSV index? (Recommended: bookmarks × a time list, a folder with an index.)
4. **Overlays:** date / time stamp and a small sun-path dial burned in (recommended: optional stamp, off by default).

### Questions for X-B (ask when X-B starts)
- 4D source: Revit phases only (`ElementRecord.Phase` is only existing / new today: the extraction would need each
  element's created / demolished phase names and order), a parameter (e.g. a date or a sequence number), or both.
- Playback: a timeline slider in MEDIA, play / pause, video export; new / demolished highlights.
- Camera sync: BimGo → Revit (a "BimGo view" 3D view following the walk, throttled), Revit → BimGo (follow the active 3D
  view), or both with a toggle; live sessions only.

## 4. Code pointers
- **Video:** `GameSession.Video` (`RenderVideo`, `RenderVideoFrame`: fixed step `_videoFrame / _videoFps` drives the tour
  clock `_tourTime`, then `EvaluateTour`, then `RenderScene(…, photo: true)` into `_videoTarget`, read back and handed to
  `VideoRecorder` (Media Foundation H.264, pool of 3 frames)). A time-lapse is a new frame source: set the sun time per
  frame (`_sunBlendMinutes` is how the tour's sun blend sets fractional minutes; `RecomputeSun()`), keep the camera fixed
  or on a path.
- **Sun:** `GameSession.Sun`: `RecomputeSun()` (sun, moon, sidereal axes from `_sun.Time` or `_sunBlendMinutes` /
  `_playMinutes`), play (`PLAY_SPEED` 60 clock-min per s), `SunBlend.Between` (Core) for date blends the short way round.
  Shadows: the cascades re-render when the sun moves (`UpdateShadows`); reflection probes re-bake on lighting change
  (`ProbeSceneKey`; probes aren't re-baked while recording: a time-lapse will want them frozen or re-baked per N frames).
- **Photos:** `GameSession.Photo` (`TakePhoto`, `_photoTarget`, resolution multipliers, PNG / JPEG, exposure);
  `GameSession.KeyPhotos` (`StartKeyPhotos`, `UpdateKeyPhotos`, `FinishKeyPhotos`, overlay): a batch loop that steps
  views and shoots, Esc stops: the pattern for batch stills.
- **MEDIA panel:** `GameSession.Media` (`MEDIA_TABS` = PHOTO · TOUR · PATHS · VIDEO): a time-lapse probably lives in VIDEO
  (or a new tab); batch stills in PHOTO.
- **Camera paths:** `PathStore`, `GameSession.Paths` / `PathEditor`; paths already animate the sun per key.
- **Live (X-B):** Core `Live/LiveProtocol.cs` (message kinds `select.elements`, `edit`, `journal.apply`, …; a camera sync
  needs new kinds, e.g. `view.camera` both ways, additive: older peers ignore unknown kinds?: check `LiveDispatcher`),
  Revit `Live/LiveDispatcher.cs`, `Live/SessionHost.cs`, `Bridge/RevitEditor.cs` (the "BimGo clash" 3D view in
  `SHOW IN REVIT` is the pattern for a dedicated view). Coordinates: scene-local metres vs Revit internal feet
  (`GameSession.Coordinates`).
- **Settings / files:** `LaunchSettings` (per machine), `sun.json` / `bookmarks.json` / `paths.json` in the `.bimgo`
  (additive only; unknown enum strings throw: add fields or use strings).
- Tests: `tests/BimGo.Core.Tests` (keep logic in Core where it can be tested: e.g. a `TimeLapsePlan` that turns a range and
  frame rate into per-frame sun times).

## 5. Things to watch
- **Compiling:** no .NET SDK in the sandbox (say so). Script-check brackets, strings and char literals in changed `.cs`
  files (a checker lives in the scratchpad approach: re-write it if needed); new member names across the `GameSession`
  partials; UI strings against the font atlas (Latin-1 + `UiFont.EXTRA`: `Δ − — – … • ↑ ↓ ← → “ ” ’ ≈ ≤ ≥ ‹ › ↔`; draw
  icons with UI primitives).
- **Shaders:** extract the C# string constants, swap `#version 330 core` for `#version 300 es` + precision (incl.
  `sampler2DArray`, `sampler2DArrayShadow`, `sampler3D`), compile / link / **render test frames** in headless WebGL2
  (Playwright, pre-installed Chromium, `--use-gl=angle --use-angle=swiftshader`). Don't pipe the runner into `head`
  (it kills node before the PNGs are written).
- **Texture units:** 1–16 are taken (16 = the cover map); unit 0 is the scratch unit (the lens copy binds there).
- **Text fit:** dock ~300 px inside; Body 14 px ≈ 7 px a character; a 4-tab row ≈ 75 px a tab.
- **Compatibility:** additive only (`.bimgo` 1). **No per-frame allocations**; labels cached; long work on a worker with a
  status line or toast.
- **Encodings:** keep BOMs where they are (`GameSession.Sun.cs`, `Shaders.cs`, `SunModels.cs`, `SceneRenderer.cs`,
  `GameSession.Render.cs`, `Gl.cs`, `README.md` has none); new files LF, no BOM.
- **Photosensitivity:** a time-lapse with lightning on would compress strikes into rapid flashes: keep the WCAG limit in
  output time (e.g. turn lightning off, or space strikes by output frames) and say so.

## 6. After X
- Later: find element search, accessibility checks, travel-distance tape, kiosk launch, profile schedule CSV, OpenXR VR,
  IFC import, occlusion culling / LOD, multiplayer.
