# Round B1 (review tools): build notes

**Baseline:** build A2 (Gavin's working copy, confirmed building). **Not compiled here** (no .NET SDK). Brackets
checked on every changed file; GameSession partials scanned for duplicate member and nested type names (none);
OptionsWindow.xaml parsed as XML. The feet-inches rounding and the ear clipping were ported to Python (5,000 random
simple polygons: the triangles always add up to the outline's area). No shaders changed. Please build and run the
Core tests (new `ReviewToolsTests`: 11).

## Core
- `Scene/Units.cs` (new): `UnitSystem` (Metric / Imperial), `Units` (feet / ft² conversions, `FeetInches` to 1/8"
  reduced, `Length`, `Coordinate` (decimal feet in imperial), `Area`). Note: Revit's API also has `UnitSystem` and
  `Units`; BimGo.Revit qualifies `BimGo.Scene.UnitSystem`.
- `Scene/MeasureMath.cs` (new): `PlaneAxes`, `RayPlane`, `ProjectToPlane`, `PolygonArea`, `Perimeter`,
  `AngleDegrees`, `Triangulate` (ear clipping, either winding; fan fallback for self-intersecting outlines).
- `Scene/LaunchSettings.cs`: `DisplayUnits`, `DecimalFeet` (sanitised).
- `Format/CommentModels.cs`: `SnapshotOriginal` (+ `SnapshotOriginalData` / `Dirty`, `HasMarkup`); `Clean` drops an
  original without a picture. `Format/CommentFiles.cs`: `OriginalNameFor` (`comments/<id>_original.jpg`), model
  folder read / write of the original (kept out of the unused-picture clean-up), `WriteAtomic`.
- `Format/BimGoReader.cs` / `BimGoWriter.cs`: the original beside the picture; optional `thumbnail.jpg`
  (`ReadThumbnail(path)` reads only that entry; ≤ 2 MB). `Format/BimGoDocument.cs`: `Thumbnail`. Format version stays 1.

## App
- `Game/Guns/MeasureGun.cs`: rewritten for the four modes (distance, area, angle, clearance), mode chips in the
  panel, live values, units. `Gun.OnReselect` (new virtual); `GameSession.UpdateFrame` calls it when the selected
  gun's key is pressed again. `GameSession.GroundZ` (new, for clearance outside).
- `Game/UnitFormat.cs` (new): current units (static, per machine), `AppendLength` / `AppendArea` /
  `AppendCoordinate` (no allocation) and string versions. Read / written with the session's settings.
- Units applied: status panel (level, ground), coordinate readout, Display tab ground slider, eye-height row and
  toast, sun hours offsets / work plane / grid labels / legend title, gizmo move readout and drop messages, Teleport
  distance, Find room areas, glazing area, shadow distance toast, bookmark details (`BookmarkStore.RefreshLabels`).
  Snap increments stay metric.
- `Game/GameSession.Menu.cs`: pause menu re-laid out: session / review button stacks (one stack under ~1200 px),
  settings in two columns (profile, eye height, **UNITS** · the tabs), stacked under ~960 px; `BuildSettingsColumn`,
  `BuildSettingsTabs`, `BuildUnitsRow`, `SetDisplayUnits`. Heights at 1280 × 720: buttons ≤ 9 rows at 53 px, tabs
  column ends at 520 px.
- `Game/GameSession.Geometry.cs` (new): CATEGORIES & LINKS panel (the category cards and links moved there; Esc /
  CLOSE back; the button counts what's off).
- `Game/GameSession.Markup.cs` (new): the markup editor (tools, colours, thicknesses, undo / redo / CLEAR as an
  operation, text typing, GDI+ burn into a preview texture, SAVE → `CommentStore.SetMarkup`). Opened from
  `CaptureThumbnail` (new comment, SET VIEW HERE: `_markupAfterCapture` → `_markupPending`, opened at the next frame)
  and the detail view's MARKUP… button; drawn in place of the pause menu, keys in `UpdateFrame` before the comment
  editor. `CommentStore.SetPictures` drops the original when a new picture is taken.
- `Game/GameSession.Thumbnails.cs`: `CaptureFileThumbnail` (photo pass at 640 × 360 → 384 × 216 JPEG, camera /
  framebuffer / viewport restored); `GameSession.Document.Save` stores it (keeps the old one if the render fails).
- `Shell/HomeScreen.cs`: recent cards with thumbnails (textures freed when the screen is left), SHOW IN FOLDER
  (Explorer `/select`), REMOVE FROM LIST, the greyed last live session card. `Shell/RecentFiles.cs`:
  `LastLiveSession` (`LastLive.json`), `RecentInfo.Thumbnail`. `Shell/AppShell.cs`: records the joined session.
- Help: "2 AGAIN" row.

## Revit
- `Forms/OptionsWindow.xaml(.cs)`: Player → Units (Metric / Imperial, Decimal feet).

## Judgement calls (say if you want them changed)
- Markup also opens after SET VIEW HERE (the picture is retaken there too); SKIP / Esc keeps it clean.
- Coordinates in imperial are decimal feet, not feet-inches.
- Sun hours grid sizes stay metric; imperial labels read ≈4" / ≈10" / ≈1'8" / ≈3'3".
- The units setting sits in the settings column beside the eye height rather than inside the Display tab (that
  card was already full).

## To verify
See README §8 (Review tools, build B1).
