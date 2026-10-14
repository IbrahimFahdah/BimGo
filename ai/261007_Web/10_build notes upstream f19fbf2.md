# BimGo Web — build notes, upstream sync to `f19fbf2`

**Ported from:** upstream `develop` @ `f19fbf2` (was `24c57c4`). Two upstream rounds: **input B2** (the action map, CONTROLS,
gamepad, gun wheel, unarmed) and **clash detection C** (C-A … C-B4: search sets with operators and rule groups, the
engine, merged results in `clashes.json`, reports, the CLASHES panel, docked clash mode, row pictures, comments from
clashes, multi-select, SHOW IN REVIT, BCF "Clash" topics). Merged as `61f46e7`; this note covers the browser port and
the one add-in change it needs.

## What was ported

| Upstream round | Web files | Notes |
|---|---|---|
| Action map (B2-A) | `core/scene/KeyChord.ts`, `InputCatalog.ts`, `KeyMap.ts` (new), `platform/Hotkeys.ts` (new), `platform/input.ts` | Same action names, contexts, situations and defaults as `InputCatalog.cs`, except Screenshot (**Shift+F12**: F12 is the browser's dev tools). Every key in the viewer now goes through an action, so CONTROLS rebinds it. Up to 3 key slots + 1 gamepad slot per action |
| CONTROLS panel | `game/ControlsPanel.ts`, `game/Overlays.ts` (new: dropdowns, confirms, two-choice confirms), `game/Hints.ts` | Search, capture (keys, mouse buttons incl. MMB / X1 / X2, wheel), clash → SWAP / CANCEL, right-click clears, RESET / RESET ALL, EXPORT / IMPORT a keymap (download / file pick). Browser refusals: F12, Ctrl+W / T / N / R / C / V / X, Ctrl+Tab / PgUp / PgDn |
| Gamepad, gun wheel, unarmed (B2-B) | `core/scene/GenericPadMap.ts`, `platform/gamepad.ts` (new), `game/GunWheel.ts` (new), `Player`, `GameSession` | The browser Gamepad API in place of XInput: standard-mapping pads work as Xbox ones; other pads go through MAP BUTTONS (hat-switch axes detected). The pad cursor is drawn by the page. Gun bar and F1 help off by default ("F1: Help" note), bookmarks on Shift+1–9, the wheel cycles gun modes, Shift+wheel switches guns |
| Clash Core (C-A) | `core/clashes/ClashModels.ts`, `SearchSets.ts`, `ClashGeometry.ts`, `ClashEngine.ts`, `ClashMerge.ts`, `ClashFiles.ts`, `ClashFraming.ts` (all new) | Same file format (`clashes.json`, report `bimgo-clash-report`), same merge rules and statuses. The engine is async: it yields to the page every ~24 ms so the progress screen draws and Esc / CANCEL work (no worker: the scene stays on the main thread) |
| CLASHES panel (C-B) | `game/clashes/ClashPanel.ts` (new) | TESTS (tick for RUN ALL, kind, set A / B dropdowns, tolerance steps, RUN / REVIEW / RESET / DUPLICATE / DELETE) and SETS (any / all, rule rows with field and operator dropdowns, value picker with ticks for the list operators, typed values, rule groups). Re-run and reset confirms. EXPORT REPORT downloads; IMPORT REPORT picks a file |
| Clash mode (C-B … C-B4) | `game/clashes/Clashes.ts` (new), `GameSession` | Y or the pause menu. The dock (test / status / level dropdowns, search, VIEW / BOX / PICTURES, SELECT ALL, rows, the card with 1–5, ASSIGN / NOTES, TO COMMENT / MARKUP, REVIT / TESTS… / FLY / EXIT), flights, Ctrl / Shift / Ctrl+A selection (box off above 200, Revit asks above 500, amber "both" elements), markers |
| Clash views | `engine/render/SceneRenderer.ts`, `engine/gl/Shaders.ts` | Ghost: a `uGhost` uniform turns the scene shader into flat grey glass. Wireframe: WebGL2 has no `glPolygonMode`, so the static batches get an edge index buffer (built the first time wireframe is used; hidden elements become zero-length lines); moved elements draw ghosted in that view. Real model and hidden as upstream |
| Pictures and comments (C-B2, C-B3) | `Clashes.ts`, `PhotoTarget`, `Stores.ts` (`removeMany`), `DocumentModels` / `BimGoWriter` (`clashId`), `Bcf.ts`, `CommentsBcf.ts`, `Menus.ts` | Row pictures render at 320 × 180 and are box-filtered to 160 × 90 (≤ 2 per frame, 40 ms budget, 300 cached). TO COMMENT / N TO COMMENTS at 1280 × 720 with UPDATE THEM / NEW ONLY and the markup tick. Comments: TYPE filter (All / Issues / Clashes), ticks, SELECT ALL SHOWN, CLEAR, DELETE SELECTED (confirm; clash links dropped), "· CLASH" in the header. BCF exports clash comments as `Clash` topics with both elements as components |
| Live clashes | `core/live/LiveProtocol.ts`, `core/sources/LiveSessionSource.ts`, `shell/AppShell.ts`; C# `BimGo.Core/Live/LiveProtocol.cs`, `LiveSidecars.cs` | A new `clashes` sidecar kind: the add-in reads / writes `clashes.json` beside the model with the desktop's `ClashFiles` (parsed and cleaned before writing). SHOW IN REVIT sends the same `select` request as the desktop (`ClashView` + `Hosts` / linked ids); the add-in already handles it. An older add-in answers "unknown sidecar": the viewer then says once that clash results need a newer add-in or a saved `.bimgo` |

## Browser differences
- **Runs on the main thread** in time slices behind the progress screen (the desktop runs on a worker). A test over the
  sample (48 elements against themselves, 62 candidate pairs) takes ~0.8 s on SwiftShader.
- **Wireframe** is drawn from an edge buffer (twice the static index memory, only once wireframe is first picked).
- **Reports** go to Downloads; IMPORT REPORT and keymap IMPORT pick a file.
- **Pictures** are read back synchronously (like photo mode): fine on a GPU, slow on software GL.
- Screenshot is Shift+F12, and the keys the browser keeps for itself can't be bound (CONTROLS says so).

## Checks
- `npm test`: 210 tests (new `controls.test.ts` 21: catalogue / keymap / chords / refusals / overrides round trip;
  `clashes.test.ts` 27: models, rules and operators, groups, geometry (crossing, touching, gaps, containment), the
  engine on boxes, merge (new → active, resolved, reopened, truncated runs), files and reports, framing). `npm run lint`,
  both type-checks, `npm run build`.
- C#: `BimGo.Core` builds; Core tests (`dotnet run` in `tests/BimGo.Core.Tests`) 322 / 322 pass.
- Headless Chrome (SwiftShader) on the sample through `window.__bimgo`: clash detection switched on (starter tests
  seeded), an "everything × itself" test RUN → 4 clashes, the CLASHES panel after the run, clash mode with the flight,
  ghost / wireframe / real / hidden, row pictures, SELECT ALL (4 together) and back, TO COMMENT (comment with picture,
  linked both ways), status → comment status, `clashes.json` round trip with the comment link, the pause menu's
  CLASHES (4) and the comments panel's Clashes filter. No console errors.

## Not verified here
- SHOW IN REVIT and the `clashes` sidecar against a real Revit (the add-in compiled; not installed this round).
- Real gamepads (standard and generic) — the mapping was checked with synthetic `Gamepad` objects only.
- Large models: clash runs of thousands of elements, row pictures on a real GPU.
