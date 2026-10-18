# Build A: colour profiles, parameter rules in search sets (2026-10-17)

Built on Gavin's Grids B2 working copy. Not compiled here (no .NET SDK, no Revit API): build first, then run the Core tests.

Checked:
- Brackets / strings on every C# file, by script.
- New member names across the partials.
- UI strings in the font (every non-Latin-1 character is in `UiFont.EXTRA`).
- Encodings unchanged (BOM kept where files had one; LF).
- Shaders: SCENE_VS + SCENE_FS, SCENE_VS + GEOMETRY_FS, SCENE_VS + CAP_STENCIL_FS compile, link and validate in headless WebGL2 (every sampler on its own unit).
- A WebGL2 render test of the profile code path: three quads, element 0 coloured, 1 ghosted, 2 untouched.
  - Pass 0: all grey.
  - Pass 1: red / discarded / grey.
  - Ghost pass: only element 1, grey at 12 %.
  - Plan: element 1 pale.

## In

### Core

- `Clashes/ClashModels.cs`:
  - `RuleField.PHASE` ("phase": existing / new / between / unphased, with labels) and `RuleField.PARAMETER` ("parameter").
  - `RuleField.All` is the built-ins (phase added); parameters follow in the UI, one entry per extracted name.
  - `SetRule.Parameter` (the name; null and not written for other fields), kept by `Normalise`, `Copy`, `SetField(field, parameter)`, `IsField`.
  - Older builds read a parameter rule's field as "Revit category" (matches nothing they know): additive.
