# C-C3 clash reports and two fixes: build notes (2026-10-17)

Brief: `0_brief.md`. Built on the C-C2 working copy, which Gavin built with no changes.

**Not compiled here** (no .NET SDK). Checked by script: brackets, strings and interpolation; members declared once across the `GameSession` partials; UI glyphs; file encodings unchanged. Test expectations were worked out by hand. No new `InputAction`, so README §3 is unchanged.

## In

- **Click a clash dot in clash mode** (no tool needed). It works like a list row:
  - a plain click goes to that clash;
  - Ctrl+click adds it to / removes it from the selection;
  - Shift+click selects a run in list order.

  The dot under the mouse gets a white ring and a label: pair · status · level · group. Only the nearest 2,000 shown clashes can be clicked. The mouse isn't live over the dock, while RMB is held, or during a flight.
- **G** cycles the model view inside GROUP BY BOX…, PICK POINTS and CLUSTER.
- **REPORT ▾** now lists:
  - **EXPORT REPORT (HTML / XML)…** (new);
  - EXPORT BIMGO REPORT (JSON)…;
  - IMPORT BIMGO REPORT (JSON)….
- **The report card** sits in place of the clash card (Esc or CANCEL closes it):
  - **SCOPE:** what the list shows, the selection, this test (every clash), or all tests, each with its count;
  - **FORMAT:** HTML + XML / HTML / XML;
  - **PICTURES:** on / off (HTML only);
  - **GROUPS:** sections (header, then members) / compact (one item each) / ignored;
  - **EXPORT…**.

  The choices are kept for the session.
- **Export flow:**
  1. Choose where to save. With HTML + XML, the XML goes beside the HTML with the same name.
  2. The pictures render a few per frame, with "EXPORTING REPORT · PICTURE n OF m" and CANCEL in the card (Esc cancels too; nothing is written).
  3. The files are written (temporary file, then moved) and the HTML opens in the default browser.

  Above 300 pictures it asks first, with the time and size. Pictures follow the current view (G) and box (B), and are rendered at 1280 × 720 and stored as 960 × 540 JPEG (quality 78). Group pictures use the union framing of the group's members in the report.
- **HTML** (Core `ClashReports.Html`): one file with inline CSS and pictures as data URIs. It prints to A4: cards don't split, and group headers stay with their first member.
  - **Cover:** title, model, scope in words (including the filters for "what the list shows"), date, author, clash and group counts, generator; status chips; tables by level and by category pair (top 12); a tests table (kind, tolerance, sets A / B, last run, how many in the report).
  - **Group section:** a picture plus GROUP, status, MIXED, name, counts, statuses, test, assignee, notes, "all on" element, box (plan area if full height) and the comment text.
  - **Compact groups** add levels (counts), category pairs (counts), the number of distinct elements and the deepest crossing, and list no members (the numbering still counts them).
  - **Clash card:** picture plus CLASH n, status, approximate; "A × B"; an A / B table (category, family / type, id or clone, level, host / linked); crossing or gap in display units; level; point (internal metres); test (when not under its group); assignee; notes; found / last seen / resolved; and the comment text.
- **XML** (Core `ClashReports.Xml`), Navisworks-style, UTF-8, lengths in metres:
  - `exchange` → `batchtest` → `clashtests` → a `clashtest` per test in the report, with type, tolerance, `left` / `right` set locators, and a `summary` (total plus each status).
  - Then `clashresults`: a `clashgroup` per group (name, guid, status, count, auto, assignee, notes / comment, box) holding its members' `clashresult`s, followed by the ungrouped `clashresult`s.
  - Each `clashresult` has: `distance` (negative for a crossing), `description`, `resultstatus`, `clashpoint/pos3f`, `gridlocation` (the level), created / last seen / resolved dates (UTC), `assignedto`, notes and comment, and two `clashobject`s (Element ID, `layer` = level, smart tags Item Name, Category, UniqueId, IfcGUID, link, clone).
  - Control characters XML can't hold are dropped.

