# Grass round, build B notes

Not compiled here (no .NET SDK reachable). GRASS_VS / GRASS_FS (and SCENE_FS with the water uniforms, SKY_FS) compile
and link in headless WebGL2; the blades were rendered over a synthetic 120 m lawn with a path (grid, clumps, fades,
lighting) and tuned from the pictures: the first pass showed a seam at the near / far boundary and spiky, sparse blades,
fixed by the cross-fade band, clumps of 3 thinner curved blades and lighter tips (`grass_preview.png` is the second pass).
Brackets and UI glyphs checked by script.

## Files
- **Core** `Scene/GrassField.cs` (new): `Build(scene, keywords, cancel)` (static elements' opaque + transparent ranges,
  library templates out; upward faces: normal Z ≥ 0.34; grass by material keyword → palette slot, others → covers),
  `Rasterise(grass, covers, colours)` (cell = max(0.1, extent / 2046), ≤ 2048 a side; highest grass wins; a cover
  2 cm–2 m above clears the cell), `GrassColour`, `TryGet`, `Triangle`.
- `Scene/LaunchSettings.cs`: `GrassBlades`, `GrassDensity`, `GrassHeightMm`, `GrassDistance` (+ ranges), `WaterColour`,
  `WaterReflection`; sanitised.
- `Scene/MaterialOverrides.cs`: `WATER_PRESETS`, `WaterPresetIndex`.
- **App** `Native/Gl.cs`: `DrawArraysInstanced` (+ entry point), `TRIANGLE_STRIP`, `RG32F`.
- `Rendering/Shaders.cs`: `GRASS_VS` (clump per instance, 9 vertices per blade with degenerate joins, world-anchored
  grid, map lookup, frustum / ring / fade collapse, curved taper, lean, wind), `GRASS_FS` (root-to-tip colour, sun with
  shadows, light through the blade, artificial lights, fog, section cut); `MATERIALS_GLSL`: `uWaterTint`, `uWaterReflect`.
- `Rendering/SceneRenderer.Grass.cs` (new): `GrassLook`, `SetGrassField` (RG32F on unit 14; program built on first use,
  a failure switches grass off), `DrawGrass` (near grid + far ring), `DisposeGrass`.
- `Rendering/SceneRenderer.cs`: `WaterTint`, `WaterReflect` (scene uniforms), `DisposeGrass` in Dispose.
- `Game/GameSession.Grass.cs` (new): settings, `UpdateGrass` (worker-thread build, cancel on keyword change, upload),
  `DrawGrass`, `GrassStatus` (cached).
- `Game/GameSession.Appearance.cs`: pages (main · Water › · Grass blades ›), `PageHeader`, `PageRow`, water colour
  presets / CUSTOM… / reflection, grass controls; `ApplyWaterLook`.
- `Game/GameSession.Render.cs`: `UpdateGrass()` after the sky; `DrawGrass(p)` after the ground (main view only, not the
  clash view).
- **Revit** `Forms/OptionsWindow.xaml(.cs)`: water colour (presets + hex), reflection slider, grass blades tick and density.
- Tests: `GrassTests` (6).

## To verify
- FPS at Low / Medium / High and 80 m on Gavin's GPUs (≈ 2.9 / 4.8 / 8 M vertex runs a frame); if heavy, lower the far
  ring's grid or the near radius.
- `glDrawArraysInstanced` loads (added to the required entry points: a missing one fails at startup with a message).
- The grass field build time on the largest site model (log line "Grass: … cells …").
- RG32F texelFetch in the vertex shader on Intel / AMD drivers.
