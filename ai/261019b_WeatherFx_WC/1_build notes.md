# Round W, build W-C: lightning, lens drops, rain sound (2026-10-19)

Built on W-B (confirmed). **Not compiled here** (no .NET SDK): build first, then the Core tests (+4 in the new
`LightningTests`). Checked: brackets / strings / char literals in every changed `.cs`, encodings kept (new files LF, no
BOM), new member names across the `GameSession` partials, UI strings against the font atlas (only `·` beyond ASCII). The
storm was ported to Python and run for 10 minutes of each frequency at 1 ms steps: never 4 flashes within a second;
65 / 157 / 386 strikes an hour (rare / sometimes / often). Every shader extracted and compiled in headless WebGL2; the sky
and lens programs linked and rendered (a night strike with a bolt over the test block, a daytime strike, rain drops with a
trail and snowflakes melting). **No new keys.**

## In (sun panel → WEATHER, saved with the model)

| Item | What it does | Where |
|---|---|---|
| **Lightning** (rain only) | Tick **Lightning**; **Rare · Sometimes · Often** (about 65 / 157 / 386 strikes an hour). Each strike lights a **patch of the cloud deck** from inside (wider than tall, broken up by the clouds' billows; far strikes smaller and dimmer), the whole deck faintly, and three in four (fewer when far) show a **faint forked bolt** down to the horizon (dimmer inside the cloud). Weaker against a bright day sky, as real lightning reads. | Core `Scene/LightningStorm.cs`; `SKY_FS` `lightningSky`, `boltDistance` |
| **Flash on the scene** | 0–100 % (default 35 %): with shadows on the sky light lifts by a cool white (capped); in the classic light the frame brightens by at most × 1.3. 0 % = the sky only. | `SunLighting.WithLightning`; `SceneRenderer.ApplyFlash` |
| **Photosensitive safety** | Always: a strike flickers 1–3 times, at least 0.36 s apart (≤ 3 flashes in any second, WCAG 2.3.1), each rising over 0.06 s and fading (no hard on / off); strikes at least 4 s apart; the flash is capped. **Reduce flashing**: each strike is one slow glow (0.6 s up, 1.6 s down, 60 %). Lightning starts off; turning it on shows a one-line note; the tab says how to soften it. | `LightningStorm.Brightness` |
| **Thunder** | A synthesised rumble (three variants: a near crack, two distant rolls) after each strike: 0.8–6.3 s later and quieter the further off; quieter under a roof. | `Audio/WeatherSound.cs` |
| **Rain sound** | A looping hiss (soft wash, brighter hiss, scattered drop ticks), louder with Rainfall; quieter and muffled under a roof (eased, no jumps). Tick **Rain sound and thunder**. Snow is silent. | `WeatherSound` (its own waveOut stream, refilled each frame) |
| **Drops on the lens** (rain) | Now and then a drop lands on the lens: outdoors only, more when looking up (almost none looking down), more in heavier rain. Each shows the scene behind it flipped and magnified, softened, with a dark rim and a highlight; some slide down leaving a thinner trail; they fade after 2.5–6 s. | `LENS_VS` / `LENS_FS`; `SceneRenderer.DrawLensDrops`; `SimulateLensDrops` |
| **Flakes on the lens** (snow) | Snowflakes land as frosted six-armed crystals and melt into drops (some then slide). | same |
| **Never in pictures** | The drops are drawn on the main view only: not in photos, photo mode, videos, bookmark / comment thumbnails or screenshots. Lightning does show in photos and videos (the storm follows the clock, so video frames match). | `DrawLensDrops` gate |

The probes never re-bake for a flash (they're keyed on the lighting without it). Moved / hidden elements: the "under a
roof" test uses the cover map (W-B).

### Files on disk (additive)
`sun.json`: `lightning` (false), `lightningFrequency` (0 rare – 2 often, 1), `lightningFlash` (0–1, 0.35),
`reduceFlashing` (false), `lensDrops` (true), `weatherSound` (true). W-B files get no lightning, drops and sound on.

### Tests (+4)
`LightningTests.NeverMoreThanThreeFlashesInAnySecond`, `ReduceFlashing_OneSlowGlowPerStrike`,
`SameClock_SameStorm_OftenMeansMore`, `LightningSettings_DefaultCleanCopyAndOlderFiles`.

## How to check it
1. **Build**, run the Core tests.
2. WEATHER → Rain. The **rain sound** starts (louder at Rainfall 100 %). Walk under a roof / indoors: quieter and
   muffled; back out: back up. Untick **Rain sound and thunder**: it fades out.
3. **Lens drops:** outdoors, look up: drops land now and then, some slide down with a trail, they fade. Look down: almost
   none. Go indoors: no new ones. Untick **Drops on the lens**: none. Take a photo (M) and a bookmark thumbnail: no drops in
   them.
4. **Snow:** WEATHER → Snow, look up: flakes land frosted and melt into drops.
5. **Lightning:** Rain → tick **Lightning** (a note appears) → **Often**. Set 22:00 (shadows on): patches of cloud light up
   round the sky, some with a faint bolt; the scene brightens softly; thunder follows a few seconds later (sooner after
   the bright, near ones). Indoors: thunder quieter.
6. **Flash on the scene** 0 %: only the sky lights; 100 %: a stronger (still soft) scene flash. Shadows off (classic
   light): the sky still lights and the frame brightens a little.
7. **Reduce flashing:** each strike becomes one slow glow, no flicker.
8. **Daytime:** 12:00: the patches read weaker against the grey sky, bolts faint.
9. **Video:** record a short tour with lightning: strikes appear in the video, no lens drops.
10. **Save, reopen:** kept. RESET WEATHER turns lightning off and the drops / sound back on.

## Not in
- Lightning in snow (thundersnow); lightning lighting the ground from its direction (the flash is ambient); lightning in
  reflections; sound in videos; snow / wind sound; splashes; rain on windows seen from inside.

## Things to look at when building
- `RenderScene` now calls `UpdateWeather()` first (the flash lifts the lighting) and sets `_renderer.Lighting` from
  `FrameLighting()`; `ProbeSceneKey` hashes `_probeLighting` (without the flash).
- `RenderTarget.Framebuffer` added (the lens drops copy the frame into a texture of their own).
- `WeatherSound` opens a second waveOut device the first time rain or thunder is heard (it doesn't use `waveOutSetVolume`,
  which on Windows changes the whole app's volume).
