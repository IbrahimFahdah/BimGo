# Colour profiles, build A: brief (2026-10-17)

Gavin: grids went well; next is overriding element appearance by property values.
- It should work through **search sets**: override a search set's elements with a colour.
- Search sets need **element parameters** (the extra parameters carried into the model), if they don't have them yet.
- Colour either **by search set** or, as an alternative, **by the possible values of a parameter**.

## Answers (AskUserQuestion)

| Question | Answer |
|---|---|
| Profile structure | **Named profiles, two kinds**: by search set (sets → colour, first match wins) or by value (a field or parameter → one colour per distinct value, auto palette + edit). Saved per model, one active |
| Unmatched elements | Gavin's own option: **ghosted, default (normal) colours, or a flat colour override** (picked per profile) |
| Blend with the colour mode | **Overlay on any mode, tinted textures** (lighting kept; a "surface detail" slider lets the texture show through) |
| Fields | **Extracted parameters + built-ins** (BimGo / Revit category, family, type, level, model, phase); no new Revit picker; tick more in Options and Go / F5 again |
| Numbers | **Numeric operators + gradient** (≥ / ≤ / between in set rules; a numeric field as a gradient with bins) |
| Per-rule extras | **Transparency per rule**, **hide per rule**, **off switch per rule** |
| Legend and access | **On-screen legend**, **legend in photos / screenshots**, **hotkey** to toggle the active profile, **import / export** profiles JSON |
| Phasing | **A then B** |

## Build A (this build)

- Rendering path: per-vertex element index + a per-element colour texture; ghost pass.
- Parameter (and phase) rules in search sets.
- Both profile kinds, palettes, the colour picker, rows on / off (the off switch is cheap, so it came forward from B).
- Unmatched: ghosted / normal / flat colour.
- Surface detail slider.
- Legend; Shift+C (walking and clash mode).
- Saved per model in `visibility.json`.

## Build B (next)

- Numeric rules (≥ / ≤ / between) and gradient colouring for numeric fields.
- Transparency and hide per row (the renderer's code 2 "hidden" is reserved for it; picking / collision must follow).
- Legend in photos / screenshots (opt-in).
- Import / export profiles (JSON files, like clash setup files).
