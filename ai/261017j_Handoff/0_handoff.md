# BimGo: handoff for a briefing chat (after colour profiles A / B)

**Context:** BimGo is Gavin's personal project:
- publisher **Aussie BIM Guru**, licence **MIT-0**;
- C# / Visual Studio, .NET 8;
- its own OpenGL renderer over Silk.NET;
- a Revit add-in (`BimGo.Revit`) plus a standalone app (`BimGo.App`) and `BimGo.Core`.

How Gavin works:
- He works in **rounds**: discuss → ask questions with AskUserQuestion (recommended option first, at most 4 per call) → build → deliver a zip.
- Each round's notes go in `ai/<yymmdd><letter>_<topic>/` (`0_brief.md`, `1_build notes.md`), plus README updates (§8 newest first, §9 history) and a project doc `claude/BimGo_<Round>_BuildNotes.md`.
- Each build says **what is in, what isn't, and how to check it step by step**.
- For simple build or test errors, he wants **just the fix**.
- He folds requests in mid-build.
- When he's away he says "assume recommended options".

**This chat is a briefing chat:**
- talk through further ideas and a possible **UI cleanup**;
- write the plan up as a brief for the next build chat.
- Ask for a fresh zip of his working copy before any editing.

## 1. Where BimGo is now (2026-10-17)

| Round | Folder | What |
|---|---|---|
| Grids A / B | `261017e_Grids_A`, `261017f_Grids_B` | Grids and levels: lines, bubbles, nodes, clash grid location, Shift+G panel, C cycles |
| Colour profiles A | `261017h_Colour_A` | COLOUR PROFILES panel (Esc → Appearance → *Colour profiles ›*). Profiles by value (built-in fields or extracted parameters) or by search set. Palette colours with a picker, rows on / off, others ghosted / normal / flat colour, surface detail. Per-element colour texture + element stream (instant recolour), ghost pass. Phase and Parameter search set rules; Shift+C; legend |
| Colour profiles B | `261017i_Colour_B` | Caps fix (ghosts not capped); number ranges (bins, ramps); per-row transparency and hide; AT LEAST / AT MOST / BETWEEN set rules; legend in photos / screenshots; profile export / import with sets; links by instance name |

Gavin confirmed build A ("amazing"); build B is waiting on his compile and check (README §8).

## 2. Ideas already on the list

- **UI cleanup** (Gavin's suggestion):
  - The pause menu card is 440 px (`RIGHT_CARD_HEIGHT`).
  - Several big panels replace the menu: CLASHES, COLOUR PROFILES, COMMENTS, BOOKMARKS, TEXTURES, LIBRARY, ROOMS, GEOMETRY, CONTROLS.
  - Cursor-mode panels: sun, sun hours, section, grids, clash dock.
  - Candidates:
    - a consistent panel shell (header, footer, close);
    - one set of widgets and spacing;
    - the left HUD column (status, coordinates, legend, sun legend) vs the right one (minimap, gun panel, clash dock);
    - the hotkey review (below);
    - 720p fit;
    - gamepad reach.
- **Polish** (README §8 "to verify" and earlier lists):
  - search set rule groups deeper than one level;
  - grass on moved / hidden elements and in probes;
  - groups in the CLASHES panel's list;
  - gamepad grouping;
  - grid location on dock rows;
  - a gamepad binding for the grid and colour profile keys;
  - grids in photos (opt-in).
- **Colour profiles follow-ups:**
  - custom break values / equal-count bins;
  - legend scaled for 2–4× stills;
  - caps in the profile colour;
  - hidden rows' moved copies still cast shadows;
  - imported sets' link / level reconciliation;
  - a profile per bookmark / in the tour.
- **Installer:** `claude/BimGo_Installer_Handoff.md`.
- **Hotkey review:**
  - walking has C (grids), Shift+G (grids panel), Shift+C (colour profile), and many single letters;
  - clash mode has Y, G, B, P, 0, 1–5, `,` `.`, Enter, R, Ctrl+A, Ctrl+G, Ctrl+Shift+G, Shift+C, C, Shift+G;
  - suggested for PICK POINTS (not bound): K.

## 3. Things to watch (for the build chat)

- **Compiling:** C# can't be compiled in the sandbox: say so.
  - Check brackets, strings and `\uXXXX` char literals by script.
  - Check new member names across the `GameSession` partials.
  - Scan UI strings against the font atlas (Latin-1 + `UiFont.EXTRA`).
- **Name clashes:**
  - `InputState` (alias it, or `using BimGo.Platform;`).
  - In BimGo.Revit, qualify Revit types (`DB.Grid`…).
  - "Profiles" also means *quality* profiles (`GameSession.Profiles.cs`): colour ones are `AppearanceProfile`, `GameSession.ColourProfiles*`.
- **Encodings:** keep them as they were; LF.
- **Shaders:** check them in headless WebGL2 (Playwright + `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, precision lines for every sampler type).
  - The profile texture is on unit 15.
  - Vertex attribute 6 is the element index.
  - Profile codes: 0 normal, 1 ghost, 2 hidden, 128–254 see-through, 255 solid.
- **Panels:**
  - Panels with overlays call `BeginOverlays` / `DrawOverlays`; file and colour dialogs run after `DrawOverlays`.
  - The pause menu card is 440 px.
- **Compatibility:** `.bimgo` `formatVersion` 1, `clashes.json` version 1, live protocol 1: additive only.
  - New so far: `visibility.json` → `appearance`;
  - set rules `field` phase / parameter (+ `parameter`), `op` atLeast / atMost / between.
