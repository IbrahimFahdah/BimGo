# BimGo Web — build notes, Phase 2 (read-only tools and info)

**Ported from:** upstream `develop` @ `82d901e`.

## What was built

| Desktop | Web | Notes |
|---|---|---|
| `Guns/Gun.cs`, `GunIcons.cs` | `game/guns/Gun.ts`, `GunIcons.ts` | The tools talk to the session through a `GunHost` interface (the desktop passes `GameSession`). |
| `ScanGun`, `MeasureGun`, `PortalGun`, `CommentGun`, `TeleportGun` | `game/guns/*` | Tools 1–5, same behaviour, labels and panels. |
| `Rendering/Overlay3D.cs` | `engine/render/Overlay3D.ts` | World markers, plus a faint x-ray copy so markers behind walls stay visible. |
| `Audio/SoundSystem.cs` (waveOut) | `platform/audio.ts` (Web Audio) | Same recipes, rendered once into buffers. Noise comes from a seeded generator. The audio starts on the first click or key, because browsers keep it off until then. |
| `CommentStore`, `BookmarkStore` | `game/Stores.ts` | File mode: kept in the document and written by Save (Phase 4). CSV export is a download. |
| `GameSession` partials: Visibility, Coordinates, Bookmarks, Thumbnails, Screenshot, Render (highlights, overlay, tool bar, panels, flash) | `game/GameSession.ts` | |
| `SiteCoordinates` | `core/scene/SiteCoordinates.ts` | Shared, project and internal readouts (L). |
| `GameSession.Menu` / `.Comments` / `.Bookmarks` (menu, lists, widgets, text box) | `game/Menus.ts` | `PauseMenu`, `TextEditor` and `Widgets`. |

## Decisions and differences

- **Bookmark keys:** Alt+1–9 jumps to a bookmark (Ctrl+1–9 switches browser tabs). In fullscreen (F11) the page asks for Keyboard Lock (Chrome / Edge), so Ctrl+1–9 works there too.
- **Screenshot:** Shift+F12 downloads a PNG of the 3D view without the HUD, named `<model> yyyy-MM-dd HHmmss.png`. F12 stays DevTools.
- **Typing:** the comment and bookmark-name box releases the mouse while open, so Esc reaches the page and cancels. Clicking the view afterwards resumes mouse look.
- **Author name:** a new **Your name (comments)** setting in the pause menu, defaulting to "Web user". The browser has no Windows user name to take.
- **Pause menu:** the left column has RESUME, RETURN HOME, SET HOME HERE, COMMENTS, BOOKMARKS, SHOW ALL (when anything is hidden), CLEAR MARKERS and CLOSE MODEL. SAVE, SAVE AS and PUSH TO REVIT come with Phase 4 and 5, and TEXTURES with 3b.
- **World & Display card:** the ground plane, colour mode (Realistic shows material colours until Phase 3b and says so), FOV, mouse sensitivity, Invert Y, Show FPS and your name.
  - Left out: VSync (the browser always syncs), anti-aliasing, AO and reflections (Phase 3).
- **Ground-plane slider:** the value snaps to 5 cm only while dragging. The desktop snaps every frame, which moved the exact default as soon as the menu opened.
- **Bookmark thumbnails:** the 3D view is read right after drawing, centre-cropped to 16:9 and scaled by the canvas. It is stored as base64 JPEG, as on the desktop, and decoded asynchronously for the list ("…" until ready).
- **Comments, bookmarks, home and visibility** change in memory. Writing them into the `.bimgo` comes with Save in Phase 4. The UI says "kept in this file".

## Verified

- Lint, type-check and 30 tests pass. The build is 186 kB (64 kB gzip).
- Headless Chrome with Snowdon shows the tool bar with Measure selected, the hint row, the Measure panel, the shared-coordinates readout (E 417 630.428 / N 78 729.611 / ELEV 239.517 m), the minimap header and the new pause menu with the geometry and display cards.

## Needs a real browser (mouse capture)

- Every LMB / RMB tool action: scan lock, measure, portals and walking through them, comments, teleport.
- I / Shift+I hide and isolate, B with the name box, Alt+1–9, thumbnails, Shift+F12, CSV export.
- That the sounds play.
