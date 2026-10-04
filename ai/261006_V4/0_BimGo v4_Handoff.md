# BimGo — Handoff Brief v4 (for a new chat)

**Purpose of the next chat:** finish the remaining work on BimGo. The main item is **Phase 4: pushing a standalone file's edit journal into a live Revit model** (`journal.apply`), followed by the smaller items in §4.

**Read first:**
1. This brief.
2. `README.md` in the repo. It covers the current structure, controls, how things work, the `.bimgo` format, the live protocol and the changelog.
3. `ai/261005_V3/1_BimGo v3_Handoff.md` (the v3 design: format, protocol and phases), then `2_build notes v3.md` and `3_build notes v3 phase 2.md` (the decisions taken).
4. The current code. **Ask Gavin for a fresh zip of his working copy before editing.** He builds and fixes in Visual Studio, so his copy is the source of truth.

---

## 1. Where BimGo is now (2026-10-06): everything below builds and works

- **Solution** `src/BimGo.sln`:
  - **BimGo.Core** (net8.0): scene model, `.bimgo` format, edits and journal, live protocol.
  - **BimGo.App** (net8.0-windows, `BimGo.exe`): engine, shell and guns.
  - **BimGo.Revit** (R25/R26 on net8, R27 on net10): extractor and session bridge. It has no engine code.
- **App:**
  - Home screen with live sessions, Open, recent files and drag-and-drop. Single instance with an inbox.
  - Walkthroughs of `.bimgo` files, with the journal, Ctrl+Z, Ctrl+S, dirty prompts and comments in the file.
  - Live sessions: `LIVE` / `OFFLINE` badge; edits go to Revit; F5 refresh, which reloads with the player's pose; Scan → R to select in Revit; a switch prompt when another model's Go arrives.
  - Gizmo snap: G toggles it; Z/X and C/V step the increments; Ctrl inverts it while held.
- **Revit add-in:**
  - **Go** writes a snapshot into the session folder and launches or attaches the app.
  - **Export .bimgo.**
  - **Live** status button: bring the app forward, fresh snapshot, end the session.
  - The Options dialog has the extra-parameter picker.
  - `LiveDispatcher`: one `ExternalEvent`, the document events and the ribbon text.
  - `SessionHost`: heartbeat, snapshots and change counting. `RevitEditor` applies the edits.
- **Icon:** the ">>" mark (cyan chevrons on a dark rounded square). It appears on:
  - `BimGo.exe`, through `ApplicationIcon` (`BimGo.App/Resources/BimGo.ico`, 16–256 px);
  - the game window's title bar and taskbar (window class `hIcon` / `hIconSm`, from `BimGo.ico` copied beside the exe, falling back to the embedded resource);
  - the Revit **Go** button (`BimGo_Launch16/32.png`) and the Options dialog's window icon;
  - the app's home-screen title, drawn with UI lines.

  Export and Live keep their functional icons.

## 2. Conventions (unchanged; apply throughout)

- **Code style:** readable, robust, XML doc headers, explicit types where clearer, no LINQ in per-frame paths, no per-frame allocations (use `TextBuffer`).
- **Dependencies:** no NuGet packages without asking (this includes test frameworks). Ask before reorganising folders.
- **Errors:** no exceptions surfacing to the user. Log via `Utilities.Log_Utils.Write` and show a toast or dialog instead.
- **Revit template conventions:**
  - commands in `Commands/Cmds_BimGo.cs` as `Cmd_<Button>`;
  - extensions in `Extensions/TypeName_Ext.cs`;
  - tooltips and icons resolved by base name (`BimGo_<Button>`; add `Resources/Icons16|32/BimGo_<Button>16|32.png` and a resx entry).
- **Revit API boundaries:** only `Commands/`, `Extraction/`, `Bridge/RevitEditor.cs` and `Live/LiveDispatcher.cs` call the API, on the Revit thread. Timers and watchers do file IO only.
- **Name clashes:** WinForms, WPF and Revit `DB` / `UI` are global usings in BimGo.Revit, and WinForms + Drawing in BimGo.App. Qualify:
  - `Timer` → `System.Threading.Timer`;
  - `View` → `DB.View`;
  - `TaskDialog` → `UI.TaskDialog`;
  - `UndoOperation` → `Autodesk.Revit.DB.Events`;
  - also `Color`, `Point`, `Plane`, `CheckBox` and similar.
- **Watch for:** `x ??= Method(out var y)` short-circuits, so `y` can be left unassigned (this caused one build error in phase 2).
- **Docs and handoff:** keep `README.md` and an `ai/<date>_V<n>/` build-notes file current. Zip the repo minus `bin/`, `obj/` and `.vs/`.

---

## 3. Main task: Phase 4, `journal.apply` (push file edits into Revit)

