# BimGo: handoff for Round W, build W-B (rain), after W-A (night sky)

**Context:** BimGo is Gavin's personal project: publisher **Aussie BIM Guru**, licence **MIT-0**; C# / Visual Studio,
.NET 8; its own OpenGL renderer over Silk.NET; a Revit add-in (`BimGo.Revit`), a standalone app (`BimGo.App`) and
`BimGo.Core`.

How Gavin works:
- **Rounds:** discuss → AskUserQuestion (recommended option first and marked, at most 4 questions per call) → build → zip.
- **Notes:** each build gets `ai/<yymmdd><letter>_<topic>/` (`0_brief.md`, `1_build notes.md`), a README §8 to-verify
  entry (§8 holds only the open build: drop the previous one once Gavin confirms it), a §9 row, and a project doc
  `claude/BimGo_<Round>_BuildNotes.md`.
- **Each build says what is in, what isn't, and how to check it step by step.**
- Simple build / test errors: **just the fix** (find the cause, fix, re-zip, a few lines). He folds requests in mid-build
  (handle them in the same build). "Assume recommended options" when he's away. README kept compact.
- **Ask for a fresh zip of his working copy before editing** (it carries his compile fixes). He is often near his daily
  usage limit: split big rounds into builds that each zip on their own.

## 1. Where things are (2026-10-18)

