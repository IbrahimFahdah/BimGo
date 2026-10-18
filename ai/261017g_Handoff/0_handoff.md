# BimGo: handoff for a new chat (after grids A / B: appearance profiles and colour by parameter next)

**Context:** BimGo is Gavin's personal project:
- publisher **Aussie BIM Guru**, licence **MIT-0**;
- C# / Visual Studio, .NET 8;
- its own OpenGL renderer over Silk.NET;
- a Revit add-in (`BimGo.Revit`) plus a standalone app (`BimGo.App`) and `BimGo.Core`.

How Gavin works:
- He works in **rounds**: discuss → ask questions with AskUserQuestion (recommended option first, at most 4 per call) → build → deliver a zip.
- Each round's notes go in `ai/<yymmdd><letter>_<topic>/` (`0_brief.md` with the answers, `1_build notes.md`), plus README updates and a project doc (`claude/BimGo_<Round>_BuildNotes.md`).
- Each build says **what is in, what isn't, and how to check it step by step** (README §8, newest first).
- For simple build or test errors and small tweaks, he wants **just the fix** (a snippet).
- He often adds requests mid-build: fold them in and say where they landed.
- When he's away he says "assume recommended options": do so and list the decisions in the build notes.

**Read first:**
1. This handoff.
2. `README.md`: *For AI assistants*, §5 (rendering, materials, grids), §6, §8 (newest three), §9.
3. **Ask Gavin for a fresh zip of his working copy before editing.**

## 1. Where BimGo is now (2026-10-17)

All of these were built and confirmed by Gavin today:

| Round | Folder | What |
|---|---|---|
| Clash grouping tools C-C2 | `261017a_Grouping_C2` | Grouping tools and the dock layout |
| Clash reports C-C3 | `261017b_Reports_C3` | HTML / XML reports, dot clicks |
| Water and grass, build W | `261017d_Water_W` | **Water → Ripples, Ripple speed, Wave size** and **Grass → Sway** (per machine, also in Revit Options → Materials) |
| Grids A | `261017e_Grids_A` | Grids from the host and links (lines, arcs, multi-segment, 3D extents) and storeys in `grids.json`. Lines, bubbles, level tags and outlines on the chosen levels (off / underfoot / above / below / ±1 / nearest / all), faint / hidden / x-ray. **C** cycles, **Shift+G** opens the GRIDS & LEVELS panel; it works walking and in clash mode and is saved per model (`visibility.json` → `grids`) |
| Grids B | `261017f_Grids_B` | Solid (default) / dash-dot lines. **Nodes:** rings at intersections; hover shows "A-1 : Level 2" plus coordinates; click (grids panel open, or clash mode) goes there; the Teleport gun blinks there and the Measure gun snaps. Minimap grids. **Clash grid location** "Near C-4 : Level 2" (clash card, HTML report *Grid* / *By grid*, XML `gridlocation`). **AUTO: BY GRID / BY GRID + LEVEL.** *In clash comments* option (off by default) |

**Two fixes went out with this handoff** (check them with Gavin first):
- `InputState` ambiguity in `GameSession.GridNodes.cs`: solved with an alias, `using InputState = BimGo.Platform.InputState;`.
- The Appearance tab's *Water ›* page ran past the card (the status line overlapped the bottom), visible in the options preview. Its four sliders now sit two to a row (Reflection | Ripples, Ripple speed | Wave size), which saves two rows.
- The card height is `RIGHT_CARD_HEIGHT = 440` in `GameSession.Menu.cs`, and the options preview's frame in `GameSession.Appearance.cs` uses it too.
- The new round's pages must fit 440 px (minus the 14 px top padding), or raise the constant and check the pause menu at 1280 × 720.

## 2. Next: appearance profiles and colour by parameter (its own round)

Gavin's words: "appearance profiling / application by parameters".

What exists:
- The Appearance tab's main page has a COLOUR BY row (debug: reflection tier / probe) and two greyed placeholder rows: **"By parameter value"** and **"By search set"** (`PlaceholderRow`, `GameSession.Appearance.cs`).
- **Parameter values:**
  - `SceneData.Parameters` (`ParameterTable`, `Scene/ModelInfo.cs`) holds the *extra* parameters picked in Revit Options (names pooled, per-element rows).
  - Elements also carry category, family / type, level, phase role, link and workset? (check `ElementRecord`).
  - Only the parameters ticked at export are available: the round may need a "parameters for colouring" pick in Revit Options, or to use the ones already extracted.