**Goal:** someone edits a `.bimgo` offline (demolish, move, clone), then opens the matching model in Revit and pushes those edits in. They get a clear per-edit report and can undo the whole push in one step.

### 3.1 What already exists to build on

- `JournalEntry` (Core/Edits) stores, per edit:
  - the op (`hide` / `transform` / `clone`) and the hide mode (`demolish` / `delete`);
  - the target's **UniqueId** and ElementId, or a `TargetCloneKey` for walkthrough clones, plus `NewCloneKey`;
  - `Pivot` (Revit internal metres at the time of the edit), `Offset`, `Angle` and `Label`;
  - `AppliedToRevit` and `RevitElementId`.
- `ManifestDto.Provenance.ModelKey` is `ProjectInformation.UniqueId`. `SessionInfo.ModelKey` holds the same value for live sessions.
- `RevitEditor` already applies `EditRequest`s with a clone-key map, the swallow-warnings / roll-back-on-error preprocessor, and borrowed-element checks.
- The live protocol already has message plumbing (`FolderChannel`, `LiveDispatcher.Handle`), so a new message type slots in.

### 3.2 Proposed design (confirm with Gavin, see §3.4)

**Flow:**

- **App, file walkthrough:** add a pause menu button, **PUSH EDITS TO REVIT…**. It is enabled when the journal has entries with `AppliedToRevit == false` **and** a live session exists whose `SessionInfo.ModelKey` equals the file's `Provenance.ModelKey`. Use `LiveSessions.ListAlive()`.
  - If several sessions match, pick one (unlikely).
  - If none match, a tooltip or toast says "Open <title> in Revit and press Go".
- The app opens a **temporary channel** to that session. It must not attach as the walkthrough: create a `FolderChannel` with a distinct name and leave `app.json` alone. It sends:
  - `journal.apply`: `{ requestId, entries[], options: { dryRun, moveCheckToleranceMm, demolishPhaseName? } }`
  - Large journals are fine inside the 4 MB message cap. If they ever exceed it, write the payload to `snapshots/` and send its path.
- **Revit (`LiveDispatcher`)** runs everything in one `TransactionGroup("BimGo: Push N edits")` and calls `Assimilate()`, so the whole push is **one undo step**. Each entry gets its own `Transaction` through `RevitEditor`, so one failure doesn't sink the rest. For each entry:
  1. **Resolve the target.** Look up the UniqueId (`doc.GetElement(uniqueId)`). For clone targets use a push-local map from `NewCloneKey` to the new ElementId, filled as clone entries are applied in order. If the target is missing, mark it **skipped** ("element not in model").
  2. **Staleness check.** For transforms and clones, compare the element's current `LocationPoint` to `entry.Pivot`. If they differ by more than the tolerance (default 5 mm), the result is **conflict**: "moved since export by X mm".
     - The options decide whether to apply anyway (the delta lands relative to where the element is now) or skip.
     - Hide entries: if the element is already demolished or deleted, mark it **already applied**.
  3. **Phase demolish.** Use the target model's phase whose name matches the file's `PhaseName`. Otherwise fall back to the session phase (the last phase) and note that in the result.
  4. **Apply** through `RevitEditor`, reusing `EditRequest`. Convert each `JournalEntry` to an `EditRequest`: `ElementId` comes from the resolved element, `TargetCloneKey` from the push map.
  5. **Record** `{ seq, status: applied|skipped|conflict|failed|alreadyApplied, message, newElementId }`.
- **Revit replies** `journal.result`: `{ requestId, results[], counts }`. On a **dry run**, roll back the transaction group and report what *would* happen. That gives a preview before committing.
- **App, on the report:**
  - Show a panel listing applied / skipped / conflicts with each label and reason.
  - Mark applied entries `AppliedToRevit = true`, set `RevitElementId` on clones, and mark the document dirty.
  - Offer **Save**.
  - Entries already applied are never sent again.

### 3.3 Protocol additions (protocol stays version 1; types are additive)

| Direction | Type | Payload |
|---|---|---|
| app → Revit | `journal.apply` | `JournalApplyPayload { RequestId, DryRun, ToleranceMm, ApplyConflicts, Entries[] }` |
| Revit → app | `journal.result` | `JournalResultPayload { RequestId, DryRun, Results[] (Seq, Status, Message, NewElementId), Applied, Skipped, Conflicts, Failed }` |

- Update `README.md` §7 and `MessageTypes`.
- Keep `LiveProtocol.VERSION = 1`: old add-ins ignore unknown types, and the app should time out with "update the BimGo add-in" if no answer arrives within about 30 s.

### 3.4 Decisions to confirm with Gavin first

