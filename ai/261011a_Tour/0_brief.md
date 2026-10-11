# Tour round (Round A): brief (agreed with Gavin, 2026-10-11)

**Baseline:** photo mode zip (`BimGo_PhotoMode.zip`, Gavin: all working). Handoff: `ai/261010d_Handoff`.

**Round split (Gavin):** A · B1 · B2, then C (clash detection, own handoff).
- **A (presentation):** A1 bookmark tour + eye-height presets; A2 walkthrough video (Media Foundation H.264 MP4).
- **B1:** measure extras, snapshot markup, metric / imperial units, start screen thumbnails (the start screen
  itself already exists: `Shell/HomeScreen.cs`).
- **B2:** action map, key rebinding, gamepad (XInput) → feeds the hotkey review.

## Decisions for A1
- **Visibility per bookmark:** new optional field (hidden categories / links / elements). Older bookmarks leave
  visibility alone.
- **Hold and swivel:** tour-wide settings, each bookmark may override (saved on the bookmark); a bookmark can be
  left out of the tour.
- **Swivel:** a slow pan one way (default 30°, left / right), eased in and out over the stop.
- **Transition:** fade (default, 0.6 s each way, editable 0–2 s) or glide.
- **Access:** pause menu only, no new keys (keys are assigned in the hotkey review). BOOKMARKS → PLAY TOUR /
  TOUR SETTINGS. While playing: Space pause, ← / → previous / next, Esc stop.
- **Eye heights:** Standing 1.62 · Seated 1.20 · Child 1.10 m, the body scales with the eye (collision and headroom
  follow), step-up unchanged, editable in Options → Player (and in the pause menu). Selector in the pause menu.
- **Bookmarks keep the eye height** (Claude's call, Gavin may overrule): a stop saved seated replays seated.
- **The tour restores** the player, sun, cut, visibility and eye height when it ends.

## Decisions for A2 (next build)
- 1080p (default) / 4K / window size; 30 (default) / 60 fps; bitrate from the size.
- Output `Videos\BimGo` with OPEN FOLDER; progress bar + time left + CANCEL (a cancelled file is deleted).
- Live preview while recording (frames as they render); fixed-step clock, off-screen `RenderScene(..., photo: true)`;
  the fade drawn into the frame; UI-on tours draw the HUD scaled to the video height.
