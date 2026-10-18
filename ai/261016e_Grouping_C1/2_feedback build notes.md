# C-C1 feedback build (2026-10-16)

Gavin's feedback on C-C1 (it built and ran with no changes). Automatic groupings beyond "by element" were moved
to the next round, together with box grouping and pick points; the dock UI needs a rethink as more tools arrive.

## In
- **Pencil on group rows**: shown when the group has a comment with a picture (on the stacked picture, or at the
  row's right in text rows); amber when the picture has markup; a click opens the markup editor on the group comment
  (`CommentPencil` now serves clash and group comments; `ClashCommentPencil` wraps it).
- **Groups first**: group rows sort above every ungrouped clash, by the group's status (new → resolved), then their
  deepest member; ungrouped clashes follow as before.
- **SHOW ▾** beside GROUP / UNGROUP: ALL, GROUPS ONLY (ungrouped hidden), UNGROUPED ONLY (grouped hidden). It filters
  the list and so `_clashList` (`.` / `,`, SELECT ALL, markers follow what is shown). Per session.
- **GROUP / UNGROUP labels** without their keys (the key hint still names Ctrl+G).
- **RENAME…** on an automatically named group starts empty (Enter on empty keeps the automatic name).
- **Right-click on a clash in an expanded group**: COLLAPSE GROUP "name" (the list keeps the group row in view).
- **Vertical scroll bar** on the clash list: the thumb shows the share on screen; drag it (keeps the grab point even
  off the bar while the button is held), or click the track to jump there. Rows leave room for it.

## Files
- `GameSession.ClashGroups.cs`: show filter (`_clashGroupFilter`, slot 19), groups-first sort, plain labels, rename
  initial text, `CollapseClashGroupFrom`, `SetClashGroupFilter`, group pencil click field, scroll bar state.
- `GameSession.ClashDock.cs`: SHOW dropdown in the group row of buttons; pencil on group rows; `BuildClashScrollBar`.
- `GameSession.ClashPictures.cs`: `CommentPencil(input, cx, cy, CommentRecord)`.

Not compiled here; brackets checked by script.

## Check
1. A group with a comment: the pencil shows on its row (pictures on and off); click it: markup editor on the group
   picture; DONE returns to clash mode.
2. Groups sit at the top (new groups above reviewed ones), ungrouped clashes below.
3. SHOW: GROUPS: only group rows (and expanded members); SHOW: UNGROUPED: no groups; `.` / `,` step only what shows.
4. GROUP / UNGROUP buttons read just GROUP / UNGROUP; the row fits at the narrowest dock.
5. RENAME… on an auto group: the box is empty; Enter keeps "… × N clashes"; typing a name sets it.
6. Expand a group, right-click a member: COLLAPSE GROUP folds it.
7. 50+ rows: the scroll bar appears; drag the thumb up and down; click the track near the top: jumps there; the wheel
   still scrolls.