1. Should the push be **one undo step** (TransactionGroup assimilate, recommended) or one undo step per edit?
2. **Moved-since-export conflicts:** skip by default (recommended) or apply relative to the current position? And what tolerance (5 mm)?
3. Should a **dry-run preview** always come before the real push (recommended), or be an option?
4. **Hide mode on push:** respect each entry's recorded mode (demolish or delete), or force demolish for safety?
5. What if the file's **model key doesn't match** (for example a detached copy)? Refuse (recommended), or allow with a strong warning and UniqueId matching only?
6. Should **live-session saves** (`session-save` files, whose entries are already `AppliedToRevit`) be excluded automatically? (Recommended: yes, they already are.)
7. Where does the report go: an in-app panel only, or also a CSV / JSON beside the file?

### 3.5 Files likely touched

| Project | Files |
|---|---|
| Core | `Live/LiveProtocol.cs` (types, payloads); a new `Live/JournalPush.cs` (temporary channel helper); `Edits/EditJournal.cs` (helpers: `PendingForRevit()`, `MarkApplied(seq, newId)`) |
| Revit | `Live/LiveDispatcher.cs` (handle `journal.apply`); `Bridge/RevitEditor.cs` (resolve by UniqueId, staleness check, push-local clone map, phase by name) |
| App | `Game/GameSession.Menu.cs` (button), a new `Game/GameSession.Push.cs` (send, wait, report panel), `GameSession.Document.cs` (mark applied, dirty) |

### 3.6 Test checklist

- **Basic push:**
  1. Export a model, then edit the file offline (demolish a wall with doors, move a chair, clone a desk, then clone the clone).
  2. Open the model in Revit and press Go, so a session is alive.
  3. In the file walkthrough choose Push, dry-run, then apply.
  4. Check in Revit that everything landed and that one Ctrl+Z undoes the whole push.
- **Conflicts and missing elements:** move the chair in Revit first; the push should report a conflict. Delete an element in Revit; the push should report it as skipped.
- **Repeat push:** push twice; the second push sends nothing.
- **Version mismatch:** an R25 add-in should either handle a file from R27 or report a clear error (UniqueIds are stable across upgrades).

---

## 4. Other remaining work (smaller; order to agree)

| # | Item | Notes |
|---|---|---|
| 1 | **Installer / file association** | `.bimgo` → `BimGo.exe "%1"` with the ">>" icon under `HKCU\Software\Classes` (no admin needed), plus a Start-menu shortcut. Today the App build copies itself to `%LocalAppData%\Programs\BimGo\`. Could be a small `--register` switch in the app instead of a separate installer. Code signing later. |
| 2 | **Incremental refresh** | Send `model.changed` ids (capped) and have Revit re-extract only those elements into a delta snapshot. The engine then needs to append or replace geometry ranges, which today's degenerate-index hiding plus a dynamic append buffer could support. Today refresh is a full re-extract. |
| 3 | **Gizmo snap defaults in the Revit Options dialog** | `LaunchSettings.GizmoSnap`, `SnapMoveMm` and `SnapAngleDeg` already exist. Add a row with a checkbox and two combos. |
| 4 | **Redo** (file mode) | Keep a redo stack of undone `JournalEntry`s and clear it on any new edit; then reset and replay as undo does. |
| 5 | **Comments QoL** | Edit an existing comment, list comments in the pause menu with teleport-to, filter by level, export to CSV. |
| 6 | **Viewpoint bookmarks** | Named poses, stored in the file (`bookmarks.json`) or the sidecar. |
| 7 | **Coordinate readout** | Crosshair position in project / shared coordinates. `SiteInfo` (base and survey points, true north) is already captured. |
| 8 | **Sun / shadow** | Uses Gavin's `GetRevitSunVector`. Capture the sun at extraction (date and time from the active view's sun settings), then add shadow mapping in the renderer. Larger. |
| 9 | **Backlog guns** | Section/clip (clip plane uniform in `SCENE_FS`), Hide, Area/Path, Level/Height, Clearance, Photo (FBO readback to PNG). The gun bar holds 9 slots by number key, so revisit before the 10th gun. |
| 10 | **Linked models** | Extract each link as a sub-model (its own origin transform and element namespace). This touches the format (a new optional entry) and picking/metadata. |
| 11 | **Flattened save** | Bake the journal into new geometry for a "clean" export. |
| 12 | **Named-pipe transport** | Only if the folder latency becomes an issue. Callers only use `Send` / `TryReceive`. |
| 13 | **Tests** | A Core test project (format round-trip, journal replay, protocol envelopes). It needs a test framework from NuGet, so **ask first**. Alternatively, a tiny console harness with no packages. |

**Keep in mind:**

- Every add-in year shares Core, so the format (`formatVersion`) and the protocol must stay backward compatible.
- Message content is data, never something to execute.
- Validate session ids and paths.

## 5. Suggested order

1. Phase 4 `journal.apply`: decisions §3.4, then Core types, then Revit handler with dry run, then the app UI and report.
2. File association / `--register`.
3. Snap defaults in Options.
4. Redo.
5. Then the backlog by Gavin's priority.