- `Clashes/SearchSets.cs`:
  - `Matches` / `GroupMatches` / `RuleMatches` take the element's index (optional, −1 = a stand-in with no parameter row); `ElementsIn` passes it.
  - Parameter rules read the value once per rule (missing = empty: "(no value)"); phase rules match the stored value or its label.
  - `ParameterValue`, `ElementValue` (one element's value + label for any field), `NO_VALUE`.
  - `ValuesOf(scene, field, parameter)`, `ValueLabel` (phase labels, "(no value)"), `FieldLabel(field, parameter)` / `FieldLabel(rule)`.
- `Scene/ModelInfo.cs` (`ParameterTable`):
  - a name → index map built in the constructor (case ignored; read-only after, so clash runs on a worker thread are safe);
  - `IndexOfName`, `ValueOf(element, nameIndex)` (no allocation), `SortedNames`.
- `Scene/AppearanceProfiles.cs` (new):
  - `ProfileKind` (bySet / byValue), `UnmatchedLook` (ghost / normal / flat).
  - `ProfileRule` (setId or value + label, colour, on), `AppearanceProfile` (name, kind, field, parameter, palette, unmatched, unmatchedColour, detail, rules; `Clean`, `Copy`).
  - `AppearanceSettings` (profiles, active, on, legend; `Clean`, `Copy`).
  - `ProfileResult` (per-element packed RGBA8 codes, per-row counts, unmatched, any ghost, missing sets).
  - `AppearanceProfiler`:
    - palettes Bright / Soft / Deep (12 each, then golden-angle hues);
    - `NewBySet`, `NewByValue`, `SyncValues` (adds new values, keeps edited rows and rows for values that are gone), `ApplyPalette`, `SetField`, `Describe`;
    - `Evaluate`: by set, first matching row wins, off rows skipped; by value, one lookup per element; library templates untouched;
    - codes: A = 0 normal, 1 ghost, 2 hidden (reserved for B), 255 coloured.
- `Format/VisibilityModels.cs`: `VisibilitySettings.Appearance` (left out with no profiles; cleaned on read).
- `Scene/InputCatalog.cs`: `InputAction.ColourProfile` (Views and tools, **Shift+C**), live in clash mode too.

### App

- `Rendering/Shaders.cs`:
  - SCENE_VS: `aElement` (location 6), `uProfilePass`, `uProfileTex`; fetches the element's texel (`PROFILE_WIDTH` 1024 a row) into `flat vProfile`.
  - SCENE_FS:
    - pass 1 discards ghosts (except the plan minimap, which draws them pale), pass 2 draws only ghosts, code 2 always discards;
    - coloured elements take the colour over any colour mode, keeping `uProfileDetail` of the surface's shade (luminance × 1.8, clamped 0.25–1.6);
    - lighting, shadows and reflections stay.
  - GEOMETRY_FS: ghosts / hidden left out of the AO pre-pass.
- `Rendering/SceneRenderer.Profile.cs` (new):
  - the element stream (float per vertex, made on first use, both VAOs), the profile texture (unit 15, RGBA8, NEAREST);
  - `SetProfile`, `SetProfileDetail`, `ClearProfile`, `ProfileOn`, `ProfileGhostsWanted`;
  - `DrawProfileGhosts` (opaque + glass ranges and moved instances, grey glass 12 %).
- `Rendering/SceneRenderer.cs`:
  - uniform locations; samplers set to unit 15 (scene, geometry, and the cap stencil program in `SceneRenderer.Section.cs`);
  - `ApplyUniforms` picks the pass: none for highlights and under the clash view's ghost / wireframe;
  - probe captures switch the profile off.
- `Game/GameSession.ColourProfiles.cs` (new):
  - state, restore / save with the visibility;
  - `UpdateProfile` (evaluates only when something changed; by set switches clash detection's sets on);
  - `ProfileLookChanged` (show / legend / detail: no new evaluation);
  - `ProfileSetsChanged` (from `ClashSetupChanged`);
  - Shift+C (`ToggleProfile`), the legend.
- `Game/GameSession.ColourProfilesPanel.cs` (new): the COLOUR PROFILES panel (see README §8).
  - The colour picker runs after the overlays draw.
  - EDIT SETS… opens CLASHES → SETS; closing it comes back (`CloseClashes`).
- `Game/Clashes/GameSession.ClashPanel.cs`:
  - the rule field dropdown lists the built-ins then "PARAMETER: <name>" per extracted parameter;
  - the value picker, labels and text boxes use the parameter's name;
  - one hint per session when no parameters were extracted.
- `Game/Clashes/GameSession.Clashes.cs`: the library template stand-in carries its phase.
- `Game/GameSession.Appearance.cs`: the two LATER placeholders replaced by *Colour profiles ›* (summary: active profile · on / off; no allocation).
- `GameSession.Render.cs`:
  - `UpdateProfile` before the passes;
  - the ghost pass before the glass pass;
  - the legend in the HUD;
  - a help row.
- `GameSession.ClashMode.cs`: Shift+C live in clash mode; the ghost pass in the real model view.
- `GameSession.ClashDock.cs`: the legend in the clash HUD.
- `GameSession.cs`: Shift+C walking; Esc closes the panel.
- `GameSession.Menu.cs`: panel routing.
- `GameSession.Visibility.cs`: restore / save `appearance`; bookmarks leave it out.

### Revit

- Options → Parameters heading: "EXTRA PARAMETERS (SCAN GUN, SEARCH SET RULES AND COLOUR PROFILES; SAVED IN .BIMGO FILES)".
- No extraction change: the extra parameters were already captured for host and linked elements (instance value, else the type's).

### Tests

- `AppearanceProfileTests` (10):
  - parameter lookup;
  - parameter and phase rules;
  - `SetRule.Parameter`;
  - values with "(no value)";
  - clashes.json round trip;
  - by-value codes / counts / unmatched looks;
  - refresh and field change;
  - by-set first match / off rows / missing sets;
  - palettes;
  - settings clean + visibility.json round trip.

## Decisions taken while building

- **The selected profile is the active one** (one concept, not two): clicking a profile in the list makes it active.
- **Off switch per row** came forward from B (cheap).
- **Detail default 35 %.**
- **Shift+C:**
  - C is the grids cycle, and Shift+C was free in walking and clash mode;
  - a binding with modifiers wins, so C alone still cycles grids.
- **Ghosted elements still cast shadows** (sun and lights), to keep the shadow passes untouched; noted in §8.
- **By-value refresh:**
  - opening a model (and F5, which starts a new session) adds rows for new values;
  - rows for values that are gone stay (count 0, hidden from the legend) so their colours survive.
- **The legend** sits on the left under the status / coordinate panels (the right has the minimap, gun panel and clash dock).
- **Bookmarks don't store profiles.**
