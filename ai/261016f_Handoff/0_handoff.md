# BimGo: Handoff for a new chat (Round C continues: C-C2 grouping tools → clash reports → hotkeys → polish → installer)

**Context:** BimGo is Gavin's personal project (publisher **Aussie BIM Guru**, **MIT-0**, C# / Visual Studio, .NET 8,
own OpenGL renderer over Silk.NET). He works in **rounds**: discuss → stage questions with AskUserQuestion
(recommended option first, at most 4 per call) → build → deliver a zip + `ai/<yymmdd><letter>_<topic>/` notes
(`0_brief.md` with the answers, `1_build notes.md`) + README + a project doc (`claude/BimGo_<Round>_BuildNotes.md`).
Each build states **what is in, what isn't, and how to check it step by step** (README §8, newest first). For simple
build / test errors or small tweaks Gavin wants **just the fix** (a snippet), not a new zip. When he is away he says
"assume recommended options": do so and list the decisions in the build notes.

**Read first:**
1. This handoff.
2. `README.md`: *For AI assistants*, §3 controls (generated), §5 (the clash detection bullet through **C-C1**), §6
   (`clashes.json` incl. `groups`), §8 (newest four), §9.
3. `ai/261016e_Grouping_C1/` (`0_brief.md` all grouping answers incl. the C-C2 ones; `1_build notes.md`;
   `2_feedback build notes.md`).
4. **Ask Gavin for a fresh zip of his working copy before editing** (he built C-C1 + feedback with no changes, but
   check).

---

## 1. Where BimGo is now (2026-10-16)

| Build | What it added | State |
|---|---|---|
| C-C1 (`261016e_Grouping_C1`) | Clash groups: Core `ClashGroup` / `ClashGroups` / `ClashGrouping` (`ClashDocument.Groups`, one group per clash, stored status + MIXED, groups across runs, report merge); App group rows, group card, right-click row menu (dropdown at the mouse), GROUP / UNGROUP (Ctrl+G / Ctrl+Shift+G), AUTO GROUP ▾ by element, one comment / BCF topic per group (LINK / REPLACE / CANCEL) | Built, "works well" |
| C-C1 feedback (same folder, `2_…`) | Pencil on group rows, groups sorted above ungrouped clashes (status, then deepest member), SHOW ▾ (all / groups only / ungrouped only), plain GROUP / UNGROUP labels, rename starts empty on automatic names, COLLAPSE GROUP from a member's menu, list scroll bar | Built, "works well" |

## 2. Next: C-C2 grouping tools (answers already taken, see `0_brief.md`)

- **GROUP BY BOX…**: starts a box around the selected clashes (or in front of the player), resized with the existing
  section-box face handles (`GameSession.Section.cs`: `HandleUnder`, `DragHandle`); rule = **clash point inside**;
  a bar **GROUP IN BOX (n)** with a live count; grouped hits **move** (toast "n moved from other groups").
- **PICK POINTS** mode (button; suggest a free key in the notes, don't bind it): every clash the list shows as a **dot
  seen through walls** (status colour, dimmer when hidden, bigger + label on hover, amber ring when picked, nearest
  2,000; `DrawClashMarkers` already draws list dots through `Overlay3D`); click toggles, **Ctrl+drag marquee** adds;
  bar "n picked: NEW GROUP / ADD TO <group> › / CLEAR"; Enter commits, Esc leaves; list selection mirrors the picks.
- **More automatic groupings** in AUTO GROUP ▾ (one method per run, ungrouped + unresolved only, min 2, chainable):
  **proximity** (chained clusters within a distance, default 1 m; grid hash + union-find), **by level**, **by
  category pair** (A/B order irrelevant), **level + category pair**. A first Core draft was started and reverted:
  add `ClashGroup.AutoLabel` (like `KeyElement`, drives "<label> × N clashes"; `HasAutoName`; merge freezes unless
  same basis), `ClashGroupAuto.PROXIMITY / LEVEL / CATEGORY / LEVEL_CATEGORY`, `ClashGrouping.LevelOf`,
  `CategoryPairOf`, `ByLevel`, `ByCategoryPair(perLevel)`, `ByProximity(distance, prefix)`. Proximity distance: no
  unit parser exists in `UnitFormat` (enter metres, or add a parser).
- **Gavin's note: rethink the dock UI as tools are added.** The dock already has: test, filters (status / level /
  search), view / box / pictures, select all / report, group / ungroup / show / auto, the list, the card. Stage a
  question on layout before building (e.g. a GROUPS ▾ menu holding group-by-box / pick points / auto methods, or a
  compact tool strip, or a second dock tab); keep buttons narrow (no keys in labels).

