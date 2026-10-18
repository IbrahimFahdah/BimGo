# Sky round, build A notes

Not compiled here (no .NET SDK reachable). The sky and scene shaders were pulled out of `Shaders.cs`, compiled and linked
in headless WebGL2 (SwiftShader): both OK. The sky was rendered at 0 / 30 / 65 / 95 % cover to check the look.
Brackets and UI glyphs (Latin-1 + `UiFont.EXTRA`; ® is Latin-1) were checked by script.

## Files
- **Core** `Format/SunModels.cs`: `SunSettings.CloudCover` (0–1, 0), `CloudSpeed` (0–2, 1), `SunSize` (0.25–2, 1,
  `MIN_SUN_SIZE`), `SunGlare` (0–2, 1); Clean / Copy.
- `Scene/LaunchSettings.cs`: `GrassKeywords` (+ `DefaultGrassKeywords`), sanitised.
- `Scene/InputCatalog.cs`: `InputContext.PauseMenu` (+ name, note, order, the pause situation); `InputAction.ClashPictures`
  (P), `MenuPreview` (Tab, pad Y); pad defaults: ClashView D-pad ↑, ClashSectionToggle D-pad ↓, ClashSelectAll RB+X,
  ClashPictures Back, Unarmed RB+B. README §3 rows edited by hand (the test regenerates them if they differ).
- **App** `Rendering/Shaders.cs`: `CLOUD_GLSL` (hash value noise, 5-octave fbm, `cloudLayer(dir, sunDir, light, sky)`;
  early out at 0 % cover); `SKY_FS` includes it, takes `uSunShape` (cos outer, cos inner, glare); `SCENE_FS` includes it
  before `MATERIALS_GLSL`, whose `skyColour` mixes the clouds in (reflections).
- `Rendering/SkyLook.cs` (new): cover, offset, size, glare; `DISC_OUTER` / `DISC_INNER` (the old disc's 0.030 / 0.0224 rad).
- `Rendering/SceneRenderer.cs`: `Sky` field; sky uniforms; scene uniforms `uCloudCover` / `uCloudOffset` (realistic path).
- `Game/GameSession.Sun.cs`: LIGHTING / SKY tabs (`_sunTab`; the divider became the tabs' line; panel 600 → 624 px),
  `BuildSkyTab` (four sliders, note, RESET SKY), slider ids 20–23, `AdvanceSky(dt)` (drift along `CLOUD_WIND`,
  `CLOUD_DRIFT` × speed; renderer `Sky` each frame). `GameSession.cs` calls it after the clock tick.
- `GameSession.Reflections.cs`: probe key includes the cover.
- `GameSession.Menu.cs`: Tab / pad Y toggles the preview (not while typing); PREVIEW button shows the key.
- `Clashes/GameSession.ClashMode.cs`: P → `ToggleClashThumbnails`.
- `GameSession.Appearance.cs`: grass keywords row (stored; note "coming in the grass build").
- `Shell/HomeScreen.cs`, `GameSession.Render.cs` (help footer), `BimGo.Revit/BimGo.addin` (VendorId / description),
  README intro: trademark line.
- **Revit** `Forms/OptionsWindow.xaml(.cs)`: grass keywords box replaces the greyed grass tick.
- Tests: `SkyTests` (3).

## To verify
- The sky pass now runs the noise for every sky pixel when cover > 0 (full-screen, before the scene): check FPS at 4K on
  an integrated GPU. If it costs too much: draw clouds at half resolution, or bake the fbm into a 512² tiling texture.
- The sun panel at 1280 × 720 (624 px tall: should end above the sun icon).
- KeyMap conflict check with the new Pause menu group (`Defaults_HaveNoClashInAnySituation`).
