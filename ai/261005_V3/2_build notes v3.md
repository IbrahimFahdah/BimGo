# BimGo — Build Notes (v3, phase 0 + 1, 2026-10-05)

RvtGo became BimGo. This pass restructured the code into three projects, added the `.bimgo` format, the Revit **Export .bimgo** command and a standalone app that opens, edits (via a journal) and saves `.bimgo` files. It was written without a compiler (no .NET SDK or Revit API in the sandbox), so expect a round of build fixes.

## Decisions agreed with Gavin

- **Scope:** phase 0 (restructure and rename) and phase 1 (format, export, standalone app). Live sessions are phase 2.
- **Container:** a ZIP with JSON metadata and binary geometry (`geometry.bin`).
- **Rename:** full. Namespaces `BimGo.*`, ribbon tab, settings and log paths (with migration), `.addin`, new AddInId, new `BimGo.sln`.
- **Deployment:** `BimGo.exe` is net8 framework-dependent and installed to `%LocalAppData%\Programs\BimGo\`, shared by all Revit years.
- **In-Revit Go mode** stays until phase 2. The add-in references BimGo.App and hosts the engine through `GameHost`.
- **Layout:** three projects: Core, App and Revit.
- **Parameters:** the default extract is the same as today. Users can add extra parameters, picked from a scan of the model's parameter names. Bloat is low because values are pooled: each distinct value is stored once and elements hold index pairs. The cap is 24 names.

## Other decisions taken during the build

- **Edits go through `IModelSource`** (Core):
  - `InProcessRevitSource` wraps the v2 channel, renamed `EditChannel`, and its 1.5 s nudge.
  - `FileEditSource` accepts every edit at once and adds hosted elements to removals.
  - Guns call `GameSession.SubmitEdit`; the old `SubmitToRevit` is gone.
- **A journal in both modes.** Every accepted edit becomes a `JournalEntry`:
  - Targets are stored by UniqueId, with the ElementId kept as a fallback. Walkthrough clones are stored by clone key, even after Revit has given them an id.
  - Each entry also stores the request's pivot, offset and angle, plus `appliedToRevit` and the Revit id of clones.
  - So "Save as .bimgo" works mid-session in Revit, and phase 4's push has what it needs.
- **Undo** (file mode, Ctrl+Z): removes the last entry, then resets all edits and replays the journal. Rebuilding from scratch is robust against interactions (for example a door demolished, then its wall). There is no redo.
- **Replay** runs at session start on the untouched snapshot, using the v2 machinery (`SetStaticHidden`, `MakeDynamic`, `CreateClone` with a fixed key). Entries whose target is missing are skipped and counted; the toast says how many, and they stay in the journal.
- **Hosted inserts:** `ElementRecord.HostId` is captured from `FamilyInstance.Host`, ignoring link instances. In file mode, removing a host removes what it hosts, recursively.
- **Comments:**
  - Revit mode keeps a sidecar, now `<model>.bimgo-comments.json`. A legacy `.rvtgo.json` is copied across on first use.
  - File mode keeps comments inside the file. `CommentStore` raises `Changed`, which marks the document dirty.
  - Export embeds the sidecar comments.
- **Dirty tracking:** the journal revision and the comment revision are compared with their values at the last save. The title shows `BimGo — name *`, and the HUD badge shows `FILE*`.
- **Close:** End session / Close model and the window's X both ask Save / Don't save / Cancel when there are unsaved changes. Cancel withdraws the close (`GameWindow.CancelClose`).
- **App shell:**
  - Single-threaded: one `GameWindow` and a home-screen ↔ session loop. Close model returns to Home; the window's X quits.
  - The home screen uses its own `UiBatch`.
  - Single instance: a named mutex plus an inbox folder (`%LocalAppData%\BimGo\App\inbox\*.json`, `{ "open": path }`). Only existing `.bimgo` paths are accepted.
  - A second launch forwards its file and posts `WM_APP_FOCUS`.
  - Drag-and-drop uses `WM_DROPFILES`. During a session, files are queued until Close model.
- **File dialogs:** WinForms `OpenFileDialog` / `SaveFileDialog`, which are in-box. App sets `UseWindowsForms` anyway, because `UiFont` needs System.Drawing.
- **DPI:** the app calls `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` at start. Revit already does this for the in-process mode.
- **Settings:** `%AppData%\BimGo\settings.json`, copied once from RvtGo. Writes are now atomic. In a standalone file the display settings come from the viewer's own settings; the file only records the extraction options.
- **Logs:** `Log_Utils` moved to Core and is named per host: `BimGo.Revit.log` and `BimGo.App.log` in `%LocalAppData%\BimGo\Logs`.
- **The add-in references the App exe project** (temporary). `RevitBridge` now has its own `PostMessageW` import because App's `Native` is internal.
- **Export flow:** Options (button "Export…"), then the save dialog (before extraction, so a cancel costs nothing), then extract, write, and a TaskDialog with an "Open in BimGo" command link.
- **Format details:**
  - Element categories are stored as an index into `model.json` categories, which are keyed by catalog key. Unknown keys fall back to Generic models.
  - Index ranges and every vertex index are validated on read.
  - `WhenWritingNull` keeps `elements.json` small.

## To verify first

1. The solution builds for R25, R26 and R27. Watch:
   - Core/App building as Debug/Release under the R configurations (the sln maps them);
   - the add-in → exe project reference copying `BimGo.dll`;
   - ambiguous names in App (WinForms global usings), for example `TaskDialog` (qualified as `UI.` in the add-in).
2. **Go** still behaves exactly as in v2: guns, write-back, pending badge.
3. **Export .bimgo:** check the file opens in BimGo and that the following match Revit: rooms, levels, Scan details, extra parameters and comments.
4. In a file: demolish a wall (its doors should vanish), move, clone, clone of a clone, Ctrl+Z through all of them, then save, reopen and confirm the same state.
5. Save from a Revit session (Esc → Save as .bimgo), then open it in the app. Its edits should replay.
6. Single instance: double-click a second `.bimgo` while the app is open; it should be queued or opened, and the window should come forward.
7. Revit API: `GetCloudModelPath`, `BasePoint.GetProjectBasePoint/GetSurveyPoint`, `GetProjectPosition(XYZ.Zero).Angle`.

## Next (phase 2)

- `SessionHost` in the add-in: the session folder, heartbeat, watcher and `ExternalEvent` dispatch.
- `LiveSession : IModelSource` in the app.
- **Go** launches or attaches the app.
- Remove the in-Revit game and the add-in's reference to BimGo.App.

## Changelog

- 2026-10-01: v1 delivered. Door open/close removed.
- 2026-10-04: v2: room readout, symbol gun bar, Teleport / Demolish / Gizmo / Clone, Revit bridge.
- 2026-10-05: v3 phase 0 + 1: BimGo split (Core / App / Revit), `.bimgo` format, Export, standalone app, edit journal with replay, undo and save, extra parameters.
