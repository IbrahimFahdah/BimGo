# Clash detection, build C-B3: build notes

**Not compiled here** (no .NET SDK reachable), and it sits on C-B2, which wasn't built yet either: build, fix, then
README §8 "build C-B3" and "build C-B2" checklists. Brackets, single declarations of every new member and glyphs were
checked by script.

## What is in

| Item | Where |
|---|---|
| Multi-select: Ctrl+click toggles, Shift+click runs from the anchor (Ctrl+Shift adds); plain click / `.` `,` / test change → one clash; filters pruning the selection | new `Game/Clashes/GameSession.ClashSelection.cs`; `ClashDock` (`ClickClashRow`, highlight), `ClashMode` (`GoToClash` clears, `FlyToClashView` split out) |
| Every selected pair drawn (`DrawSelectedClashPairs` from `DrawClashPair`), box = union of the clash boxes, camera from `ClashFraming.DistanceToSee` (Core, tested), selected markers ringed | `ClashSelection`, `ClashMode`, Core `ClashFraming.cs` |
| 1–5 on every selected clash (comments synced, one save); R: every element, one view; Enter re-frames all | `ClashMode` |
| LIST TO COMMENTS removed; TO COMMENT / UPDATE COMMENT / N TO COMMENTS on the selection; existing → `OpenChoice` UPDATE THEM / NEW ONLY / CANCEL with "Replace marked-up pictures too (n)" | `ClashPictures` (`ClashToComment`, `MakeClashComments`, `StartClashBatch(targets, update, replace)`), `Overlays` (`OpenChoice`: second action + tick label) |
| MARKUP button and a row pencil (drawn; amber = already marked up) → `OpenMarkup(comment, returnToGame: true)` | `ClashPictures` (`OpenClashMarkup`, `ClashCommentPencil`), `ClashDock` |
| Comments panel: TYPE filter, ticks (Shift runs, Ctrl+click row), SELECT ALL SHOWN, CLEAR, DELETE SELECTED (confirm, `CommentStore.RemoveMany`, `UnlinkClashComments`); Esc closes the confirm first; "· CLASH" in clash comment headers | `GameSession.Comments.cs`, `CommentStore.cs` |
| Test `Framing_SeveralClashes_StandsBackToSeeThemAll` (`ClashTests` 27) | `tests/BimGo.Core.Tests/ClashTests.cs` |

## Not in

Groups (one picture / comment per group, BCF by group), Ctrl+A in the clash list, gamepad multi-select, a key for TO
COMMENT (hotkey review).

## Watch when building

- `ClashView` record struct construction and `Aabb.Include` on `out` locals (`ResolveSelectedClashes`).
- `OpenMarkup` is called from inside the dock build (pauses mid-frame; the dock returns straight away).
- Thumbnails / batch pictures set `_clashMultiSuspended` so one clash's picture isn't drawn with the whole selection.

## For the next chat (grouping, later this week)

Read this note, `ai/261013a_Clash_B2`, README §5 (C-B2, C-B3). Groups build on the selection: "group the selected"
/ "add to group", a group = one comment / picture (union framing is `GoToSelectedClashes`; a group picture can reuse
`RenderClashPicture` with the selection instead of `_clashMultiSuspended`), grouping by element then level / proximity,
BCF by group. Then the hotkey review, polish, installer (`claude/BimGo_RoundC_Handoff.md`, `claude/BimGo_Installer_Handoff.md`).