- **Search sets:** `Clashes/SearchSets.cs` (`SearchSets.Matches(set, scene, element)`), with rules on catalog / category / family / type / level / link (and the parameter rules listed as "later" in README §4 polish). They are reused here.
- **Rendering:**
  - Vertices are `SceneVertex` (28 bytes: position, normal, packed colour); there is **no per-vertex element id**.
  - The clash view colours a pair by drawing those elements again with an override colour, which is fine for two elements but not for thousands.
  - Options to weigh and ask about:
    1. Rewrite the colour stream into a second VBO per profile (CPU, once per profile change; memory = one uint per vertex).
    2. Add an element-index vertex stream and a per-element colour texture (one fetch per vertex; flexible, re-colours instantly; needs a stream from `SceneBatches` element ranges).
    3. Per-element draws (too slow for large models).
  - Recommend 2 (or 1 if simpler), and check how `SceneBatches` / the renderer bind the vertex layout first.
- **Colour modes:** Whitecard / Material / Realistic (`ColourMode`). Colour-by would be a fourth view state or an overlay on any mode: ask.

Questions to ask at the start (recommendation first):
1. **What drives the colour:**
   - parameter value (categorical: one colour per distinct value, auto palette + edit);
   - numeric ranges (gradient / bins);
   - search sets (one colour per set, first match wins);
   - all three.
2. **Profiles:**
   - named, saved per model (like Navisworks appearance profiler: a list of rules → colour + transparency);
   - one active at a time;
   - importable / exportable JSON (like clash setup files);
   - per machine vs per model.
3. **Unmatched elements:** ghosted (grey glass like the clash view), whitecard, or their normal colours.
4. **Transparency per rule** (yes / no), and **hide per rule**.
5. **Which parameters:**
   - the already-extracted extra parameters plus built-ins (category, family, type, level, phase, link, workset if extracted);
   - or add a picker in Revit Options for "appearance parameters";
   - live sessions: refresh on F5.
6. **Legend:** an on-screen legend panel (colour swatches + values + counts), in screenshots / photos too (yes / no).
7. **Where:**
   - the Appearance tab ("By parameter value" / "By search set" rows become real);
   - plus a hotkey to toggle the active profile (find a free key: Situations / `ControlsTests`);
   - plus clash mode (G view modes) interplay.
8. **Phasing:**
   - A = rendering path + by-parameter categorical + legend + per-model profiles;
   - B = numeric ranges, search-set rules, transparency / hide, import / export.

## 3. Later

- **Polish:**
  - README §8 "to verify";
  - search set parameter rules and deeper rule groups;
  - grass on moved / hidden elements and in probes;
  - groups in the CLASHES panel's list;
  - gamepad grouping;
  - grid location on dock rows;
  - a gamepad binding for the grid keys;
  - grids in photos (opt-in).
- **Installer:** `claude/BimGo_Installer_Handoff.md`.
- **Hotkey review:**
  - walking now also takes **C** (grids cycle) and **Shift+G** (grids panel); both are live in clash mode;
  - clash mode takes Y, G, B, P, 0, 1–5, `,` `.`, Enter, R, Ctrl+A, Ctrl+G, Ctrl+Shift+G;
  - suggested for PICK POINTS (not bound): K.

## 4. Things to watch

- **Compiling:** C# can't be compiled in the sandbox (no .NET SDK, apt blocked), so say so.
  - Check brackets, strings and interpolation by script (write a small checker; the grids rounds used one).
  - Check new member names against all `GameSession` partials.
  - Scan UI strings against the font atlas (Latin-1 + `UiFont.EXTRA`).
- **Name clashes:**
  - In App files, add `using BimGo.Platform;` for `InputState`, or alias it as `GameSession.GridNodes.cs` now does (an ambiguity bit grids B).
  - In BimGo.Revit, qualify Revit types that clash with WPF / WinForms (`DB.Grid`, `DB.Line`…).
- **Encodings:** keep them as they were (most `.cs` / `.xaml` files have a UTF-8 BOM, `README.md` doesn't); all files use LF.
- **Shaders:** check them in headless WebGL2 (Playwright + `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`).
  - Precision lines needed: float, int, sampler2D, sampler2DArray, sampler2DShadow, sampler2DArrayShadow, samplerCube.
- **Panels:**
  - Panels with overlays call `BeginOverlays` / `DrawOverlays`; file dialogs run after `DrawOverlays`.
  - The pause menu card is 440 px; the grids panel is 632 px (fits 720 p).
- **Compatibility:** `.bimgo` `formatVersion` 1, `clashes.json` version 1 and live protocol 1: additive changes only.
  - New entries so far: `grids.json`; `visibility.json` → `grids`; level `storey`; clash group `auto` values `grid` / `gridLevel`.
