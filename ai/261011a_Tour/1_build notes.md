# Tour round, build A1: build notes

**Baseline:** photo mode zip. **Not compiled here** (no .NET SDK in the sandbox). Brackets checked; partials scanned
for duplicate members (none new). The `TourTimeline` maths was ported to Python and checked against the test
expectations. Please build and run the Core tests (new `TourTests`: 12).

## Core
- `Format/BookmarkModels.cs`: `BookmarkRecord` gains `Visibility`, `EyeHeight`, `TourHold`, `TourSwivel` (degrees,
  + left), `TourSkip`; `BookmarkDocument.Tour`; `Clean()` clamps the new fields (visibility without ground / section).
  New `TourSettings` (transition, hold, fade, glide, swivel on / degrees / direction, show UI, loop; `HoldFor`,
  `SwivelFor`, `Clean`, `Copy`), enums `TourTransition`, `TourSwivelDirection`.
- `Scene/TourTimeline.cs`: `TourStop`, `TourPose`, `TourTimeline` (layout, `Duration`, `StartOf`, `StopAt`,
  `Evaluate`, `Smooth`, `LerpAngle`). Glides take ≥ the set time and ≤ 4 m/s (≤ 30 s).
- `Scene/LaunchSettings.cs`: `EyePreset` enum, `EyePreset` / `EyeHeightStanding` / `EyeHeightSeated` /
  `EyeHeightChild` (+ defaults, limits 0.9–2.0 m, `EyeHeightFor`, `SetEyeHeight`, sanitised).

## App
- `Physics/CharacterController.cs`: instance `StandEye`, `StandHeight`, `CrouchEye`, `CrouchHeight`;
  `SetStandingEye(eye, force)` (refuses a taller capsule that would overlap unless forced). Crouch uses them.
- `Game/Player.cs`: the eye smoothing targets the controller's eye heights.
- `Game/GameSession.EyeHeight.cs` (new): presets from / to settings, `SelectEyePreset`, `ApplyEyeHeight` (bookmarks),
  `AdjustEyePreset` (− / +), `ModeLabel` (status panel), `BuildEyeHeightRow` (pause menu right column).
- `Game/GameSession.Tour.cs` (new): start / stop (saves and restores player, sun, cut, visibility, isolation, eye,
  UI), `UpdateTour` (keys, clock, loop), `SeekTourStop`, `EvaluateTour` / `ApplyTourStop` (quiet sun / cut /
  visibility setters, reference checks so a state is applied once), overlay (HUD subset, fade, key hint, tour bar),
  settings view (draft saved on release; per-bookmark table), `TourLength` (no allocation).
- `GameSession.cs`: tour branch first in `UpdateFrame`; `FixedUpdate` skips while touring; `UpdateCamera` takes the
  tour pose; `UpdateGuns` skips; the tour stops before the save prompt on close and in `Dispose`; eye settings read /
  written.
- `GameSession.Render.cs`: tour overlay branch; no highlights while touring; MODE label; help row.
- `GameSession.Visibility.cs`: `ApplyHiddenLists`, `ApplyVisibility(settings, record)`, `BookmarkVisibility()`
  (`InitialiseVisibility` uses the first).
- `GameSession.Bookmarks.cs` / `BookmarkStore.cs`: new fields saved on B / ADD THIS VIEW / SET HERE; GO applies
  visibility and eye height; `Tour`, `SetTour`, `SetTourOverrides`; the detail line shows EYE and NOT IN TOUR; panel
  buttons ADD THIS VIEW · TOUR SETTINGS / BACK TO LIST · CLOSE · PLAY TOUR.
- `GameSession.Menu.cs`: eye height row between the quality profile and the tabs.

## Revit
- `Forms/OptionsWindow.xaml(.cs)`: Player tab row *Eye heights* (standing / seated / child, metres, validated).

## To verify
See README §8 (Tour, build A1).
