# BimGo v5 build notes: push to Revit, existing / new phases, QoL

Follows `ai/261006_V4/0_BimGo v4_Handoff.md`. Written without a .NET SDK or the Revit API assemblies, so **nothing here has been compiled yet**: expect a round of build fixes in Visual Studio (see "To verify" below).

## Decisions (Gavin, 2026-10)

| # | Question (v4 handoff §3.4) | Decision |
|---|---|---|
| 1 | Undo granularity | **One undo step** per push (`TransactionGroup` + `Assimilate`), each entry still in its own transaction |
| 2 | Moved-since-export conflicts | **Skip by default, 5 mm.** A preview checkbox applies them anyway, relative to where the element is now (ticking it re-runs the dry run) |
| 3 | Dry run | **Always** a dry-run preview before the real push |
| 4 | Hide mode on push | **New:** the user picks the **existing** and **new** phases at startup (Options dialog). Demolition happens between them. Each entry's recorded mode is respected: demolish (Phase Demolished = new phase) or delete |
| 5 | Model key mismatch | **Refuse.** The push is only offered to a live session whose model key equals the file's (Revit checks again) |
| 6 | Live-session saves | Excluded automatically (their entries are `appliedToRevit`) |
| 7 | Report | In-app panel, plus **EXPORT REPORT…** (CSV) |
| – | Scope after phase 4 | File association / `--register`, Comments QoL, snap defaults in Options. Redo and the rest of the backlog are still open |

## Existing / new phases (decision 4)

- `LaunchSettings.ExistingPhase` / `NewPhase` (names; shared settings). Options → **PHASES** shows the model's phases: new defaults to the launch view's phase (else the last), existing to the phase before the chosen new phase. The existing phase must come before the new one.
- `Extraction/PhaseResolver.cs` resolves the pair (falls back to defaults with a note when a saved name is missing) and classifies elements with `Element.GetPhaseStatus`:
  - **Existing**: there in the existing phase, still standing in the new phase → demolishable.
  - **New**: created in the new phase (or temporary) → delete only.
  - **Between**: built after the existing phase, before the new one → delete only.
  - **Unphased**: no phase status → delete only.
- Extraction keeps what stands in the new phase (status Existing / New / None). Before v5 *every* demolished element was dropped, including those demolished in a later phase.
- `RevitEditor`: demolish checks `PhaseResolver.DemolishBlockReason` (already demolished → "already applied" on push), then sets `PHASE_DEMOLISHED` = new phase. Copies get `PHASE_CREATED` = new phase and any inherited demolition cleared (best effort, logged on failure).
- App: the hammer refuses demolish up front for new / between / unphased elements and clones ("press T to delete it instead"); its panel shows "Demolish · Existing → New" and warns on hover. Scan shows the phase role. Home screen shows "Existing → New". `scene.PhaseNote` is toasted once when a saved name was missing.
- Format (additive, `formatVersion` stays 1): `model.existingPhaseId/Name`, `model.phaseNote`, `elements[].phase` (`new` / `between` / `unphased`, omitted for existing). Older files read as "all existing". `session.json` and `hello.ack` gained `existingPhaseName`.

## Phase 4: `journal.apply`

