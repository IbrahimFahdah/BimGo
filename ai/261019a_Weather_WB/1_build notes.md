# Round W, build W-B: rain and snow (2026-10-19)

Built on Gavin's `BimGo_Night_WA` working copy. **Not compiled here** (no .NET SDK): build first, then the Core tests
(+4 in the new `WeatherTests`). Checked: brackets / strings / char literals in every changed `.cs`, encodings kept (BOMs
where they were; new files LF, no BOM), new member names across the `GameSession` partials, UI strings against the font
atlas (only `…` and `²` beyond ASCII). Every shader extracted from `Shaders.cs`, compiled in headless WebGL2 (SwiftShader);
the scene, ground, grass, sky and new rain / snow programs linked and rendered on a test block with a roof, a porch canopy,
decks, a low wall and a pitched shed (rain from outside, rain from under the canopy, snow, light snow). **No new keys.**

## In

| Item | What it does | Where |
|---|---|---|
| **WEATHER tab** | Sun panel: LIGHTING · SKY · NIGHT · **WEATHER**: Off · Rain · Snow; **Rainfall** / **Snowfall** (5–100 %); **Wet look** (rain, 0–100 %) or **Settled snow** (snow, 0–100 %); a status line (mapping the roofs… / "Rain stops at roofs and canopies (… m² mapped, 500 mm cells)"); RESET WEATHER. Saved with the model. | `GameSession.Weather` (`BuildWeatherTab`), `SUN_TABS`, sliders 37–39 |
| **Cover map** | The highest surface over each ~0.5 m cell of the model (every visible static triangle, opaque and glass, and moved / cloned / placed copies; each triangle by its area and its edges, so walls and slivers narrower than a cell count). Built on a worker the first time rain or snow is turned on; rebuilt a moment after the shown model changes (hide, demolish, move: the grass field's settle rule). Until it's ready the weather shows everywhere. Big sites get bigger cells (at most 1024 × 1024). | Core `Scene/CoverMap.cs`; `SceneRenderer.SetCoverMap` (R32F, unit 16) |
| **Rain** | Thin streaks along their velocity (9 m/s, ± 15 %), slanting with the clouds' drift (2.5 m/s at drift 100 %; still clouds = straight down), turned to face you, in a 36 × 36 × 20 m box round the eye; 5,000–35,000 by Rainfall. Each drop has a fixed place in a world-anchored repeating pattern (they stay put as you walk). Stops at the cover map: falls past windows, never indoors or under canopies; nothing below the ground plane. Lit by the sky (dim at night). | `PRECIP_VS` / `PRECIP_FS`, `SceneRenderer.DrawPrecipitation` |
| **Snow** | Soft round flakes falling at 1.1 m/s, drifting with the wind at under half its speed and fluttering; 3,000–25,000 in a 30 × 30 × 16 m box. Same cover rule. | same |
| **Wet look** | Surfaces open to the sky go darker (floors and roofs most, walls about a third) and take a sheen of the sky or the room's probe, stronger at grazing angles; **puddles** on flat ground mirror the sky and ripple in the rain (fine detail fades with distance). The ground plane and grass too. | `WEATHER_GLSL` (`skyOpen`, `wetAmount`, `puddleAmount`), `SCENE_FS`, `GROUND_FS`, `GRASS_FS` |
| **Snow cover** | Open up-facing surfaces (roofs, decks, wall tops, the ground) turn snow white: patchy while Settled snow is low (drift noise), flat faces first, slopes only when deep; walls stay clear. Glass under snow turns opaque. Grass blades whiten towards the tips and shrink (buried). | `snowAmount`; `GRASS_VS` `uSnowShrink` |
| **Storm light** (shadows on) | Clouds thicken (cloud cover at least 65–100 % by intensity), direct light × (1 − 0.6 o) with softer shadows, the sky greys (lighter for snow), the sun and moon discs and the stars fade, fog thickens (up to × 3 in rain, × 4 in snow). | `SunLighting.WithWeather`, `AdvanceSky`, `RenderScene` fog |
| **Photos and videos** | The rain / snow shows in them (video frames take the weather clock from the frame number, so the fall speed is right). | `UpdateWeather` |

Water surfaces, highlights and colour-profile colours never get wet or snowy. Reflection probes re-bake when the weather
changes (they capture wet / snowy surfaces, not the falling drops).

### Files on disk (additive)
`sun.json`: `weather` ("off" / "rain" / "snow"; a string so a later kind never fails this reader: anything else reads as
off), `weatherIntensity` (0.05–1, 0.5), `wetness` (0–1, 1), `snowCover` (0–1, 0.6). Older files stay dry.

### Tests (+4)
`WeatherTests.Cover_HighestSurfaceWins_OpenOutside`, `Cover_ThinWallsAndSlopes`, `Cover_BigModelsGetBiggerCells`,
`WeatherSettings_DefaultCleanCopyAndOlderFiles`.

## How to check it
1. **Build**, run the Core tests.
2. Open a model with a roof, a canopy or a balcony, and some open ground. Sun panel (Shift+O) → **WEATHER** → **Rain**.
   The status line says "Mapping the roofs and canopies…", then "Rain stops at roofs and canopies (… m² mapped, …)".
3. **Outside:** streaks fall and slant with the clouds (SKY → Cloud drift 0: straight down; 200 %: steep slant). Walk
   about: the rain stays put round you (no swimming). The ground and roofs look darker with a sheen; puddles on flat
   ground reflect the sky and ripple.
4. **Indoors / under cover:** walk under a canopy and indoors: no rain falls inside; look out of a window: rain falls
   outside it. Floors indoors and under the canopy stay dry; the dry strip under an eave.
5. **Sliders:** Rainfall 5 % → 100 % (light drizzle → downpour); Wet look 0 % (dry surfaces, rain still falls).
6. **Shadows on vs off (O):** with shadows on the sky greys over, the clouds thicken, shadows soften and the fog
   thickens; with shadows off the rain and the wet look still show.
7. **Snow:** WEATHER → **Snow**. Flakes drift and flutter. Roofs, decks, wall tops and the ground go white; walls and
   anything under a roof stay clear. Settled snow 20 %: patchy; 100 %: deep (pitched roofs white too). Grass (Realistic,
   blades on): whitened and shorter.
8. **Change the model:** hide a roof (or demolish a canopy): a moment later rain falls where it was.
9. **Photo / video:** take a photo and record a short tour: the rain / snow is in them, falling at the right speed in the
   video.
10. **Night:** 22:00 with rain: dark streaks lit by the sky, no stars or moon disc.
11. **Save, reopen:** the weather is kept. RESET WEATHER turns it off.

## Not in (W-C and later)
- **W-C:** lens drops (outdoors only, more when looking up, never in photos / videos), synthesised rain sound (quieter
  under a roof), lightning on / off with a rough frequency, a delayed thunder rumble.
- Splashes where drops land; drips from eaves; wet-look build-up over time (it's instant); snow drifting against walls;
  snow on vertical ledges narrower than a cell; artificial lights lighting the falling drops; weather in the minimap.

## Things to look at when building
- New texture unit 16 (`SceneRenderer.COVER_UNIT`): every unit 1–15 was taken. GL 3.3 guarantees 48 combined units; the
  scene fragment shader now uses 13 samplers (limit 16).
- `ApplyUniforms` now sets the sky colours and clouds in every colour mode (wet surfaces reflect the sky outside Realistic).
- `Gl.R32F` / `Gl.RED` added.