## Files

- **Core:** `Clashes/ClashReports.cs` (new): `ClashReportGroups`, `ClashReportOptions`, `ClashReportSection`, `ClashReportPicture`, and `ClashReports` (`Sections`, `Pictures`, `CountByStatus`, `CountBy`, `StatusCounts`, `Html`, `Xml`).
- **App:**
  - `Game/Clashes/GameSession.ClashReport.cs` (new): the card, scope, export, picture batch, writing and progress.
  - `GameSession.ClashDock.cs`: REPORT ▾ items; the actions after the overlays (1 card, 2 / 3 JSON, 4 export, 5 export after the large-report confirm); the card and progress in place of the clash details (the comment row is hidden then); TESTS… cancels a report; the hover label.
  - `GameSession.ClashMode.cs`: dot hover and click; Esc cancels the report or closes the card; leaving clash mode cancels or closes them; a ring on the hovered marker.
  - `GameSession.ClashPictures.cs`: the report's pictures step at the start of a frame.
  - `GameSession.ClashTools.cs`: G in the tools; the hover label is shared (`DrawClashHoverLabel`).
- **Tests:** `tests/BimGo.Core.Tests/ClashReportTests.cs` (5):
  - sections (groups by first appearance, members in report order, ungrouped last, none);
  - pictures per group mode;
  - HTML (escaping, embedded JPEG, numbering, compact summary);
  - XML (test, self-test locator, group with members, notes with a control character, negative distance, comment, level, object id);
  - counts.

## Decisions taken

- **Dot clicks** act like list rows, including Ctrl and Shift. Ctrl also flies down while held, as with the list.
- **"The selection"** keeps list order; selected clashes the list hides come last. **This test / all tests** sort by the tests' order, then status (new first), then depth.
- **Comment text** comes from each clash's linked comment and from each group's comment.
- **The XML** always nests members under their groups, unless groups are ignored. Compact only changes the HTML.
- **Opening the HTML** when it's written: it's the quickest way to check it and print to PDF.

## To verify

- It builds. Check `System.Xml` in Core (it's in the BCL) and `WebUtility.HtmlEncode` (it writes × as `&#215;`, which the test allows).
- Memory on a big report: about 100 KB per picture, held until written. Above 300 pictures the export asks first.
- The pictures match the screen's view and box. A group picture puts back the selection, camera and section afterwards.

## Check

1. **Clash mode, no tool:** hover a dot (white ring and label) and click it: the camera flies there and the card shows it. Ctrl+click two more: shown together. Shift+click: a run in list order. Click over the dock: nothing in the view.
2. **PICK POINTS, then G:** the view cycles and the picks stay. The same works in box and cluster.
3. **REPORT ▾ → EXPORT REPORT (HTML / XML)…:**
   - The card replaces the clash card, and SCOPE shows counts.
   - Pick THIS TEST, HTML + XML, PICTURES ON, GROUPS: SECTIONS, then EXPORT… and save.
   - The progress bar runs. When it's done the toast names both files and the browser opens the HTML.
   - Check the cover (counts match the dock), the group sections with member cards, the pictures, and the A / B tables.
4. **Print preview** (Ctrl+P in the browser): cards aren't split across pages.
5. **GROUPS: COMPACT:** each group is one item with levels and category pairs; ungrouped clashes still get cards and the numbering continues.
6. **FORMAT: XML:** no pictures and no progress, just the .xml. Open it: `clashtest` → `clashresults` → `clashgroup` → `clashresult`, with distance negative for crossings.
7. **Scope THE SELECTION** with 3 selected: 3 clashes. **ALL TESTS:** a tests table with every test.
8. **CANCEL** during the pictures, and Esc: nothing is written, with a toast.
9. **More than 300 pictures:** the LARGE REPORT confirm; EXPORT continues to the save dialog.
10. **Y while exporting:** cancelled, and clash mode is off.
11. **JSON EXPORT / IMPORT** behave as before.
