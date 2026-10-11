# Tour round, build A2: walkthrough video + location override (agreed with Gavin, 2026-10-11)

**Baseline:** build A1 zip as handed over (Gavin: no changes).

## Video (decided at the start of Round A)
- 1080p (default) / 4K / window size; 30 (default) / 60 fps; bitrate from the size.
- `Videos\BimGo` with OPEN FOLDER; progress bar + time left + CANCEL (a cancelled file is deleted).
- Live preview while recording; fixed-step clock, off-screen `RenderScene(..., photo: true)`; the fade drawn into
  the frame; UI-on tours draw the HUD at the video's height.
- Windows Media Foundation (in-box H.264), no package, no bundled codec.

## Location override (slipped into A2)
- **Search source:** bundled offline list: Natural Earth populated places (public domain), plus typed / pasted
  "lat, long". No network.
- **Storage:** with the model (sun.json in the .bimgo or the live model folder). RESET returns to Revit's location.
  Never written back to Revit. True north stays the model's.
- **Time zone / DST:** automatic from the place's IANA zone (Windows converts it); the manual DST tick stays as an
  override.
- **Credit (Gavin):** say how the city list was made in THIRD-PARTY-NOTICES (not the places), check its licence
  (public domain, attribution unnecessary; credited anyway), and add anything used that needs attribution.
