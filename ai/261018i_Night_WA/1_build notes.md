# Round W, build W-A: the night sky (2026-10-18)

Built on `BimGo_Flythrough_KC` (confirmed). **Not compiled here** (no .NET SDK): build first, then the Core tests (+4 in
the new `NightSkyTests`). Checked: brackets / strings in every changed `.cs`, encodings kept, the sky shader extracted,
compiled and linked in headless WebGL2 (SwiftShader) and rendered (a moonlit star field, a gibbous moon close up, clouds);
the moon maths ported to Python against known events (the moon 0.4° from the sun at the 2024 Dallas eclipse totality,
first / last quarter 0.50 lit, full 1.00, sidereal time 280.47° at J2000). **No new keys.**

## In

| Item | What it does | Where |
|---|---|---|
| **Moon** | Its real place for the date, time and site (Schlyter's elements, the main perturbations, parallax: about ¼°) and its phase. Drawn as a disc (about twice the real size) lit on the side facing the sun, so the phase draws itself, with soft maria, earthshine on the dark side and a halo at night; a pale disc by day. | Core `Scene/LunarPosition.cs`; sky shader (`SKY_FS`) |
| **Phase** | NIGHT tab: **Actual**, then Full / Gibbous / Half / Crescent as little moon icons (drawn row by row, no font glyphs; the choice is named beside "Phase"). A chosen phase turns the light on the moon's face to give that lit fraction (it stays where it really is) and sets the moonlight's strength. | `SunSettings.MoonPhase` (null = real); `CurrentLighting` |
| **Moonlight** | Once the sun is 1° below the horizon the moon (when on and up) becomes the scene's light and casts the shadows: cool blue, about 1/6 of the sun at full and 100 %, by phase (a thin crescent still gives a little), fading in to −6° so the light never jumps. A moonlit night also lifts the ambient and the sky a little. **Moonlight** slider 0–200 %. | `SunLighting.Create(…, moon)`: `SunDirection` is the lighting / shadow light, `SkySunDirection` the real sun; `SceneRenderer` shadows also when `MoonLights` |
| **Stars** | Procedural stars on the celestial sphere (two layers, one star at most per cell, the 27 cells round each pixel so none is cut off), about a pixel wide at any zoom, tinted blue-white to orange, fading at the horizon, washed out by a bright moon, hidden by clouds. They **turn** with the local sidereal time round the pole at the site's latitude (south of the equator the south pole). Sliders: density, brightness, twinkle. | Sky shader `starLayer`, `nightSky`; `LunarPosition.LocalSiderealTime`, `EquatorialToTrueNorth`; `SkyLook.Stars`, `Celestial*` |
| **Milky Way** | A faint band along the galactic plane, brighter towards the galactic centre (Sagittarius), with dust lanes; slider 0–200 %. | `nightSky` |
| **NIGHT tab** | Sun panel: LIGHTING · SKY · **NIGHT**: Moon (on / off; "64 % lit, waxing · 23° up, NE"), Phase, Moonlight; Stars (on / off), Star density, Star brightness, Twinkle, Milky Way; RESET NIGHT. Saved with the model (`sun.json`). | `BuildNightTab` |
| **Clouds at night** | Lit by the moon (they were black). | `SKY_FS` |
| **CLEAR MARKERS gone** | Removed from the pause menu (it also fixes the review stack's button count). X (the clear key) still clears the active gun's markers; with the Comment gun it no longer deletes every comment: a toast points to COMMENTS. | `GameSession.Menu`, `CommentGun.ClearMarkers` |

Night shows only with shadows on (sun lighting), as the sky's colours always did. Reflection probes capture the sky
without stars (too coarse for points).

### Files on disk (additive)
`sun.json`: `moon` (default true), `moonPhase` (left out = real), `moonLight`, `stars` (default true), `starDensity`,
`starBrightness`, `starTwinkle`, `milkyWay`. Older files get the night sky on.

### Tests (+4)
`NightSkyTests.Moon_CoversTheSunInTheDallasEclipse`, `Phases_FullNewAndQuarters`, `Sky_TurnsRoundThePoleAtTheLatitude`,
`NightSettings_DefaultCleanCopyAndOlderFiles`.

## How to check it
1. **Build**, run the Core tests.
2. Shadows on (O), sun panel → set the time to 22:00. The sky goes dark; stars and the Milky Way show (away from city
   clouds: SKY → Cloud cover 0). Look round: stars fade near the horizon.
3. **Moon:** NIGHT tab shows its phase and where it is ("… · 23° up, NE"); turn to face it. Try a date near a full moon
   (e.g. 26 Oct 2026, or 23 Apr 2024): bright disc, shadows from the moon (outside, by a wall), cool light. Near a new moon
   (8 Apr 2024): no moon, darker scene.
4. **Phase:** NIGHT → the moon icons (full, gibbous, half, crescent): the disc's lit part and the moonlight change; Actual goes back. "Actual" fits its button.
5. **Turning sky:** play the sun (or step the time an hour): the stars wheel round the pole (south of the equator round
   the south celestial pole, at the site's latitude above the southern horizon).
6. **Twilight:** step from 17:00 to 20:00: the sun's shadows fade out, then the moon's fade in without a jump.
7. **Sliders:** Moonlight 0 (no moon shadows), Star density / brightness / Twinkle / Milky Way, RESET NIGHT. Save, reopen:
   kept.
8. **Clouds:** Cloud cover 60 % at night: moonlit clouds hide stars and moon.
9. **Pause menu:** no CLEAR MARKERS; with the Comment gun, X shows the toast and deletes nothing; with Measure, X clears.

## Fix after testing
- **Halo / orb round the moon** (Gavin's screenshot): the glow was only drawn within about 8° of the moon (the disc's
  early-out) and was still at about half strength there, so it ended in a visible circle. The glow is now drawn
  separately, falling off exponentially to nothing (tight round the disc, a faint wider haze). Re-rendered: no edge.

## Not in (W-B and later)
- Rain (cover map, streaks, wet look, lens drops, sound, lightning): W-B.
- Planets; the moon's libration and exact apparent size; light pollution; stars in reflections.
- Moonlight in the daylight / sun-hours studies (they stay sun-only).

## Things to look at when building
- `SunLighting.SunDirection` is now "the light" (the moon at night); the sky uses `SkySunDirection`.
- `DrawSky(…, stars)` gained an optional parameter (probes pass false).
- `GameSession.Sun` uses `Matrix4x4` (System.Numerics, already imported).
