# Round K, build K-C: brief (2026-10-18)

Baseline: Gavin's zip `BimGo_Handoff_KC` ("zip is up to date"). K-B: Gavin happy; its test fix (no gamepad default for the
path editor) is in the zip; **confirming the Core tests pass closes K-B** (its README §8 entry is folded into K-C's).
Scope (handoff §2b): the tour as a path type (SMOOTH, CONVERT TO PATH), photo / video links (a key as a photo; a path or
tour as a video was already in the VIDEO tab), sun animation polish. Gavin: "hopefully C is an easy round, more excited for W".

## Answers (AskUserQuestion, 2026-10-18; all the recommended options)

| Question | Answer |
|---|---|
| SMOOTH tour | **A third option, swivel kept**: MEDIA → TOUR "Between stops: Fade · Glide · Smooth" + a speed slider. Each stop holds for its hold with its swivel; between stops the camera follows the path and turns into each bookmark's view near it. Stored as new optional fields (`smooth`, `smoothSpeed`), not a new enum value |
| CONVERT TO PATH | **Also the cut and hidden items**: keys = bookmark eyes and views, hold, swivel, sun, colour profile, plus new optional `Section` / `Visibility` on `CameraKey`; own view at each key, follow the path between; named "<model> tour"; opens in MEDIA → PATHS |
| A key as a photo | **Both**: PHOTO AT THIS KEY (dock + PATHS key editor: the key's view and state, photo mode) and PHOTOS OF ALL KEYS (one still / 360° per key with the PHOTO settings, into a folder) |
| Sun polish | **All four**: the editor's scrub / preview shows the sun, profile and fades (put back when you leave); a Sun row in the 3D dock; a sun strip on the scrubber; dates blend the short way round the year |

Decided while building (no question needed):
- The smooth tour and CONVERT share one builder (`TourAsPath`), so a converted path plays like the smooth tour.
- Key swivel is a new optional `CameraKey.Swivel` (degrees; own view + a hold); "follow between key views" is a new
  optional `CameraPath.FollowBetween` (a checkbox in the path strip; a converted tour has it on).
- A key's cut and hidden items carry on to later keys like its colour profile (null: leave as it is).
- The editor's preview also shows the path's cut and hidden items (they are key state now).
- The sun blend keeps the clock time moving straight (only the date goes the short way round): blending the date and
  time as one would spin the sun round once per day between far-apart dates.
- No new keys or gamepad defaults.
