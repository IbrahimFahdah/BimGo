# Round K, build K-C: smooth tour, convert to path, key photos, sun polish (2026-10-18)

Built on Gavin's zip `BimGo_Handoff_KC`. **Not compiled here** (no .NET SDK): build first, then the Core tests (and
please confirm K-B's `ControlsTests` fix passes: that closes K-B).

Checked by script: brackets, strings (interpolation holes) and char literals in every changed `.cs` file; new member names
once across the `GameSession` partials; UI strings against the font atlas; encodings kept (BOMs where they were, LF; the
new file without a BOM). The new timeline maths (swivel, follow between) ported to Python: the test values match and a
four-stop smooth tour turns at most 0.007 rad per frame at 120 fps (no jumps). **No new keys** (defaults version stays 3).

## In

| Item | What it does | Where |
|---|---|---|
| **SMOOTH tour** | MEDIA → TOUR: "Between stops: Fade · Glide · **Smooth**", then **Speed between stops** (0.25–6 m/s, 0.25 steps). The ticked stops become one camera path: each key at the bookmark's eye (feet + its eye height; crouched lower), holding its own view for the stop's hold with its swivel; the camera follows the path between stops and turns into each view (and out of it); the tour's fades at the ends, loop and UI. Plays through the tour player as before (HUD "TOUR · n / m" with the bookmark names; each stop's sun, cut, hidden items, eye height and profile; the sun blends between stops). VIDEO records it; the length shown in TOUR / VIDEO is the smooth one. One ticked stop plays as a fade. Older builds read the file and play the tour with its Fade / Glide setting. | `GameSession.Tour` (`StartTour`, `TourAsPath`, `SmoothTourLength`, `BuildTourSettings`); Core `TourSettings.Smooth`, `SmoothSpeed` |
| **CONVERT TO PATH** | MEDIA → TOUR, under the length: the ticked stops into a new path "<model> tour" (made unique: "… 2"), same shape as the smooth tour, with each bookmark's sun, colour profile, cut and hidden items copied onto its key. Opens in PATHS with a notice. The tour is left as it is. | `ConvertTourToPath`; `PathStore.AddPath(CameraPath)`, `UniqueName` |
| **Key swivel** | PATHS key editor: **Swivel** (−180…+180°, 15° steps, × clears; + turns left) when the key holds its own view and has a hold: it pans over the hold (eased), and the camera leaves from the panned view. Key rows show "swivel 30°". | Core `CameraKey.Swivel`, `CameraPathPoint.Swivel`, `CameraPathTimeline` (`KeyView`, the hold fraction) |
| **Follow between key views** | Path strip checkbox: between two own-view / look-at keys the camera turns out of the first into following the path, then into the second (segments of 2 × look-ahead or more; shorter ones turn straight, as before). Off by default; on for a converted tour. | Core `CameraPath.FollowBetween`, `CameraPathSettings.FollowBetween`; `BuildPathSettings` |
| **Key cut and hidden items** | PATHS key editor: **Cut, hidden**: "Leave as it is" / "a cut · 3 hidden"; **USE THE VIEW NOW** keeps the section cut and hidden items showing now, × clears. From that key on (like the profile); before any key sets them, the walkthrough's. PLAY PATH, video, key photos and the editor's preview apply them. | Core `CameraKey.Section`, `Visibility` (+ `VisibilitySettings.Copy`); `PathRecords` |
| **PHOTO AT THIS KEY** | PATHS key editor (under the order buttons) and the 3D dock: the camera goes to the key's view as the path plays it (start of its hold; a follow key looks along the path), the key's sun / profile / cut / hidden items show, and photo mode opens. Closing photo mode puts the walkthrough back (position, eye, walking / flying, sun, profile, cut, hidden); from the dock, it goes back into the editor with the key selected. | `GameSession.KeyPhotos` (`OpenPhotoAtKey`, `EndKeyPhoto`); `ClosePhotoMode` |
| **PHOTOS OF ALL KEYS** | PATHS, under the selected path's buttons: plays the path through the tour player (UI hidden), stops at each key for 3 frames, shoots with the PHOTO settings (still or 360°, size, format, exposure, grid lines), into `Pictures\BimGo\<model> <path> <date time>\01 <key>.png` … A bar shows "PHOTOS OF ALL KEYS · 3 / 12", the key and "Esc stops". It waits while two photos are still being encoded, and at the end for the last saves; then the walkthrough comes back and a toast says how many went where. | `StartKeyPhotos`, `UpdateKeyPhotos`, `FinishKeyPhotos`, `BuildKeyPhotosOverlay`; `UpdateTour`, `BuildTourOverlay`; `PhotoPath` (`_photoNamed`), `_photoSaving` |
| **Editor preview with state** | In the 3D editor, scrubbing or previewing (Space) shows the path's state: the key's sun (moving between keys), profile, cut and hidden items; previewing also shows the fades. The walkthrough's state comes back when the camera leaves the path (fly off, ← / → snap), the path is switched, the editor closes, or a tour / key photo starts. | `ShowPathEditState`, `EndPathEditState` (the tour player's `ApplyTourStop` / `BlendTourSun` over the path's records); `SaveWalkthroughForTour` → `RememberWalkthrough` + `RestoreWalkthroughState` |
| **Dock sun row** | The selected key's sun in the 3D dock: the date and time (or "Between its neighbours'"), USE THE SUN NOW (the sun showing: on the path, the path's), −30 / +30 MIN, ×. Undoable (Ctrl+Z). | `BuildPathDock` |
| **Scrubber sun strip** | A thin band under the scrubber's track when any key keeps a sun: the sun's height along the path (the playback blend; dark = night, orange = dawn / dusk, warm = low sun, pale = high sun), with amber dots at keys with their own sun. Rebuilt with the timeline (96 samples), never per frame. | `BuildPathSunStrip`, `SunStripColour`, `BuildPathScrubber` |
| **Sun dates the short way round** | Tours and paths: the date moves the short way round the year (20 Dec → 10 Jan goes through New Year, not back through the year); the clock time moves straight; daylight saving switches at halfway. | Core `SunBlend.Between` (`SunModels.cs`); `BlendTourSun`, `SunForKey` |