### Core
- `Live/LiveProtocol.cs`: `MessageTypes.JOURNAL_APPLY` / `JOURNAL_RESULT`; `JournalStatus`; `CloneRef`; `JournalApplyPayload` (requestId, dryRun, toleranceMm = 5, applyConflicts, modelKey, phase names, fileName, knownClones, entries, payloadPath); `JournalEntryResult`; `JournalResultPayload` (+ `Count()`).
- `Live/JournalPush.cs`: app-side helper. `FindSessions(modelKey)`, `BuildRequest(journal, …)` (pending entries + clones already in Revit), `Send` (over 3 MB → `snapshots/push-<id>.json` + `payloadPath`), `Poll` (matches requestId, ignores everything else, handles `session.closing`, timeout 30 s + 0.25 s per entry), `ResolvePayloadFile` (Revit side: path must be a `push-*.json` directly in that session's snapshots folder; deleted after reading).
- `Edits/EditJournal.cs`: `PendingForRevit()`, `MarkApplied(seq, revitElementId)` (bumps the revision → dirty).

### Revit
- `Bridge/RevitEditor.cs` refactored: `Apply` (live) = resolve + `Execute(doc, element, request, phases, out newId)`; phases via `SetPhases(existingId, newId)` (SessionHost sets them per snapshot).
- `Bridge/RevitEditor.Push.cs`: `ApplyJournal(doc, request, sessionModelKey)`:
  1. refuse if the document can't be edited or the model key differs;
  2. phases: the file's new phase by name, else the session's (note in the result); existing by name if before it, else the session's / the phase before;
  3. `TransactionGroup("BimGo: Push N edits from <file>")`; per entry: resolve (UniqueId, ElementId fallback; clone targets via the push-local key map seeded with `knownClones`; "its clone (edit #k) was not applied" when a dependency was skipped); borrowed check; hide → delete / demolish rules; transform / clone → location point vs pivot (conflict > tolerance unless applyConflicts) → `Execute`;
  4. dry run → `RollBack` (new ids zeroed); real → `Assimilate` (undo label returned); nothing applied → `RollBack`.
- `Live/LiveDispatcher.cs`: `journal.apply` → `PushJournal` → `journal.result` (reply to the envelope). Rolled-back BimGo transactions / groups (push previews) no longer count as model changes.

### App
- `Game/GameSession.Push.cs`: panel states Closed / Error / Checking / Preview / Applying / Done; rows built once per answer; preview checkbox re-runs the dry run; Done → `MarkPushed` (journal + clone `RevitId`), SAVE, EXPORT REPORT…, CLOSE. Esc closes the panel except while a real push is in flight. Ctrl+Z is ignored while the panel is open.
- Pause menu (files): **PUSH TO REVIT (n)…**. `AppShell` switch prompt adds "Choose No to stay in this file and push its edits" when the arriving Go is the file's model.
- Undo in a file refuses to remove an entry that is already in Revit.

## Other items

- **File association** (`Shell/FileAssociation.cs`): HKCU `.bimgo` → `BimGo.Model` (DefaultIcon = exe,0; open command), `Applications\BimGo.exe`, Start-menu `BimGo.lnk` (COM `IShellLinkW`), `SHChangeNotify`. `--register` / `--unregister` [`--quiet`] in `Program`; the installed copy self-registers on start when missing / stale, unless an opt-out marker from `--unregister` exists (`%LocalAppData%\BimGo\App\no-file-association`).
- **Comments QoL**: `CommentRecord.Edited` / `EditedBy`; `CommentStore.Update`, `ExportCsv`; comment editor edit mode (`BeginCommentEdit(record)`); Comment gun **E** edits the hovered marker; `Game/GameSession.Comments.cs` list panel (level filter ← →, GO teleports 1.6 m in front facing the marker, EDIT, DELETE with confirm, EXPORT CSV…).
- **Snap defaults** in Options (PLAYER & DISPLAY → Gizmo snap: checkbox + move / angle combos).
- Font atlas gained `←` and `→`.

## To verify when building

- `ElementOnPhaseStatus` member names (None, Past, Existing, Demolished, New, Temporary, Future; there is no NotApplicable: None covers unphased and lookup failures) and `Element.GetPhaseStatus` on 2025–2027.
- `TransactionGroup.Assimilate` / `HasStarted` / `HasEnded`; `DBEvents.UndoOperation.TransactionGroupRolledBack` / `TransactionRolledBack`.
- `Document.GetElement(string uniqueId)` overload.
- COM interop in `FileAssociation` (`[ComImport]` class + `IShellLinkW` vtable order; `IPersistFile` from `System.Runtime.InteropServices.ComTypes`).
- Name clashes: `Phase` (Revit) vs `ElementRecord.Phase` (property, not a type); `PhaseRole` lives in `BimGo.Scene`.
- XAML: the PHASES grid and the new 5th row in PLAYER & DISPLAY.

## Test checklist

- **Phases:** Options shows the model's phases with sensible defaults; existing after new is refused. Walkthrough hides elements built after / demolished by the new phase. Hammer: demolish an existing wall (Phase Demolished = new phase, doors too); try a new-construction element (refused up front with the T hint); T → delete works. Clone in a live session → copy's Phase Created = new phase.
- **Basic push:** export, edit offline (demolish a wall with doors, move a chair, clone a desk, clone the clone), Go in Revit (answer No to switch), PUSH → preview → push; check Revit, one Ctrl+Z undoes it all; Save the file.
- **Conflicts / missing:** move the chair in Revit first → conflict (skipped); tick "apply anyway" → re-check → applies relative. Delete an element in Revit → skipped (or "already gone" for a delete entry).
- **Repeat push:** second push says everything is already in Revit.
- **Wrong model:** a file from another model never finds a session ("Open <title> in Revit…").
- **Old add-in:** with a v4 add-in the app times out with the update hint.
- **Big journal:** > 3 MB request goes by file (log line "sent by file").
- **Register:** `BimGo.exe --register` → double-click a .bimgo opens BimGo with the ">>" icon; `--unregister` removes it and stops self-registration; running the installed copy re-registers only without the opt-out marker.
- **Comments:** E edits a hovered comment (header shows EDITED); list filter, GO, EDIT, DELETE (twice), EXPORT CSV opens in Excel with accents intact.
- **Snap defaults:** set in Options → the walkthrough starts with them.