| Build | Folder / project doc | State |
|---|---|---|
| Round K (K-A, K-B, K-C) | `261018e…h`, `claude/BimGo_Flythrough_K*_BuildNotes.md` | Confirmed ("great no issues") |
| **W-A night sky** | `261018i_Night_WA`, `claude/BimGo_Night_WA_BuildNotes.md` | Built; Gavin tested ("almost perfect"); **fixed after testing**: the halo / orb round the moon (glow early-out), the phase choice as moon icons ("Actual" + four drawn moons). **Drop its README §8 entry once he confirms** |
| This handoff | `ai/261018j_Handoff/0_handoff.md`, `claude/BimGo_RoundW_WB_Handoff.md` | |
| **W-B rain** | next: `261018k_Rain_WB` (or the next day's letter) | Answers below; build |

Naming: an older **"water round W"** exists (`claude/BimGo_Water_W_BuildNotes.md`, `AdvanceWater`): different round,
same letter. Call the new builds W-A / W-B with the topic (Night / Rain) in folder names.

## 2. W-A in brief (what W-B builds on)
- Core `Scene/LunarPosition.cs` (moon alt / az / lit / waxing; `LocalSiderealTime`; `EquatorialToTrueNorth`);
  `SunSettings` night fields (`moon`, `moonPhase`, `moonLight`, `stars`, `starDensity`, `starBrightness`, `starTwinkle`,
  `milkyWay`; all additive in `sun.json`).
- `SunLighting.Create(…, moon)`: **`SunDirection` is now "the light"** (the moon once the sun is below −1°, shadows from it);
  the real sun is `SkySunDirection`. New: `MoonDirection`, `MoonSunDirection`, `MoonDisc`, `MoonGlow`, `MoonLights`, `Night`.
- `SkyLook` carries `Stars`, `Time`, `CelestialX/Y/Z`; `SceneRenderer.DrawSky(…, stars)` (probes pass false).
- Sky shader `SKY_FS`: `starLayer` / `nightSky` / moon disc / glow; clouds lit by the moon.
- Sun panel tabs LIGHTING · SKY · **NIGHT** (`BuildNightTab`, `DrawMoonIcon`); slider ids 32–36 used.
- CLEAR MARKERS left the pause menu; X with the Comment gun no longer deletes every comment.

## 3. W-B: the agreed scope (Gavin's answers, 2026-10-18)
- **Rain on / off, intensity, wind slant following the cloud drift** (`CLOUD_WIND`, `CloudSpeed`).
- **Cover map** (chosen over "outdoors only"): when rain is first turned on, build a top-down height map of the model on a
  worker (highest surface z per cell, ~0.5 m cells over the model's bounds, capped e.g. 1024²; static geometry from
  `SceneData.Vertices` / `Indices`, Core, testable). Rain streaks are discarded below the cover (they stop at roofs and
  canopies, fall past windows, never indoors). Moved / hidden elements don't update it (say so).
- **Drops on the screen now and then**: outdoors only (the cover map at the eye says whether you're under a roof), more
  when looking up, never indoors. **Never in photos or videos** (the rain itself shows in them).
- **Wet look**: ground and up-facing outdoor surfaces darker and glossier (the cover map says which are outdoors); clouds
  thicken and the light dims a bit while it rains.
- **Rain sound**: synthesised looping hiss, quieter under a roof (no sound files).
- **Lightning**: "we should be able to turn it on / off as an option and set a rough frequency": on / off + a frequency
  (e.g. rare / sometimes / often); a sky flash and a brief light boost; thunder optional (ask, or decide and say).

Open points to settle (ask, recommended first, or decide and note):
1. Where the controls go: a **WEATHER** (or RAIN) tab in the sun panel next to NIGHT (recommended), saved in `sun.json`.
2. Does rain need shadows on (sun lighting) like the night sky, or show in the classic light too?
3. A hotkey for rain on / off? (Recommended: none; a new default raises `InputCatalog.DEFAULTS_VERSION`.)
4. Thunder with the lightning (a delayed rumble) or flash only.

Code pointers:
- Render order: `GameSession.Render.RenderScene` (sky → scene → caps → `DrawGround` → `DrawGrass` → highlights →
  transparent → `CompositeGlow` → exposure → markers). Rain streaks go after the transparent pass (depth-tested, blended,
  instanced quads in a cylinder round the camera, a vertex-shader loop over time: no per-frame allocations); lens drops as
  a full-screen pass after `CompositeGlow` that refracts the scene colour (`ScreenEffects` / `RenderTarget`), skipped when
  `photo` or a video frame is rendering (`RenderVideoFrame`).
- Sky look per frame: `GameSession.Sun.AdvanceSky` → `SkyLook`; lighting: `CurrentLighting` / `SunLighting.Create`
  (rain dims and thickens: add fields rather than overloading `CloudCover`).
- Shaders: `Rendering/Shaders.cs` (`SKY_FS`, `SCENE_FS`, `GROUND_FS`, `CLOUD_GLSL`); new samplers need their own texture
  unit (see `PROFILE_UNIT`).
- Sound: `Audio/SoundSystem.cs` (waveOut, sounds synthesised at start into PCM, `Play(SoundId)` on 4 channels,
  `dwLoops = 0`): a loop needs a dedicated channel with `WHDR_BEGINLOOP | WHDR_ENDLOOP` and a volume control
  (`waveOutSetVolume`).
- Settings / panel: `SunSettings` (Core `Format/SunModels.cs`: `Clean`, `Copy`), `GameSession.Sun` (`SUN_TABS`,
  `IntensitySlider` switch, `BuildNightTab` as the pattern). Tests: `tests/BimGo.Core.Tests` (`NightSkyTests`, `SkyTests`).

## 4. Things to watch
- **Compiling:** no .NET SDK in the sandbox (say so). Script-check brackets, strings and char literals in changed `.cs`
  files; new member names across the `GameSession` partials; UI strings against the font atlas (Latin-1 + `UiFont.EXTRA`:
  `Δ − — – … • ↑ ↓ ← → “ ” ’ ≈ ≤ ≥ ‹ › ↔`; draw icons with UI primitives rather than new glyphs).
- **Shaders:** extract with the scratch script approach (evaluate the C# string constants), swap `#version 330 core` for
  `#version 300 es` + precision, compile / link / **render a test frame** in headless WebGL2 (Playwright, the pre-installed
  Chromium, `--use-gl=swiftshader`). Look at the frame: W-A's first star field was far too dense and the moon blown out,
  both only visible in a render.
- **Text fit:** the sun dock is ~300 px inside; a 5-way segmented row gives ~59 px a button (Body 14 px: ~7 px a
  character).
- **Compatibility:** additive only (`.bimgo` 1, `sun.json` fields with defaults; unknown enum strings throw: add fields).
- **No per-frame allocations;** labels cached; the cover map built once on a worker (progress or a toast while it builds).
- **Encodings:** keep BOMs where they are (e.g. `GameSession.Sun.cs`, `Shaders.cs`, `SunModels.cs`); new files LF, no BOM.

## 5. After W-B
- **Round X:** sun time-lapse + batch stills (X-A; K-C's PHOTOS OF ALL KEYS is a start); sequence playback ("4D-lite")
  and two-way Revit camera sync (X-B).
- Later: find element search, accessibility checks, travel-distance tape, kiosk launch, profile schedule CSV, OpenXR VR,
  IFC import, occlusion culling / LOD, multiplayer.
