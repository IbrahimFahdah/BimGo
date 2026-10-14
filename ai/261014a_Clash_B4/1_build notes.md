# C-B4 build notes

Not compiled here (no .NET SDK in the sandbox). Brackets / parentheses checked by script; new types checked against usings.

## Files
- `Core/Scene/InputCatalog.cs`: `InputAction.ClashSelectAll` (Clashes group, `Ctrl+A`). README §3 row added by hand.
- `Core/Clashes/ClashModels.cs`: `RuleGroup` (MatchAll, Rules, HasConditions, Normalise, Copy; reserved `Groups`);
  `SearchSet.Groups` (null when none), `AllRules()`, `NormaliseRules()` (in place); Copy is deep; document Normalise uses it.
- `Core/Clashes/SearchSets.cs`: `Matches` treats each group with a condition as one more condition; `GroupMatches`
  (NOT inverted inside groups).
- `Core/Clashes/ClashFiles.cs`: Serialize normalises via `NormaliseRules` (an empty `groups` list is left out).
- `App/Game/Clashes/GameSession.ClashSelection.cs`: `_clashSelectedLookup` (HashSet) kept in step with `_clashSelected`;
  `ToggleSelectAllShownClashes`, `ClashSelectAllLabel`, `AllShownClashesSelected`; `ResolveSelectedClashes` uses
  hash sets and fills `_clashMultiBoth` / `_clashMultiDynamicBoth` (amber); box off above `CLASH_FOCUS_BOX_CAP` (200).
- `GameSession.ClashMode.cs`: Ctrl+A handler; `ShowClashInRevit(bool confirmed)` asks above `CLASH_REVIT_WARN` (500);
  "both" elements go to Revit; markers use the lookup.
- `GameSession.ClashDock.cs`: the SELECT ALL row under VIEW / BOX / PICTURES; Ctrl+A in the key hint.
- `GameSession.ClashPanel.cs`: the set editor lists lines (top-level rules, then group headers and their rules);
  `BuildClashRuleRow` (extracted), `RemoveClashGroup`, ADD GROUP; footer is four buttons; set rows count group rules.
- Tests: `Sets_Groups_AnyAllAndNotInside`, `Sets_Groups_FileRoundTrip`.

## Expectations worked out
Scene 0 ducts L1, 1 pipes L2, 2 framing L3, 3 walls L2:
(ducts∧L1)∨(walls∧L2) = {0,3}; (ducts∨pipes)∧(L2∨L3) = {1}; framing ∨ (¬L2 ∧ ¬framing) = {0,2};
group(¬L2) alone = {0,2}; top ¬L1 with group(ducts,pipes) = {1}; a group with no value = all 4.
