# Clash detection, build C-B2: build notes

**Not compiled here** (no .NET SDK reachable from the sandbox). Brackets, new member names (no duplicates across the
`GameSession` partials), type-name ambiguities across the new `using`s and UI glyphs (Latin-1 + `UiFont.EXTRA`) were
checked by script. Build first, then the Core tests; then README §8 "Clash detection, build C-B2" step by step.

## What is in

| Item | Where |
|---|---|
| **Section box sticks**: off stays off from clash to clash (GO no longer forces it on); on follows each GO | `GameSession.ClashMode.cs` (`_clashBoxOn` starts on; `GoToClash`, `ToggleClashBox`) |
| `FrameClash` (camera + clash section box for any clash), shared by GO and the pictures; `_clashFrame` kept for Revit | `GameSession.ClashMode.cs` |
| **Row pictures** 160 × 90 (rendered 320 × 180, 2 × 2 filtered), lazily for visible rows, ≤ 2 per frame (1 in the real model view) within ~40 ms, cached per session (≤ 300), stale on G / B (old picture shows meanwhile), the visited clash re-taken; **PICTURES: ON / OFF** (`LaunchSettings.ClashRowPictures`, default on) | new `Game/Clashes/GameSession.ClashPictures.cs`; rows in `GameSession.ClashDock.cs` |
| Off-screen clash pictures through `RenderScene(photo: true)` with `_clashShot` (clash view drawn in the photo pass); no AO / glow (`SceneRenderer.SkipScreenEffects`, targets kept); unlit views skip the sun cascades and light picking | `GameSession.Render.cs`, `Rendering/SceneRenderer.cs` |
| **TO COMMENT / UPDATE COMMENT** (what you see; mid-flight = the flight's end), 1280 × 720 picture + 192 × 108 thumbnail, view (flying) + section, text, status / priority / assignee; marked-up picture → confirm | `GameSession.ClashPictures.cs` |
| **LIST TO COMMENTS…** (≤ 500, confirm, per-clash framing, budgeted per frame, progress + CANCEL on the card, Esc cancels, saved every 25, markup kept); TESTS… and leaving clash mode cancel it | `GameSession.ClashPictures.cs`, `.ClashDock.cs`, `.ClashMode.cs` |
| Comment follows the clash: status (1–5, runs, imported reports) and assignee (ASSIGN…) | `SyncClashComment(s)`; `GameSession.Clashes.cs`, `.ClashDock.cs` |
| Core `ClashCommentRules` (status map, priority, batch limit 500); `CommentRecord.ClashId` (optional, `clashId`) | `Clashes/ClashModels.cs`, `Format/CommentModels.cs` |
| BCF: clash comments are "Clash" topics, both elements as components | `Format/BcfMapping.cs`, `GameSession.Bcf.cs` |
| `CommentStore.Add / SetIssue / SetPictures` gain `save` (batches save once) | `Game/CommentStore.cs` |
| **SHOW IN REVIT**: `SelectPayload.Hosts` + `ClashView` (`ClashViewRequest`), `ILiveLink.ShowClash`; add-in `ShowClash` (view "BimGo clash": find / `View3D.CreateIsometric`, no template, `SetSectionBox`, `IsSectionBoxActive`, `SetOrientation`, transaction "BimGo: clash view"; active view; host + linked selected together; zoom to the region). `SelectLinked` accepts host elements. R's label: "Show in Revit: the pair selected in a clash 3D view (live)" | Core `Live/LiveProtocol.cs`, `Live/LiveSessionSource.cs`, Revit `Live/LiveDispatcher.cs`, `InputCatalog.cs` |
| Tests: `ClashTests` +2 (26), `LiveProtocolTests` +1, `LaunchSettingsTests` +1 | `tests/BimGo.Core.Tests` |
| README: rule 6 (the clash view is the one model change BimGo makes on its own request), §3 R row (hand-written in the generated format), notes, §4, §5, §6 (`clashId`, `ClashRowPictures`), §7 (`hosts[]`, `clashView`), §8, §9 | `README.md` |

## What is not in

Grouping, multi-select (Ctrl / Shift click) and BCF by group (C-C); a key for TO COMMENT (hotkey review); gamepad
buttons for G / B / PICTURES; AO in clash pictures; rewriting a clash comment's text on update.

## Watch when building

- `Gl.TexImage2D(..., void*)` with a `fixed` byte array (as `ThumbnailTexture` does with `Scan0`).
- `ClashView` (Core record struct) vs `ClashViewRequest` (Core Live) vs `SelectPayload.ClashView` (property).
- `BimGo.Clashes.ClashRecord` is written fully qualified in `GameSession.Bcf.cs` (no `using BimGo.Clashes` there).
- Revit: `View3D.IsLocked`, `ViewOrientation3D` (up ⟂ forward: built as (f × Z) × f), `UIDocument.ActiveView` setter inside
  the external event, `Selection.SetReferences` mixing host and link references.
- On a 720 px high window the list shows about two picture rows: PICTURES: OFF gives text rows back.
