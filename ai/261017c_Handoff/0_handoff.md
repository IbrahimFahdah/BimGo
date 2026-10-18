# BimGo: handoff for a new chat (after C-C3: water / grass options, then grids and levels)

**Context:** BimGo is Gavin's personal project (publisher **Aussie BIM Guru**, **MIT-0**, C# / Visual Studio, .NET 8, its
own OpenGL renderer over Silk.NET).

How Gavin works:
- He works in **rounds**: discuss → ask questions with AskUserQuestion (recommended option first, at most 4 per call) → build → deliver a zip.
- Each round's notes go in `ai/<yymmdd><letter>_<topic>/` (`0_brief.md` with the answers, `1_build notes.md`), plus README updates and a project doc (`claude/BimGo_<Round>_BuildNotes.md`).
- Each build says **what is in, what isn't, and how to check it step by step** (README §8, newest first).
- For simple build or test errors and small tweaks, he wants **just the fix** (a snippet).
- When he's away he says "assume recommended options": do so and list the decisions in the build notes.

**Read first:**
1. This handoff.
2. `README.md`: *For AI assistants*, §5 (rendering, materials, grass, sun panel), §6, §8 (newest three), §9.
3. **Ask Gavin for a fresh zip of his working copy before editing.**

## 1. Where BimGo is now (2026-10-17)

**Clash detection is done for now.** The latest clash builds:
- **C-C2** (`261017a_Grouping_C2`): grouping tools (box / full height / edit box / recollect, pick points, cluster sphere, auto by level / category pair) and the dock layout. Gavin: "all working as intended".
- **C-C3** (`261017b_Reports_C3`): click a dot to go to that clash, G live in the tools, and HTML + XML reports (a card with scope / format / pictures / groups; rendered pictures; self-contained HTML; Navisworks-style XML). Check C-C3's build result with Gavin first.

## 2. Next, small: water and grass options

1. **Turning off water / grass animation for FPS:** answered (2026-10-17). It **doesn't help**, so the speed setting is a look option only.
   - Water ripples are six `cos` per water pixel (`Shaders.cs` `waterNormal`), and the cost is the same whether `uTime` moves or not.
   - Grass sway is two `sin` per blade vertex, beside a much larger blade cost.
   - Turning grass blades **off** or lowering density / distance (already in the Appearance tab → Grass) *does* save GPU time.
   - Ripple **strength 0 %** could skip the six waves (a small saving on large water at 4K).
2. **Water ripple strength and speed:** sliders on the Appearance tab's *Water ›* page (beside colour / reflection), such as strength 0–200 % and speed 0–200 % (0 = still).
   - Uniforms scale `amount` and the `uTime` term in `waterNormal`.
   - Saved like water colour / reflection, and optionally in the Revit Options window (Materials).
   - Maybe also **grass sway** 0–200 % on the *Grass blades ›* page.
   - Stage questions: per model vs per machine, range, and the Revit Options too.

## 3. Then, its own round: grids and levels

Gavin wants:
- **grids and levels drawn in the model**;
- **nodal intersections** of the grid / level planes (see grid A1 at Level 1, 2, 3…);
- **grids on all levels or the level underfoot**;
- available while **walking and in clash mode**, with **its own control menu like the sun settings**.

What exists:
- `SceneData.Levels` (`LevelInfo`: name, elevation, sorted; used by the level fits, `LevelIndexAt`, the clash level filter).
- **No grids are extracted yet.**

To plan, and ask Gavin:
- **Extraction (Revit):**
  - Grids: name, curve (lines and arcs; multi-segment grids), extents, 2D / 3D extents, from the host and maybe from links (transforms).
  - Levels already exist; maybe add whether a level is a building storey.
  - Store as an additive `grids.json` in `.bimgo` (`formatVersion` stays 1).
  - In live sessions, refresh grids on F5, and decide whether `scene.update` needs an additive message.
- **Rendering (overlay):**
  - Grid lines on a level plane (dashed, the Revit style, or BimGo's own), with bubbles / labels at the ends (world-anchored billboards like the comment markers).
  - Level lines or planes (a faint plane, an edge band, or labels on the grid line ends).
  - **Nodes:** markers where grids cross on each shown level, labelled "A1 · L2". Hover / click to show coordinates and maybe snap / teleport there.
- **Control menu:** a panel like the sun panel (key to be agreed: check `ControlsTests` for a free key) with:
  - grids on / off;
  - which levels: all / underfoot / a picked set;
  - levels on / off;
  - nodes on / off;
  - labels;
  - colour / opacity;
  - see through walls (x-ray like the clash dots) or depth-tested;
  - line width;
  - link grids on / off.

  It works in walking, fly and clash mode (clash mode's HUD and the dock: avoid overlap), and is saved per model.
- **Uses:**
  - clash cards and the report could name the nearest grid intersection ("near C4 · Level 2"), as Navisworks' `gridlocation` does;
  - the minimap could draw grids;
  - measuring could snap to grid nodes.
- **Stage answers** for scope and phasing (build A: extraction + drawing + panel; build B: nodes, labels, clash grid location).

## 4. Later

- **Polish:**
  - README §8 "to verify";
  - search set parameter rules;
  - deeper rule groups;
  - Appearance colour by parameter / search set;
  - grass on moved / hidden elements and in probes;
  - groups in the CLASHES panel's list and gamepad grouping.
- **Installer:** `claude/BimGo_Installer_Handoff.md`.
- **Hotkey review:** taken in clash mode:
  - Y, G, B, P, 0, 1–5, `,` `.`, Enter, R;
  - Ctrl+A, Ctrl+G, Ctrl+Shift+G;
  - suggested for PICK POINTS (not bound): K.

## 5. Things to watch

- C# can't be compiled in the sandbox (no .NET SDK, apt blocked), so say so.
  - Check brackets, strings and interpolation by script (a checker in the C-C2 / C-C3 rounds).
  - Check new member names against all `GameSession` partials.
  - Scan UI strings against the font atlas (Latin-1 + `UiFont.EXTRA`; ▾ is not in it: dropdowns draw their chevron).
- Keep file encodings as they were: some files have a UTF-8 BOM, some don't; all use LF.
- Shaders can be checked in headless WebGL2 (Playwright + `/opt/pw-browsers/chromium`).
- Panels with overlays call `BeginOverlays` / `DrawOverlays`. Anything that opens a file dialog runs after `DrawOverlays`, including callbacks from confirms: set a flag, as C-C3's `_clashReportAction = 5` does.
- `.bimgo` `formatVersion` 1, `clashes.json` version 1 and live protocol 1: additive changes only.
