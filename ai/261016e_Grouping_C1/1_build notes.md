# C-C1 clash grouping: build notes (2026-10-16)

Brief: `0_brief.md` (answers 2026-10-14 / 2026-10-16; C-C2 tools listed there). Gavin was away for the build, so
open points took the recommended option (listed under *Decisions taken*).

**Not compiled here** (no .NET SDK in the sandbox). Checked by script: bracket / string / interpolation balance of
every edited file, new member names declared once across the `GameSession` partials, UI strings against the font atlas
(Latin-1 + `UiFont.EXTRA`). Test expectations were worked out by hand first.

## Files

**Core**
- `Clashes/ClashGroups.cs` (new): `ClashGroup` (id, testId, name (null = automatic), status, assignedTo, notes, commentId,
  clashIds, auto, keyElement, createdUtc, updated, updatedBy), `ClashGroupAuto.ELEMENT`, `ClashGroupSummary`,
  `ClashGroups` (Index, ClashesById, Find, OfTest, Members, Summarise, DisplayName, ElementName, NextName,
  CommonElement, Create, AddTo, Remove, Ungroup, Merge, Rename, SetStatus, SetAssignee, SetNotes, Clean, FollowRun,
  RemoveTest, internal MergeFrom), `ClashGrouping` (MIN_SIZE 2, ForElement, ByElement).
- `Clashes/ClashModels.cs`: `ClashDocument.Groups` (null when none: files without groups are unchanged); `Clean()` calls
  `ClashGroups.Clean` last.
- `Clashes/ClashMerge.cs`: `Apply` calls `ClashGroups.FollowRun` (all members resolved → group resolved; one back →
  active; not stamped); `ResetTest` / `RemoveTest` remove the test's groups.
- `Clashes/ClashFiles.cs`: `Merge` maps their clash ids to ours by key (a report clash whose id we already use for
  another pair gets a new id) and calls `ClashGroups.MergeFrom`; `ClashImportResult.GroupsAdded` (optional, default 0).
- `Scene/InputCatalog.cs`: `InputAction.ClashGroup` (Ctrl+G), `ClashUngroup` (Ctrl+Shift+G), Clashes group, after
  `ClashPictures`. README §3 rows added by hand.

**App**
- `Game/Clashes/GameSession.ClashGroups.cs` (new): display rows (`ClashDisplayRow`), the index (rebuilt when
  `_clashRevision` changes), group rows / card text, group click (plain / Ctrl), chevron, the right-click menu and
  ADD TO GROUP › sub-list (dropdown slots 17 / 18), actions (group, group all on, add, remove, ungroup, merge, rename,
  auto group (slot 16), group status / assign / notes), the group card, group comments (render framed on all members,
  make / update, LINK / REPLACE, sync).
- `GameSession.ClashDock.cs`: `RefreshClashList` (index first; search matches group names; `BuildClashDisplay` fills
  `_clashDisplay` and `_clashList`; counts show groups); the GROUP / UNGROUP / AUTO GROUP row under SELECT ALL;
  `BuildClashDockRows` draws `_clashDisplay` (`BuildClashRowBody`, `BuildClashGroupRow`, `DrawClashRowPicture`,
  `ClashDisplayIndexOf`); right-clicks recorded and the menu opened after `DrawOverlays`; the card shows the group card
  and GROUP TO COMMENT / UPDATE GROUP COMMENT / MARKUP when a group is picked; key hint mentions Ctrl+G and right-click.
- `GameSession.ClashMode.cs`: Ctrl+G / Ctrl+Shift+G; 1–5 act on the picked group; RMB pressed over the dock sets
  `_clashMenuLook` (no drag-look until released).
- `GameSession.ClashSelection.cs`: a clash click, `ClearClashSelection` and SELECT ALL drop the group card / picks.
- `GameSession.ClashPictures.cs`: the pending group comment renders at the start of a frame; `SyncClashComments` also
  syncs group comments.
- `GameSession.Overlays.cs`: a right-click closes an open dropdown and passes through.
- `GameSession.Comments.cs`: deleting a group comment unlinks its group. `GameSession.Bcf.cs`: a group comment's topic
  lists every member's elements (once each). `GameSession.Clashes.cs`: import toast counts groups added.

**Tests:** `tests/BimGo.Core.Tests/ClashGroupTests.cs` (10): by element (duct × 3 beams, ties by key in either order,
grouped clashes left alone + minimum, element on both sides + GROUP ALL ON), one per clash / move / merge / status /
mixed / add / remove, automatic name frozen on merge + rename back, Clean, file round trip (no `groups` key when
none), runs (members stay resolved, group follows, reset removes), report merge (members by clash, newer wins, our
membership stays).

## Decisions taken (recommended options, Gavin away)
- **Group comment link:** `CommentRecord.ClashId` = the group's id (no new comment field). Existing code already treats
  any `ClashId` as a clash comment (TYPE filter, "· CLASH", BCF "Clash" topic); older builds just don't find a clash.
- **New group status:** the least advanced of its members' (new → resolved), so nothing looks further along than it
  is; assignee = theirs when they all share one.
- **ASSIGN… on a group** sets the group's and every member's assignee (filters and comments by assignee keep working);
  **NOTES…** is the group's own.
- **Runs:** all members resolved → group resolved; a member found again → group active (unstamped, like run-made
  statuses).
- **Automatic grouping** takes unresolved, ungrouped clashes of the test, filters aside; GROUP ALL ON likewise
  (resolved left out).
- **Automatic names** ("Duct (id) × N clashes") follow the member count until renamed; a merge across elements freezes
  the name as it reads then.
- **Merge** is on the group row's menu (click group A, Ctrl+click B, right-click); the first picked keeps its fields.
- **Group rows** sort where their first shown member would (group status, then the deepest member); `,` / `.` still
  step through every shown clash, including collapsed groups' members (the group row is highlighted).
- **Right-click** acts on the selection when the row is in it, else on that row alone, without moving the camera.

## To verify (beyond README §8's steps)
- Build errors around tuple literals (`tops.Add((…, group, null))`), the `foreach (var (_, _, _, group, row) …)` deconstruction,
  and `Enumerable.Count` on `List<T>` with a predicate.
- `RenderClashGroupPicture` puts back the selection, multi lists, section and camera (watch the view after GROUP TO
  COMMENT with a different selection on screen).
- Text-row layout of group rows at narrow dock widths (status / MIXED / counts on line 1, name on line 2).