### Files
- Core: `Format/SunModels.cs` (+`SunBlend`), `Format/BookmarkModels.cs` (`TourSettings.Smooth`, `SmoothSpeed`,
  `MIN/MAX_SMOOTH_SPEED`), `Format/CameraPathModels.cs` (`CameraKey.Swivel / Section / Visibility`, `CameraPath.FollowBetween`),
  `Format/VisibilityModels.cs` (`Copy`), `Scene/CameraPathTimeline.cs` (swivel, follow between).
- App: `GameSession.Tour.cs`, `GameSession.Paths.cs`, `GameSession.PathEditor.cs`, `GameSession.Photo.cs`, `PathStore.cs`,
  new `GameSession.KeyPhotos.cs`.

### Files on disk (all additive)
- `paths.json`: optional per key `swivel` (degrees), `section`, `visibility`; per path `followBetween` (left out when off).
- `bookmarks.json` → `tour`: `smooth` (left out when off), `smoothSpeed`.

### Tests (+5)
`CameraPathTests.Swivel_PansOverTheHoldAndLeavesFromThere`, `FollowBetween_FollowsInTheMiddleOfLongSegments`,
`KeyState_SwivelCutAndHiddenItemsRoundTrip`; `TourTests.TourSettings_SmoothIsAFieldOlderBuildsCanIgnore`,
`SunBlend_TheDateGoesTheShortWayRound`.

### README
§3 notes (K-C line), §4 (+KeyPhotos), §5 new bullet, §6 `paths.json` and `tour` fields, §8 (K-C's to-verify; K-B folded
in; camera paths limitation updated; roadmap: Round W next), §9 row.

## How to check it
1. **Build** and run the Core tests (all should pass, incl. K-B's `ControlsTests`).
2. **Smooth tour:** with 3+ bookmarks, MEDIA → TOUR → *Smooth*; set the speed. The length updates. PLAY TOUR (BOOKMARKS):
   the camera glides on a curve, stops at each bookmark facing its view, swivels, then follows the path out and turns into
   the next view. Space / ← → / Esc work; at the end you're back where you were. Switch back to Fade: as before.
3. **Video of it:** MEDIA → VIDEO → Bookmark tour → RECORD: the MP4 plays the smooth tour.
4. **Convert:** MEDIA → TOUR → CONVERT TO PATH: PATHS opens on "<model> tour" with one key per ticked stop; key rows show
   hold, own view, swivel, sun, profile, "cut / hidden"; "Follow between key views" is ticked. PLAY PATH: same as the
   smooth tour. Convert again: "<model> tour 2".
5. **Key fields:** pick a key: Swivel ±15° (only with Own view and a hold), Cut, hidden → USE THE VIEW NOW (hide a category
   or set a section first), ×. PLAY PATH: the cut / hidden items switch at that key and carry on.
6. **Photo at a key:** PATHS → a key → PHOTO AT THIS KEY: photo mode at the key's view with its sun / profile / cut; take a
   photo; close (M / Esc): back where you were, state as before. In the 3D editor (Shift+K) select a key → PHOTO AT THIS
   KEY in the dock: closing photo mode returns to the editor with the key selected.
7. **Photos of all keys:** set PHOTO to Still 2× PNG (then try 360° 4K); PATHS → PHOTOS OF ALL KEYS: the bar counts the
   keys; Esc stops early. The folder `Pictures\BimGo\<model> <path> <time>` holds `01 Key 1.png`, `02 …`; MEDIA → PHOTO →
   OPEN FOLDER (photo mode) selects the last one.
8. **Editor preview:** give two keys different suns (dock: Sun → USE THE SUN NOW, ±30 MIN) and one a colour profile. Drag
   the scrubber: the sun moves and the profile switches; the strip under the track shows the sun's height with dots at the
   keyed suns. Space: the fades show at the start and end. Fly off (WASD) or ← / →: the walkthrough's sun and profile return.
   DONE: same.
9. **Short way round:** keys (or bookmarks) on 20 Dec and 10 Jan: playing between them, the date passes through New Year.

## Not in
- Key FOV (a key photo uses the PHOTO field of view).
- The editor's ← / → snap shows the walkthrough's state, not the key's (the scrubber / preview show the key's).
- The sun blend's clock time doesn't wrap through midnight (22:00 → 02:00 runs back through the day).
- A single ticked stop plays as a fade even with Smooth.

## Things to look at when building
- `CameraPathPoint` gained an optional last parameter `swivel`; `CameraPathSettings` an optional `followBetween`.
- `SaveWalkthroughForTour` now = close a key photo + `EndPathEditState` + `RememberWalkthrough`; `StopTour` uses the new
  `RestoreWalkthroughState`; `EndTourSunBlend` also runs for the editor's state (`_pathEditState`).
- `DayOfYear` left `GameSession.Tour` (now `SunBlend.DayOfYear` in Core).
- `GameSession.KeyPhotos` has a nested `KeyPhotoBatch` with a field named `Path` (a `CameraPath`); `Path.Combine` inside
  `GameSession` methods still means `System.IO.Path`.
- `Interlocked` / `Volatile` (System.Threading, implicit usings).
