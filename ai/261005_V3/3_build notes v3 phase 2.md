# BimGo — Build Notes (v3 phase 2 + phase 3 QoL, 2026-10-06)

Phase 0 + 1 built and tested clean. This pass adds live Revit sessions and removes the engine from Revit's process. It also pulls in the phase 3 session QoL items Gavin asked for, plus a gizmo snap-increment system. It was written without a compiler, so expect a small round of build fixes.

## Decisions agreed with Gavin

- **Source:** the v3 zip as delivered. It built with no local changes.
- **In-Revit game removed.** Go now launches or attaches BimGo.exe. BimGo.Revit no longer references BimGo.App, and `GameHost`, `InProcessRevitSource` and `EditChannel` are deleted.
- **Scope:**
  - phase 2 core;
  - Show in Revit (R);
  - model changed → refresh;
  - ribbon session status;
  - gizmo snap increments.
- **A Go from Revit while walking another model:** the app asks, then switches. A Go for the same session simply reloads, because its new snapshot arrives as `extract.ready`.

## Other decisions taken during the build

### Transport

- One folder per Revit document session: `%LocalAppData%\BimGo\Sessions\<32-hex id>\`.
- Messages are one JSON envelope per file, named `<utc>-<seq>-<type>.json`, written as a temp file and then renamed.
- The reader uses a `FileSystemWatcher` plus a 1 s poll, processes files in name order, de-duplicates by message id (in case a delete fails), and deletes each file after reading.
- Readers validate the session id, the protocol version and the size (4 MB cap).
- Geometry never travels in messages, only snapshot paths.
- Callers only use `Send` / `TryReceive`, so named pipes can replace the folders later.

### Heartbeats

- Revit rewrites `session.json` every 2 s from a thread-pool timer that does file IO only. The same timer flushes counted `model.changed` events and reads the app's `app.json` to update the ribbon status.
- The app writes `app.json` every 2 s and re-reads `session.json`.
- A heartbeat older than 10 s, a dead process or state `closed` means the other side is gone:
  - the app fails any waiting edits (so the guns revert them);
  - shows OFFLINE;
  - refuses new edits until the heartbeat recovers.
- `session.closing` makes the walkthrough read-only. Saving as `.bimgo` still works.

### One ExternalEvent for all sessions

- `LiveDispatcher.Execute` drains every session's queue on the Revit thread.
- Each session's channel raises the event when messages arrive, then posts `WM_NULL` to Revit's main window to wake its message loop.
- The event is created lazily in the first Go or Status command, which provides the API context.
- `RevitBridge` became `RevitEditor`: same transaction and failure logic and the same clone-key map, one instance per session.

### Snapshots

- Written with `NoCompression` as kind `live-snapshot`. The manifest also carries `commentsSidecar`, so the app keeps reading and writing the comment sidecar beside the model.
- The latest 2 snapshots are kept, numbered.
- The app treats a higher `SnapshotNumber` (from `extract.ready`, or noticed later in `session.json`) as "reload".

### Reload

- The session ends with `SessionEndReason.Reload`. It waits until no edit is pending, no gizmo is locked and no comment is being typed.
- The shell re-joins the same session with a `SessionPose`: feet, look, fly, home, active gun and minimap.
- The pose is stored in Revit internal coordinates, because a new snapshot can have a different scene origin.
- The new snapshot replaces the old one, so clone keys restart. Revit's key map is overwritten by new copies, and older clones are now real elements in the snapshot.

### Model changes

- `DocumentChanged` counts added, modified and deleted elements.
- Committed transactions whose names all start with `BimGo:` (BimGo's own edits) are skipped. Undoing one counts, because the walkthrough still shows the edit.
- The app shows a banner, MODEL CHANGED IN REVIT (n) · F5 REFRESH; F5 sends `extract.request`. Revit re-extracts with the saved Options on the Revit thread.
- `SceneExtractor` now tolerates an inactive document: if the active view is unavailable it gives no spawn, and the reload keeps the player's pose anyway.

### Show in Revit

- Scan → R sends `select.elements`.
- Revit filters the ids to elements that still exist, then calls `Selection.SetElementIds` and `ShowElements` (failures are logged) and `SetForegroundWindow`.
- The app first calls `AllowSetForegroundWindow(revitPid)` so Revit is allowed to come to the front.
- If the session's model isn't Revit's active document, the app is told to switch.

### Ribbon

- A third button, **Live**, whose text is `Live off`, `Live ready` or `Live attached`. It is updated on Idling when the dirty flag is set.
- Clicking it opens a TaskDialog for the active model with three options:
  - bring the app forward, or open the session in it;
  - send a fresh snapshot;
  - end the session.

### App shell

- `OpenTarget` (a file or a session, with an optional pose) replaces plain paths everywhere.
- The inbox accepts `{ "attach": id }` as well as `{ "open": path }`. A second instance forwards either.
- The home screen lists live sessions (rescanned every 2 s, alive only) above Recent.
- `--session <id>` on the command line.
- If a switch's save prompt is cancelled, the pending switch is dropped.

### Gizmo snap

- The snap state lives on the session and is persisted in settings as `GizmoSnap`, `SnapMoveMm` and `SnapAngleDeg`.
- **G** toggles snap mode whenever the Gizmo or Clone gun is selected. **Ctrl** inverts it while held.
- While locked on, **Z / X** step the move increment through 5, 10, 25, 50, 100, 250, 500 and 1000 mm, and **C / V** step the angle increment through 1, 5, 10, 15, 30, 45 and 90°.
- In snap mode each key press or key repeat moves exactly one increment along the world X / Y axis nearest the view direction, or rotates one increment. The change since lock-on is clamped to whole increments, which also tidies a smooth move made before snap was turned on.
- The panel shows the snap state and increments.
- These keys only change increments while locked on, because V (fly) and X (clear markers) are global keys otherwise.

## To verify first

1. The build, especially:
   - `Live/` in the Revit project: `UndoOperation`, `DocumentChangedEventArgs.GetTransactionNames`, `UIControlledApplication.ApplicationClosing`, `RibbonItem.ItemText`, `UIDocument.ShowElements`;
   - `System.Threading.Timer` and `DB.View` qualified against the WinForms usings.
2. Go with the app closed: the app starts and joins. Go again: it reloads where you stand. Go from a second model: the app asks to switch.
3. Edits round-trip:
   - demolish, move and clone in the app all show in Revit, and the HUD shows `REVIT · n pending` while Revit is busy (open a modal dialog in Revit to test);
   - a refused edit reverts.
4. Edit something in Revit: the banner appears; F5 reloads the new snapshot with the player in the same place.
5. Scan → R selects and zooms in Revit, and Revit comes to the front.
6. Close the model in Revit: the app shows the closing notice, goes read-only, and Save as `.bimgo` still works.
7. The ribbon Live text changes as the app attaches and detaches.
8. Gizmo snap: G, Ctrl, Z/X/C/V; a committed snapped move lands exactly in Revit.

## Next (phase 4)

- `journal.apply`: push a file's journal into a matching live session by UniqueId, with a per-entry report.
- Incremental refresh (`model.changed` ids → re-extract only those elements).
- Optional: gizmo snap defaults in the Revit Options dialog, flattened saves, linked models.
