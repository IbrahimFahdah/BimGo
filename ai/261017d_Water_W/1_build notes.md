# Build W: water ripple strength / speed and grass sway (2026-10-17)

Not compiled here (no .NET SDK in the sandbox): build first, then run the Core tests. No new keys, no new tests, README §3 unchanged.
Checked: brackets / strings by script on every changed C# file; the XAML parses; the scene and grass shaders compile and link in
headless WebGL2 (SwiftShader) with `uWaterWaves` and `uSway` active; file encodings unchanged (UTF-8 BOM, LF).

## In

- **Appearance → Water ›**: **Ripples** 0–200 % (0 % reads "Off (still)"; the shader skips the six waves) and **Ripple speed**
  0–200 % (0 % reads "Paused"; the ripples stand still). The main page's Water row adds "· still" at 0 % ripples.
- **Appearance → Grass blades ›**: **Sway** 0–200 % (0 = still blades).
- Saved per machine in `settings.json`: `WaterRipple`, `WaterRippleSpeed`, `GrassSway` (0–2, default 1, 5 % steps;
  `LaunchSettings.CleanLookScale` sanitises; old files read 1).
- **Revit Options → Materials**: a Ripples / Ripple speed row under the water colour, and Sway beside the grass density.

## How

- `Shaders.cs`: scene FS `uniform float uWaterWaves` scales the wave slope in `waterNormal`, and the call is skipped at 0.
  Grass VS `uniform float uSway` scales the sway term.
- `SceneRenderer`: `WaterWaves` and `WaterClock`. The scene's `uTime` (used only by the water) now gets the **water clock**
  rather than the frame time.
- `GameSession.AdvanceWater(dt)` (called beside `AdvanceSky`) moves `_waterClock` on at the ripple speed, so changing the speed
  never jumps the waves. It wraps every 3600 s of water time to keep float precision: one jump an hour at most.
- `GrassLook.Sway` → `uSway` (the renderer's default is 1).

## Added after testing (Gavin: ripples and speed "work perfectly"; wave size then confirmed working too)

- **Wave size** 25–400 % (`WaterWaveScale`, 0.25–4, default 1; `LaunchSettings.CleanWaveScale`): the last control on the
  Water page and a Wave size row in the Revit Options window. Shader: `uWaveScale` divides each wave's wavenumber in
  the phase only, so the waves get longer while the slope (strength) stays the same.
  Check: 25 % → fine chop; 400 % → long swell; the ripples look as strong at both. Saved and reloaded like the others.

## Not in

- Per-model water settings; a separate grass sway speed.
- FPS: animation off saves nothing (the waves cost the same moving or not). Ripples 0 % saves a little on large water.

## Check

1. Realistic, a pool: Water page → Ripples 0 % → flat water; 200 % → choppier.
2. Ripple speed 0 % → the ripples freeze; back to 100 % → they carry on with no jump; 200 % → faster.
3. Grass page → Sway 0 % → still; 200 % → a stronger breeze.
4. Close and reopen BimGo: all three kept.
5. Revit Options → Materials: the sliders show the saved values (0 % reads Still / Paused); change, Go: the walkthrough uses them.
6. An old `settings.json` without the keys: 100 % each.

## APIs to verify on compile

- WPF: a `Slider.ValueChanged` handler shared by three sliders (`SliderLookScale_ValueChanged`); the null checks cover XAML load order.