## 3. After grouping: clash reports (answers taken 2026-10-16)

Navisworks-style **XML**, **HTML** (self-contained, images embedded, print to PDF) and **PDF via PDFsharp / MigraDoc
(MIT)**: confirm the pinned version with Gavin, add to README §10 and `THIRD-PARTY-NOTICES.txt` (new packages need
an explicit yes). Its own menu area, launched from clash mode's REPORT… dropdown. Still to ask: scope (filtered list /
selection / test / all tests), **a section per group** (groups now exist), pictures (cached or fresh, size), fields,
cover page, save location.

## 4. Later

- **Groups in the CLASHES panel's list** (pause menu) and gamepad grouping (not done in C-C1).
- **Hotkey review** (`claude/BimGo_RoundC_Handoff.md` §4). Taken since: Y, G, B, 0, P, Ctrl+A, **Ctrl+G, Ctrl+Shift+G**,
  Tab (pause preview), wheel = gun modes; gamepad clash: D-pad ↑ / ↓, RB+X, Back, RB+B, Y.
- **Polish:** README §8 "to verify"; search set parameter rules; deeper rule groups (`RuleGroup.Groups`); Appearance
  colour by parameter / search set; grass on moved / hidden elements and in probes; grass cost on integrated GPUs.
- **Installer:** `claude/BimGo_Installer_Handoff.md`.

## 5. Code map (grouping, 2026-10-16)

- Core: `Clashes/ClashGroups.cs` (model, ops, `Clean`, `FollowRun`, `MergeFrom`, `ClashGrouping.ForElement / ByElement`);
  hooks in `ClashModels.Clean`, `ClashMerge.Apply / ResetTest / RemoveTest`, `ClashFiles.Merge`.
- App: `Game/Clashes/GameSession.ClashGroups.cs` (display rows, index by `_clashRevision`, group click / picks, menu,
  actions, group card, group comment render / make / sync, show filter); `GameSession.ClashDock.cs` (rows,
  `BuildClashGroupRow`, `BuildClashScrollBar`, button row GROUP / UNGROUP / SHOW / AUTO GROUP);
  `GameSession.ClashPictures.cs` (`CommentPencil`); `GameSession.Overlays.cs` (right-click closes a dropdown).
- Group comments: `CommentRecord.ClashId` = the group id.
- Dropdown slots in use: dock 11–19 (16 auto, 17 row menu, 18 add-to, 19 show), import card 100+. Slider ids: 0–2,
  10–17, 20–26, 40–43, 51–53.

## 6. Things to watch

- C# can't be compiled in the sandbox (no .NET SDK, apt blocked): say so; check brackets / declarations / `using`s by
  script (a string- and interpolation-aware bracket checker was used in C-C1); scan UI strings against the font atlas
  (Latin-1 + `UiFont.EXTRA`).
- Keep file encodings as they were (some files have a UTF-8 BOM, some don't).
- Shaders can be checked in headless WebGL2 (Playwright + `/opt/pw-browsers/chromium`, SwiftShader).
- Work out test expectations by hand first. New default keys: grep `ControlsTests`; README §3 rows by hand in the
  exact format.
- Panels with overlays call `BeginOverlays` / `DrawOverlays`; actions that open dialogs / menus run after
  `DrawOverlays`. RMB pressed over the dock doesn't drag-look (`_clashMenuLook`).
- `.bimgo` `formatVersion` 1, `clashes.json` version 1 and live protocol 1: additive only.
