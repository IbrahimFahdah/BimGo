# Round K, build K-A: brief (2026-10-18)

Baseline: `BimGo_Polish_PC` (Gavin's working copy; P-C confirmed "all works", so its README §8 entry goes). Scope from the
roadmap brief (`claude/BimGo_Roadmap_Polish_Flythrough_Brief.md`, Round K) and the Round K answers in
`ai/261018d_Handoff/0_handoff.md` §2b (MEDIA panel; a tour is a path type; follow + per-key override heading; smoothness
per path and key at constant speed; fly + snap editing; keys carry sun time and colour profile; split K-A / K-B / K-C).

K-A: Core path model + timeline + tests, playback and video from a path, and the MEDIA shell (PHOTO and VIDEO tabs move
in; TOUR and PATHS tabs with a simple key list).

## Answers to K-A's own questions (AskUserQuestion, 2026-10-18; all the recommended options)

| Question | Answer |
|---|---|
| MEDIA panel layout | **List + editor** (like CLASHES): tabs on top, the paths (or stops) listed left, the selected item's editor right; PHOTO and VIDEO use the width |
| Photo and video in K-A | **Settings move in**: PHOTO holds photo mode's settings + OPEN PHOTO MODE (M still goes straight there); VIDEO takes the size / rate out of TOUR SETTINGS and adds a source picker (tour or a path) and RECORD |
| Opening MEDIA | **Shift+M + a pause-menu button** (gamepad: through the pause menu) |
| Editing a key's fields | **Selected-key editor**: pick a key, its fields show as steppers and toggles with SET TO CURRENT VIEW, GO TO, up / down, DELETE; path settings in a strip above |

Not asked (obvious defaults): `paths.json` beside `bookmarks.json` (model folder) and inside the `.bimgo` (additive,
`formatVersion` 1).
