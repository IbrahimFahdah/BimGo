# Round W, build W-B: brief (2026-10-19)

Baseline: Gavin's `BimGo_Night_WA` working copy (W-A with its fixes; Gavin moved on to rain: taken as confirmed).
Handoff: `ai/261018j_Handoff/0_handoff.md`.

Gavin, starting the build: "time to make it rain! Whilst we're at it i feel like the system could potentially support
snow as well, with the difference that vertically exposed surfaces could be capped in white or something like that to
simulate snow buildup at v high/basic level potentially?"

## Answers (AskUserQuestion, 2026-10-19; all the recommended options)

| Question | Answer |
|---|---|
| Snow | **One WEATHER switch**: Off · Rain · Snow on a new WEATHER tab. Snow: slow drifting flakes plus white caps on up-facing outdoor surfaces (and the ground), a "cover" slider for how much has settled; shares rain's cover map, so nothing gets snow under roofs |
| Split | **Two builds**: W-B = cover map, falling rain / snow, wet and snow looks, WEATHER tab; W-C = lens drops, rain sound, lightning and thunder |
| Lighting | **Works in both** lights: falling rain / snow and the wet / snow look in the classic light too; cloud thickening and dimming only with sun lighting |
| Thunder (W-C) | **Delayed rumble** after each flash (random delay, quieter under a roof) |

Decided without asking (handoff's open points): controls in a **WEATHER** tab beside NIGHT, saved in `sun.json`;
**no hotkey** (no `InputCatalog.DEFAULTS_VERSION` change).
