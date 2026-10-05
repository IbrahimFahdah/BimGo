# BimGo — Handoff Brief v5 (for a new chat)

**Purpose of the next chat:** get v5 compiling and tested, then continue the backlog (§5). v5 added the Phase 4 push (`journal.apply`), existing/new phases, file association, comments QoL and snap defaults, and **was written without a compiler** (no .NET SDK or Revit API in the cloud workspace).

**Read first:**
1. This brief.
2. `README.md` (structure, controls, how it works, `.bimgo` format, live protocol, changelog, known limitations).
3. `ai/261007_V5/1_build notes v5.md`: v5 decisions, files touched, "To verify" list and test checklist.
4. Older context if needed: `ai/261006_V4/0_BimGo v4_Handoff.md`, `ai/261005_V3/*`.
5. **Ask Gavin for a fresh zip of his working copy before editing.** He builds and fixes in Visual Studio, so his copy is the source of truth (it will include his v5 build fixes).

---

## 1. Where BimGo is now

- **Solution** `src/BimGo.sln`: **BimGo.Core** (net8.0), **BimGo.App** (net8.0-windows, `BimGo.exe`), **BimGo.Revit** (R25/R26 net8, R27 net10).
- v4 state (live sessions, file walkthroughs with journal/undo/save, gizmo snap, ">>" icon) built and worked.
- **v5 additions (not yet compiled):**
  - **Push to Revit** (`journal.apply` / `journal.result`): pause menu → PUSH TO REVIT (n)… in file mode. Matching live session by model key, temporary channel (no app.json / hello), always a dry-run preview, conflicts (> 5 mm moved) skipped unless "apply anyway" (re-checks), one Revit undo step (TransactionGroup + Assimilate), report panel + CSV, pushed entries marked `appliedToRevit` (Save keeps it). Requests > 3 MB go by file in `snapshots/`. Timeout 30 s + 0.25 s/entry.
  - **Existing / new phases** (Gavin's change): picked in Options → PHASES (saved by name in settings). Walkthrough shows the new phase; demolish = Phase Demolished → new phase, **existing elements only**; new work / built-between / unphased / clones are delete-only (hammer explains, Revit enforces); clones get Phase Created = new phase. Element phase role stored in `.bimgo` (`elements[].phase`), existing phase in `model.json`, `session.json`, `hello.ack`.
  - **File association:** `BimGo.exe --register` / `--unregister` [`--quiet`]; installed copy self-registers (HKCU, Start-menu shortcut) unless opted out.
  - **Comments QoL:** E edits hovered comment; pause menu COMMENTS list (level filter, GO, EDIT, DELETE, EXPORT CSV).
  - **Snap defaults** in the Options dialog.
  - Undo in files won't remove edits already in Revit.

## 2. Decisions taken in v5 (keep)

| Topic | Decision |
|---|---|
| Push undo | One undo step per push |
| Conflicts | Skip by default, 5 mm; optional apply-anyway (relative to current position) |
| Dry run | Always before the real push |
| Hide mode | Respect recorded mode (demolish/delete); demolition happens between the user's existing and new phases |
| Model key mismatch | Refuse |
| Session-save entries | Excluded automatically (already applied) |
| Report | In-app panel + CSV export |

## 3. First job: build and fix v5

Likely trouble spots (also in the build notes):
- `Extraction/PhaseResolver.cs`: `Element.GetPhaseStatus`, `ElementOnPhaseStatus` member names (None, Past, Existing, Demolished, New, Temporary, Future, NotApplicable).
- `Bridge/RevitEditor.Push.cs`: `TransactionGroup` Start/Assimilate/RollBack/HasStarted/HasEnded; `Document.GetElement(string)`.
- `Live/LiveDispatcher.cs`: `DBEvents.UndoOperation.TransactionRolledBack` / `TransactionGroupRolledBack`.
- `Shell/FileAssociation.cs`: `[ComImport]` ShellLink + `IShellLinkW` vtable, `IPersistFile`, Registry.
- `Forms/OptionsWindow.xaml(.cs)`: PHASES grid, 5th row in PLAYER & DISPLAY, `PhaseChoices` ctor parameter.
- Name clash watch: Revit `Phase` type vs `ElementRecord.Phase` property; `PhaseRole` is in `BimGo.Scene`.

Then run the test checklist in the build notes (phases, basic push, conflicts/missing, repeat push, wrong model, old add-in timeout, big journal, register/unregister, comments, snap defaults).

## 4. Conventions (unchanged)

- Readable, robust code, XML doc headers, explicit types where clearer; no LINQ / allocations in per-frame paths (use `TextBuffer`, cache strings).
- No NuGet packages without asking; ask before reorganising folders.
- No exceptions to the user: log via `Utilities.Log_Utils.Write`, show a toast/dialog.
- Revit template: `Commands/Cmds_BimGo.cs` `Cmd_<Button>`, `Extensions/TypeName_Ext.cs`, icons/tooltips by base name.
- Revit API only in `Commands/`, `Extraction/`, `Bridge/RevitEditor*.cs`, `Live/LiveDispatcher.cs` (Revit thread). Timers/watchers do file IO only.
- Qualify clashing names (`DB.View`, `UI.TaskDialog`, `System.Threading.Timer`, `Color`, `Point`…). Watch `x ??= M(out var y)` short-circuits.
- Format and protocol stay backward compatible (additive fields; `formatVersion` 1, protocol 1). Message content is data; validate ids and paths.
- Keep `README.md` and an `ai/<date>_V<n>/` notes file current; zip the repo minus `bin/`, `obj/`, `.vs/`.
- Font atlas: only Latin-1 plus the `EXTRA` chars in `UiFont.cs` render (→ and ← were added in v5).

## 5. Remaining backlog (order to agree with Gavin)

| # | Item | Notes |
|---|---|---|
| 1 | **Redo** (file mode) | Redo stack of undone `JournalEntry`s, cleared on new edits; reset + replay like undo. Respect the "already in Revit" undo stop |
| 2 | **Incremental refresh** | Send capped `model.changed` ids; Revit re-extracts only those into a delta snapshot; engine appends/replaces geometry ranges |
| 3 | **Viewpoint bookmarks** | Named poses in the file (`bookmarks.json`) or sidecar |
| 4 | **Coordinate readout** | Crosshair in project / shared coordinates (`SiteInfo` already captured) |
| 5 | **Sun / shadow** | Gavin's `GetRevitSunVector`; capture sun at extraction, shadow mapping in renderer |
| 6 | **Backlog guns** | Section/clip, Hide, Area/Path, Level/Height, Clearance, Photo. Gun bar is 9 number-key slots: rethink before the 10th |
| 7 | **Linked models** | Each link as a sub-model (own origin transform and id namespace); format + picking changes |
| 8 | **Flattened save** | Bake the journal into new geometry |
| 9 | **Named-pipe transport** | Only if folder latency matters (callers use Send/TryReceive only) |
| 10 | **Tests** | Core test project needs NuGet → ask first; or a no-package console harness |
| 11 | Push follow-ups (optional) | Duplicate guard for clones if a real push's answer is lost; per-entry tolerance setting; scan-gun/HUD hint when a file has pushable edits |
| 12 | Code signing / installer polish | Later |

## 6. Suggested order

1. Build + fix v5, run the checklist, update README "Known limitations" with anything found.
2. Redo.
3. Then the backlog by Gavin's priority.
