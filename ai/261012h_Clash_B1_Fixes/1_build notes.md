# Round C, C-B1 fixes: build notes

**Not compiled here** (no .NET SDK reachable from the sandbox). Brackets balanced and new member names checked for
duplicates across the `GameSession` partials by script; UI strings scanned for glyphs missing from the atlas. No
shader changed (the wireframe reuses the scene shader's `uGhost`).

## In (all nine items of `ai/261012g_Handoff` §2)

| # | Fix | Where |
|---|---|---|
| 1 | Cursor stays free in clash mode: `SetPaused(false)` no longer captures while a free-cursor mode is on (`CursorModeOpen`: sun panel, sun hours, photo, section editor, clash mode); closing the photo / section / sun / sun hours panels doesn't capture while clash mode is on | `GameSession.cs`, `.Photo`, `.Section`, `.Sun`, `.SunHours` |
| 2 | No "?" glyphs: ◀ ▶ removed (dropdown chevrons are drawn triangles); ≤ ≥ ‹ › ↔ added to `FontAtlas.EXTRA` | `Rendering/UiFont.cs` |
| 3 | Dropdown widget: `DropdownButton` / `OpenDropdown` / `BeginOverlays` / `DrawOverlays` (list below or above, ≤ 12 rows, wheel, scroll bar, current highlighted, click picks, click outside / Esc closes). Used for the dock's test, STATUS, LEVEL, VIEW; the test editor's SET A / SET B; the rule rows' field and operator | new `Game/GameSession.Overlays.cs`; `InputState.ConsumeWheel` |
| 4 | Clash view: G cycles ghost / wireframe / real / hidden (`SetClashView`, dock VIEW ▾); B toggles the section box (`ToggleClashBox`, dock SECTION BOX button; on = the current clash's box, GO turns it on) | `GameSession.ClashMode.cs`, `.ClashDock.cs`, `.Render.cs` (AO kept in real view), `Native/Gl.cs` (`PolygonMode`, `FRONT_AND_BACK` / `LINE` / `FILL`) |
| 5 | In-panel confirm before RUN / RUN ALL of tests with results ("Don't ask again this session"), wording per Gavin; first runs don't ask | `RequestClashRun`, `OpenConfirm` |
| 6 | Set A / B independent: B stored as picked (dropdown with "(set A against itself)" first), never derived from A; row label "· against itself" when B = A | `GameSession.ClashPanel.cs`; Core test `Tests_SetsAAndBStayAsPicked` |
| 7 | ADD RULE adds a row (BimGo category, IS, nothing picked), no picker; incomplete rules are left out of matching | `ClashPanel`, Core `SetRule.IsComplete` |
| 8 | Operators: `RuleOp` (is, isOneOf, isNot, isNotAnyOf, contains, notContains); `SetRule.Op` + `Values`; old `contains` / `exclude` read as operators (`Normalise`, in `Clean`) and still written in step; "not" rules always subtract; tick picker (CLEAR / DONE) for the list operators; `Describe` / `ValueLabel` | Core `ClashModels.cs`, `SearchSets.cs`, `ClashFiles.Serialize`; `ClashPanel` |
| 9 | RESET RESULTS… (test editor) and RESET ALL…: confirm, then Core `ClashMerge.ResetTest` (clashes + runs + last run stamp); `HasResults` | Core `ClashMerge.cs`; `ClashPanel` |

Keys: two new actions in the `Clashes` group, `ClashView` (G) and `ClashSectionToggle` (B); README §3 rows added by
hand in the generated format. Core tests: 4 new (`ClashTests`: 24), one assertion updated (`Describe` now reads "Level is
not Level 2"), the controls test checks G / B.

## Not in

- C-B2 (row thumbnails, TO COMMENT / TO COMMENTS, SHOW IN REVIT), C-C (grouping).
- Gamepad buttons for G / B (the dock buttons work with the pad cursor).

## To verify first (compile risks)

- `Gl.PolygonMode` → `_gl.PolygonMode((GLEnum)face, (GLEnum)mode)`: Silk.NET 2.23 should have the `GLEnum, GLEnum`
  overload; if not, use `(TriangleFace)face, (PolygonMode)mode`. `glPolygonMode` was added to `RequiredEntryPoints`
  (it's a GL 1.1 export, so the startup check should pass).
- `new SetRule { … Values = { k } }.Normalise()` in `SearchSets.SetOfCatalog` (object initializer then a call).
- Pattern `op is IS_NOT or IS_NOT_ANY_OF or NOT_CONTAINS` on `const string`s (C# 9 constant patterns).

## How to check

README §8, the "C-B1 fixes" entry: build and Core tests, then 10 steps (cursor, glyphs, dropdowns, set A / B, rules,
re-run confirm, reset, clash view, section box, keys).

## For the next chat

Next is C-B2 (`ai/261012g_Handoff` §3). The overlay widget is reusable for C-B2's TO COMMENTS confirm ("render N
pictures?") and C-C's grouping pickers.
