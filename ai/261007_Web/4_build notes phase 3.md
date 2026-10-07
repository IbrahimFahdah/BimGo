# BimGo Web — build notes, Phase 3 (rendering parity)

**Ported from:** upstream `develop` @ `82d901e`.

## What was built

| Desktop | Web | Notes |
|---|---|---|
| `Scene/SolarPosition.cs` | `core/scene/SolarPosition.ts` | NOAA series. `SolarPositionTests` ported with the same expected values and tolerances (all pass). |
| `Rendering/SunLighting.cs` | `engine/render/SunLighting.ts` | |
| `Rendering/ShadowMaps.cs` | `engine/render/ShadowMaps.ts` | Cascaded depth array (`texStorage3D` DEPTH_COMPONENT24) plus glass transmittance array, per-layer framebuffer, texel-snapped stable fit. Cascade c refreshes every (c + 1)th frame. |
| `Rendering/ScreenEffects.cs` | `engine/render/ScreenEffects.ts` | Half-res geometry pre-pass (RGBA32F + RGBA16F glow MRT), AO with a depth-aware blur, quarter-res bloom. Needs `EXT_color_buffer_float`; without it, AO and glow switch off with a toast. |
| `Rendering/LightShadows.cs`, `ArtificialLighting.cs` | `engine/render/LightShadows.ts` | 32 lights × 6 faces × 256 px depth array; at most 4 lights rendered per frame, with fade-in. |
| `SceneRenderer` sun / AO / lights / glow | `engine/render/SceneRenderer.ts` | Emissive stream (attribute 3); the light, AO and artificial uniform blocks; sky and fog follow the sun. |
| `GameSession.Sun` | `game/SunState.ts` + `game/SunPanel.ts` | State, play, and the SUN, SHADOWS & LIGHTS panel with its icon. |
| `GameSession.Lights` | `game/Lights.ts` | Nearest 32 lights in view, with a distance fade when some are left out. |

## Keys and settings

- **O** shadows on / off, **Shift+O** or the sun icon opens the sun panel, **[ ]** time −/+ 5 min (Shift: 1 min), **Space** plays the day in the panel, **K** cycles lights (off / glow / glow + light).
- **Saved per browser:** shadow quality, ambient occlusion (pause menu → World & Display), light mode, light intensity and bloom.
- **Sun settings** come from the file's `sun.json`, else the site's sun start, else today at noon. Bookmarks store and restore the sun time, as on the desktop.

## WebGL-specific decisions

- **Sampler units** stay as on the desktop (1, 2 sun; 3 AO; 4 glow; 5 light shadows), and every unit always holds a valid texture of the right kind: the 1 × 1 shadow arrays when the sun is off, and depth or colour placeholders otherwise.
  - Passes that write a texture (shadow, pre-pass, AO, blur) use programs that don't sample it, which is WebGL's feedback-loop rule.
- **Automatic shadow downgrade** (from the plan): when shadows hold the frame time above 40 ms (under 25 fps) for 3 s, quality steps down one level (High → Medium → Low) with a toast. It stops once the user picks a quality in the sun panel.
- **Moved / cloned fixtures** don't light until editing lands (Phase 4).
- **Anti-aliasing (MSAA)** is not ported yet. The desktop default is off.

## Verified

- Lint, type-check and 41 tests pass (11 new sun tests). The build is 240 kB (80 kB gzip).
- Headless Chrome, Snowdon with a test `sun.json` (21 Jun, 15:00) and an aerial home (local test copy, not in the repo):
  - The building shadows the ground, rooftop plant shadows the roof, and the far facade is in shade.
  - AO shows in the garage, at column bases and ceiling corners.
  - The 03:00 start gives the night sky.
  - The shadow maps are created (`3 × 2048 px + glass, 120 m`) with no WebGL errors.
- The automatic downgrade fired at headless Chrome's 10 fps, as designed.

## Not verified

- Artificial lights and glow: Snowdon has no fixtures, so this needs a model exported with lighting fixtures.
- Frame rate with shadows and AO on a real GPU. The plan target: Medium shadows hold 60 fps on the reference laptop.
- Firefox and Safari: `EXT_color_buffer_float` support and the look.
- Side-by-side comparison with desktop renders.
