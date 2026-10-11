# BimGo Web — build notes, upstream sync to `24c57c4`

**Ported from:** upstream `develop` @ `24c57c4` (was `eaea8bc`). Four upstream commits covering three rounds:
`261011a` Tour A1 (bookmark tour, eye-height presets), `261011b` Video + location A2 (walkthrough video, location
override), `261011d` Review tools B1 (Measure modes, snapshot markup, metric / imperial units, pause menu re-layout,
start screen thumbnails), plus the MIT-0 relicence and the B2 handoff. The merge brings the C# unchanged (not built
here: no .NET SDK in this session); this note covers the browser port.

## What was ported

| Upstream round | Web files | Notes |
|---|---|---|
| Units (Core) | `core/scene/Units.ts` (new), `game/UnitFormat.ts` (new) | Metric / imperial (feet-inches to 1/8", or decimal feet), areas in ft², coordinates in decimal feet. Applied to the status panel, coordinates, Display tab ground slider, eye-height row, Measure gun, Teleport, Gizmo / Clone readouts and drop toasts, Find room areas, study work plane / offsets / grid labels / glazing area, shadow distance toast, bookmark details. Snap steps stay metric, as upstream |
| Measure modes | `core/scene/MeasureMath.ts` (new), `game/guns/MeasureGun.ts` (rewritten), `Gun.onReselect` | 2 again cycles distance → area → angle → clearance; area fill by ear clipping; clearance down to the ground plane outside |
| Snapshot markup | `game/MarkupEditor.ts` (new), `CommentStore.setMarkup`, `DocumentModels` `snapshotOriginal` | Canvas 2D in place of GDI+ (same shapes, colours, widths, text with an outline). Opens after a new comment's picture and SET VIEW HERE; MARKUP… / MARKED UP in the detail view. `comments/<id>_original.jpg` in the `.bimgo` |
| Pause menu re-layout, CATEGORIES & LINKS | `game/Menus.ts` | Two button stacks when wide enough, two settings columns (profile, eye height, units · tabs); the category cards moved to their own panel. The web keeps SAVE / SAVE AS on one row (no PUSH button) |
| Start screen thumbnails | `BimGoReader.readThumbnail`, `BimGoWriter` (`thumbnail.jpg`), `GameSession.captureFileThumbnail`, `shell/HomeScreen.ts`, `shell/RecentFiles.ts` | Rendered off-screen at 640 × 360, stored at 384 × 216 on every save; recent cards show it (kept base64 in the browser's recent list, oldest dropped first if storage is full); REMOVE FROM LIST; the greyed last live session card |
| Tour + eye heights (A1) | `core/scene/TourTimeline.ts` (new), `DocumentModels` (bookmark tour fields, `TourSettings`), `game/Tour.ts` (new), `game/EyeHeight.ts` (new), `CharacterController.setStandingEye`, `Player` | Same timeline maths; quiet sun / section / visibility setters so a tour leaves the file unchanged (checked: `isDirty` stays false). Bookmarks keep eye height and hidden categories / links / elements; GO restores them |
| Walkthrough video (A2) | `game/VideoMode.ts` (new), `core/format/Mp4Writer.ts` (new) | WebCodecs `VideoEncoder` (H.264, High → Main → Baseline, the first the browser supports) in place of Media Foundation; MP4 packaged by our own writer (ftyp / mdat / moov, 64-bit offsets over 4 GB). Fixed-step off-screen frames, 45 ms per page frame, encoder backpressure, HUD drawn at the video's scale with its own UI batch, fade into the frame, letterboxed preview with CANCEL |
| Location override (A2) | `core/scene/Places.ts` (new), `SolarPosition` (zones, `effectiveSite`), `SunState`, `game/LocationPicker.ts` (new), `SunPanel`, `SunHoursMode`, `web/public/places.tsv` | IANA zones through `Intl.DateTimeFormat` (standard offset = the smaller of January / July; DST = the offset at local noon above it). Ctrl+V pastes coordinates (a `paste` listener feeds `InputState.pasted`) |

## Browser differences
- **Video:** needs WebCodecs (Chrome, Edge, Safari 16.4+; other browsers see a note in the VIDEO rows). Files download; no OPEN FOLDER. Frames are read back synchronously like photo mode: a few ms on a real GPU, ~0.9 s per 1280 × 720 frame on SwiftShader.
- **Tour settings view:** UI / loop ticks, the length and the VIDEO rows sit under the stops table on the right (the desktop puts them under the left column, which ran into the buttons in a ~625 px browser viewport).
- **Tour and the browser's Esc:** losing pointer lock to Esc ends the tour; losing it to focus (another window) doesn't, as the desktop keeps playing when presenting on another screen.
- **Live reloads** wait while a tour or the markup editor is open.
- **Start screen:** no SHOW IN FOLDER (a page can't open Explorer); clicking a recent card still asks for the file again.
- **Location:** the place list is fetched from the site the first time CHANGE… opens (~500 KB, ~130 KB gzipped); typed coordinates work without it.

## Sample
`make-sample.mjs`: the Cafe bookmark is now *Cafe (seated)* at a 1.20 m eye, the section bookmark holds 6 s in the tour,
`bookmarks.json` carries tour settings (fade, 20° swivel), and the tips comment mentions 2 again, PLAY TOUR / RECORD
VIDEO, eye height and units.

## Checks
- `npm test` (159 tests; new `reviewtools.test.ts`, `tour.test.ts`, `location.test.ts`, `mp4.test.ts`: the three new
  upstream Core test classes ported, plus 200 random star-shaped polygons through the triangulation, the bundled place
  list, Intl zones (Sydney, London, Kolkata, New York, Tokyo), sun.json / bookmarks.json round trips, the original and
  `thumbnail.jpg` through a `.bimgo`, and the MP4 box structure with offsets pointing at each sample), `npm run lint`,
  both type-checks, `npm run build`.
- Headless Chrome (SwiftShader) on the sample: the pause menu (two stacks, two columns, imperial), CATEGORIES & LINKS,
  tour settings, a tour with the UI on (player, sun and visibility restored, file not dirty), Measure modes (2 × 3 m
  area → 6 m², 10 m perimeter; clearance), a comment → markup editor → box + arrow drawn with real mouse drags → Enter
  saved (picture and original kept), the location picker (Perth; London by typed coordinates, DST auto on 1 July),
  SAVE AS (thumbnail written, recent card shows it), and RECORD VIDEO (320 × 180 for the test: 193 frames, played back
  by Chrome's own decoder, 6.43 s, HUD in the frames). `gl.getError()` 0 throughout.

## Not verified here
- Real GPUs, and 1080p / 4K recordings end to end (only the small test size ran on SwiftShader).
- Safari's and Firefox's WebCodecs H.264 encoders.
- The C# side of the merge (no .NET SDK in this session).
