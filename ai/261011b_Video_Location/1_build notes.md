# Tour round, build A2: build notes

**Baseline:** build A1. **Not compiled here** (no .NET SDK). Brackets checked; partials scanned for duplicate
members (none new). The place search ranking and the coordinate parser were ported to Python and checked against
the real list; the Media Foundation GUIDs and vtable order were checked against the Windows SDK interface
definitions (mingw-w64's copies). Please build and run the Core tests (new `LocationTests`: 10; `TourTests` +1).

## Core
- `Scene/Places.cs` (new): `TimeZones` (IANA → `TimeZoneInfo`, cached; standard offset; longitude estimate),
  `Place`, `PlaceIndex` (load the TSV, `Search`, `Nearest`, `DistanceKm`, `TryParseCoordinates`, `Fold`).
- `Scene/SolarPosition.cs`: `GeoLocation.ZoneId` / `AutoDaylightSaving`; `Compute` applies `IsDaylightSaving`
  (zone rules per date when automatic, else the tick); `EffectiveSite(site, override)`; `LocationOf` carries the zone.
- `Scene/ModelInfo.cs`: `SiteInfo.ZoneId` / `AutoDaylightSaving` (`[JsonIgnore]`: never in model.json), `Copy()`.
- `Format/SunModels.cs`: `SunSettings.Location` (`LocationOverride`: lat, long, standard offset, zone, auto DST,
  name; `Clean`, `IsValid`, `Copy`).
- `Scene/LaunchSettings.cs`: `VideoSize` enum, `VideoSize`, `VideoFps` (30 / 60).

## App
- `Native/MediaFoundation.cs` (new): `Mp4Writer` (MFStartup, sink writer from URL, H.264 High output / RGB32 input
  types, hardware first then software, `WriteFrame` (flips GL rows to top-down), `Finish`, `Dispose`).
- `Game/VideoRecorder.cs` (new): worker thread, 3 pooled frame buffers, `Rent` / `Submit` / `Complete` / `Cancel`,
  deletes the file on cancel or error.
- `Game/GameSession.Video.cs` (new): settings, `StartVideo` (size, GPU limit, MSAA within the photo budget, video UI
  batch, bitrate, path), `UpdateVideo` (Esc), `RenderVideo` (45 ms of frames per window frame, letterboxed preview,
  progress panel), `RenderVideoFrame` (tour clock = frame / fps, camera, scene, HUD, fade, read back, submit),
  `BuildVideoHud` (swaps in the video UI batch and scale), `EndVideo` / `AbortVideo`, OPEN FOLDER.
- `Game/GameSession.Location.cs` (new): effective site, labels, `SetLocationOverride`, picker (search box, paste,
  results, coordinates row, UTC − / +, RESET, credit line), DST auto switch.
- `GameSession.Sun.cs`: the location line with CHANGE…, the picker inside the panel, DST AUTO / AUTO buttons,
  `RefreshSunLocation` at start, DST shown as effective. `GameSession.SunHours.cs` / `.Daylight.cs`: studies use
  `SunSite`; the study panel shows "Daylight saving: auto".
- `GameSession.Tour.cs`: video branch in `UpdateTour`; VIDEO section (size, fps, OPEN FOLDER). `GameSession.Bookmarks.cs`:
  RECORD VIDEO beside PLAY TOUR in the tour settings. `GameSession.Render.cs`: recording branch; `DrawMinimapPlan`
  takes a surface size. `GameSession.cs`: video settings read / written; a recording is aborted before closing.
- `Rendering/RenderTarget.cs`: `BlitToWindowFit` (letterboxed, linear).
- `Resources/places.tsv` (new, 7,342 places, ~500 KB) copied beside the exe (`BimGo.App.csproj`).

## Other
- `make_places.py` (this folder): builds `places.tsv` from Natural Earth (`python make_places.py <geojson> <out> <commit>`).
  Kept here rather than a new `tools/` folder (README: ask before adding folders); move it if Gavin prefers.
- `THIRD-PARTY-NOTICES.txt`: Place list section (source, commit, conversion, licence quote, credit), Media Foundation
  and Windows time zones under "Not shipped", acknowledgements for IANA zone names, coordinate parsing, the
  Media Foundation interface cross-check (mingw-w64, ZPL 2.1, nothing copied), MP4 / H.264.

## To verify
See README §8 (Video and location, build A2).
