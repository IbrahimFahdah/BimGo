# Build B: colour profile ranges, see-through / hidden rows, number rules, files (2026-10-17)

Built on build A (no compile fixes were needed). Not compiled here (no .NET SDK): build first, then run the Core tests.

Checked:
- Brackets / strings, by script (the checker now knows `'\uXXXX'`).
- New member names: one definition each.
- The number parser against a Python port (all test cases).
- UI strings in the font.
- Shaders compile, link and validate in headless WebGL2.
- Render test: coloured, ghost and 50 % see-through elements in pass 1, the blended pass and the plan.

## In

### Fix (build A)

- `CAP_STENCIL_FS` discards ghosted, hidden and see-through profile elements.
- `DrawCapScene` sets `uProfilePass` (as the scene passes: not under the clash view's ghost / wireframe).
- So ghosted elements get no section box caps.

### Core

- `Clashes/ClashModels.cs`:
  - `RuleOp.AT_LEAST` / `AT_MOST` / `BETWEEN` ("atLeast" / "atMost" / "between"; labels "AT LEAST (≥)", "AT MOST (≤)", "BETWEEN");
  - `IsNumeric`, `MaxValues` (between keeps 2);
  - `IsComplete` needs parseable numbers;
  - `SetOperator` clears the values when switching between number and name operators.
- `RuleNumbers` (new, in ClashModels.cs):
  - `TryParse`: the first number in a text.
    - Group separators: space, NBSP, thin space and apostrophe.
    - A comma is a thousands separator when three digits follow it, otherwise a decimal mark.
    - A leading minus counts unless a digit comes right before it.
  - `All` ("300 to 600", "300-600"), `Format`.
- `Clashes/SearchSets.cs`:
  - `NumberMatches` / `NumberOf` (any field, a parameter's text or a built-in's value);
  - `Describe` "X is between a and b";
  - `ValuesOf(LINK)`: links sharing a title read as their instance names.
- `Scene/AppearanceProfiles.cs`:
  - `ProfileRule`: `From` / `To`, `Transparency` (0–0.9), `Hidden`.
  - `AppearanceProfile`: `Ranges`, `Bins` (2–12, 5), `Ramp`.
  - `AppearanceSettings.LegendInShots`.
  - `ProfileResult`: `AnyBlended`, `AnyHidden`, `NoNumber`.
  - `AppearanceProfiler`:
    - ramps (five stops each), `RuleCode`;
    - codes: 2 hidden, 128–254 see-through with opacity (code − 128) / 126, 255 solid;
    - `BuildRanges` (equal bins, unit suffix from the commonest text, "600 – 800 mm"), `ApplyRamp`, `FormatNumber`;
    - ranges evaluation (first row whose range holds the number);
    - `SyncValues` skips ranges; `SetField` rebuilds ranges.
  - `ProfileFile` / `ProfileFiles` ("bimgo-colour-profiles" v1): `Build`, `Export`, `Parse` / `Read`, `Merge`.
    - Merge matches sets by name or adds them; profiles get new ids; a taken name gets " (imported)".

### App

- Shaders:
  - SCENE_FS draws see-through colours (128–254) in the blended pass (pass 2) at the row's opacity, ghosts as before;
  - GEOMETRY_FS and the caps leave them out.
- `GameSession.ColourProfiles.cs`:
  - `ApplyProfileHidden`: hidden rows hide their elements like the Scan gun (degenerate indices, so no shadows; pick / collision masks) while the profile shows, only changed elements touched;
  - `ProfileHides` is used by `RefreshMasks`, `SetUserHidden`, `SetStaticHidden` and the lights;
  - legend: counts with "hidden" / "50 %", "without a number" footer;
  - `DrawProfileLegend` (top or bottom anchored), `QueueProfileLegendForShot`.
- `GameSession.Render.cs` (F12) and `GameSession.Photo.cs` (stills, not 360s): the legend when *In photos* is ticked.
- `GameSession.ColourProfilesPanel.cs`:
  - *In photos* tick;
  - EXPORT… (this one / all) and IMPORT… (run after the overlays);
  - VALUES Each value / Ranges, BINS − / +, REBUILD RANGES, Ramp dropdown;
  - per row: transparency dropdown, HIDE / HIDDEN.
- `GameSession.ClashPanel.cs`: number operators type their values (`BeginClashRuleNumber`); value labels "TYPE A NUMBER…", "300 – 600".

### Tests

`AppearanceProfileTests` (now 16):
- number parsing;
- number operators;
- ranges;
- see-through / hidden codes;
- profile files and merge;
- link instance names.

The scene gained a *Width* parameter.

## Decisions taken while building

- **Ramps:** a fourth ramp, *Light → dark* (single hue), for printing.
- **Ramp changes recolour at once** (no confirm, unlike the palette: ranges are rebuilt freely anyway).
- **Ranges are not rebuilt automatically** on open / F5 (the user's bin colours survive): REBUILD RANGES does it.
- **Hidden rows hide while the profile shows**, in every view, including clash mode's ghost view.
- **The legend in shots is screen-sized**, bottom left; 360s never get it.
