# Round C, build C-B1: clash manager, clash mode, GO, ghosting, statuses

Written without a .NET SDK (none reachable from the sandbox): **not compiled here**. Brackets and partial-member names
checked by script; the scene shader (`uGhost`) compiled and linked in headless WebGL2; the framing maths checked in a
Python port. Expect a few compile fixes: send just the errors.

## What's in C-B1

1. **CLASHES manager** (Esc → CLASHES, or TESTS… in clash mode), tabs TESTS / SETS.
   - TESTS: list (tick for RUN ALL, name, kind + tolerance, counts or "changed since the last run"); editor: RENAME…,
     HARD / CLEARANCE, SET A ◀ ▶, SET B ◀ ▶ (or "set A against itself"), tolerance − / +, last run and counts, RUN,
     REVIEW, DUPLICATE, DELETE (twice); NEW TEST.
   - SETS: list (elements, in links, rules, used by n tests); editor: RENAME…, include if ANY RULE / ALL RULES, rule rows
     (INCLUDE / EXCLUDE · field · IS / CONTAINS · value · ×), ADD RULE, element count, DUPLICATE, DELETE (refused while
     used); NEW SET. IS values come from a picker of the model's own values with counts (type to filter; TYPE A VALUE…
     for others); CONTAINS values are typed.
   - Editing a test or a set's rules marks the affected tests "changed since the last run".
2. **Clash mode** (Y toggles, REVIEW, or a clash's row): docked panel on the right, free cursor, flying.
   - Test ◀ ▶, STATUS filter (all / open / each), LEVEL filter, search box, the list (open first, deepest first),
     the current clash card (n of N, A red, B green, depth / gap / touching, level, room, status 1–5 buttons, ASSIGN…,
     NOTES…), REVIT, TESTS…, FLY / INSTANT (remembered per machine), EXIT, key hint.
   - GO: section box round the clash region + 1 m (≥ 2 m), camera ~2.5 m back, 20° down, across the elements' long
     axes; a quick eased flight (0.8–2 s, rising mid-way for long hops) or an instant jump.
   - Clash view: pair opaque red / green, everything else 15 % grey glass, no sun shadows, no AO, no section caps.
   - Markers: dots for the listed clashes (status colours; current ringed), overlay only.
   - Keys (new `Clashes` group + "Clash mode" situation in `InputCatalog`): `.` / `,`, Enter, 1–5, R, Space / E up,
     Ctrl / Q down, WASD / arrows, Shift, RMB-drag; pad D-pad ← / →, Y, X, RT / LT, left stick flies, right stick cursor.
   - R / REVIT: selects the pair in Revit (host + host or linked + linked; host + linked selects the linked one).
   - Leaving: flying and the section box stay.
3. Text box: `BeginTextEdit` (generic) used for names, typed values, assignee and notes.

## What's NOT in C-B1 (coming in C-B2)

- Row thumbnails in the docked list.
- TO COMMENT (current clash → a comment with the clash view and picture) and TO COMMENTS (every listed clash), so
  EXPORT BCF carries clashes with their pictures.
- SHOW IN REVIT: the "BimGo clash" 3D view with its section box set to the clash region (needs an add-in change and an
  optional live message); selecting a host + linked pair together.

Later (C-C): grouping (by element first), extra-parameter rules, hand-picked sets via the Scan gun, BCF report output by
group with images.

## How to check it, step by step

README §8 "Clash detection, build C-B1" lists the 11 steps in order (panel → sets → tests → clash mode → moving →
list → statuses → markers → Revit → leaving → edge cases). Each step only needs the ones before it, so the first one
that fails tells me where to look.

## Files

- New: `src/BimGo.Core/Clashes/ClashFraming.cs`; `src/BimGo.App/Game/Clashes/GameSession.ClashMode.cs`,
  `GameSession.ClashDock.cs`.
- Rewritten: `src/BimGo.App/Game/Clashes/GameSession.ClashPanel.cs` (manager with TESTS / SETS).
- Changed: `InputCatalog.cs` (Clashes group, 11 actions, situation; Y label), `SearchSets.cs` (`RuleValue`, `ValuesOf`,
  `Describe`, `FieldLabel`), `ClashMerge.cs` (`ElementKey`), `ClashModels.cs` (allocation-free `FindSet` / `FindTest`),
  `LaunchSettings.cs` (`ClashInstantFly`), `LiveSessionSource.cs` (`ShowLinkedElements`), `Player.cs` (fly up / down
  actions), `Shaders.cs` (`uGhost`), `SceneRenderer.cs` (`GhostAlpha`), `GameSession.cs` (clash mode in `UpdateFrame`,
  `FixedUpdate`, settings), `GameSession.Render.cs` (clash view, clash HUD, markers, minimap off), `GameSession.Menu.cs`
  (`BeginTextEdit`), `GameSession.Gamepad.cs` (editor cursor in clash mode), `GameSession.Clashes.cs` (list refresh),
  tests (`ClashTests`: +4 → 20), README (§3 table + note, §5, §6, §8, §9).
- No new packages, no Revit add-in changes, no format change (statuses / assignee / notes were already in `clashes.json`).

## APIs worth a look

`SceneDrawParams with { Sun = false }` (struct `with`), `Gl.PolygonOffset(1, 2)` for the ghost pass, `Player.TeleportTo`
each frame during a flight (`Controller.StandEye`), `Overlay3D.Dot` sizes at 4K, the docked panel on a 1280 × 720 window.
