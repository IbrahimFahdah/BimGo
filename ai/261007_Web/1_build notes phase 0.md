# BimGo Web — build notes, Phase 0 (scaffold)

**Ported from:** upstream `develop` @ `82d901e` ("Textures").
**Branch:** `web` (fork: IbrahimFahdah/BimGo).

## What was built

- `web/`: Vite + TypeScript (strict) + ESLint + Vitest. `npm run dev | build | lint | test`.
- `.github/workflows/pages.yml`: on push to `web` (paths `web/**`), lint → test → build → deploy to GitHub Pages. The site base is `/<repo>/`.
- Ports (same names and shapes as the C#, so diffs against upstream stay readable):

| Desktop | Web |
|---|---|
| `Native/Gl.cs` | `engine/gl/Gl.ts`: context creation plus optional extensions (`EXT_color_buffer_float`, `OES_texture_float_linear`, anisotropy). Ported code calls `gl.xxx` directly. |
| `Rendering/ShaderProgram.cs` | `engine/gl/ShaderProgram.ts` |
| `Rendering/Shaders.cs` (UI only) | `engine/gl/Shaders.ts`: GLSL ES 3.00 header + identical bodies |
| `Game/UiTheme.cs`, `Rgba` | `engine/ui/UiTheme.ts`, `engine/ui/Rgba.ts` (same packing: R in the low byte) |
| `Rendering/UiFont.cs` (GDI+) | `engine/ui/UiFont.ts`: 2D-canvas atlas, same sizes, packer, white block and Latin-1 + extra glyph set |
| `Rendering/UiBatch.cs` | `engine/ui/UiBatch.ts`: same 20-byte vertex, shapes, text, wrap, `image` |
| `Rendering/TextBuffer.cs` | `engine/ui/TextBuffer.ts`: same number rules (true minus, "—", N0) |
| `Platform/InputState.cs` | `platform/input.ts`: Win32 VK codes mapped from `KeyboardEvent.code`; same pressed / repeated / click edges |
| `Platform/GameWindow.cs` | `platform/window.ts`: canvas in device pixels, Pointer Lock, drag & drop |
| `Platform/FileDialogs.cs` | `platform/files.ts`: `showOpenFilePicker` (keeps a handle for Save in place), `<input type=file>` elsewhere |
| `Shell/HomeScreen.cs`, `Shell/AppShell.cs`, `Shell/RecentFiles.cs` | `shell/…`: same layout and copy; requestAnimationFrame instead of a message loop |

## Decisions and differences

- **Rounding:** .NET `MathF.Round` rounds half to even, but JS `Math.round` doesn't. `roundEven` keeps text on the same pixels as the desktop.
- **Fonts:** CSS stacks `Bahnschrift, 'Segoe UI', system-ui, sans-serif` and `Consolas, 'Courier New', ui-monospace, monospace`, with weights 400 / 600 / 700 in place of the "SemiBold" family names. On Windows this matches the desktop. The OFL fallbacks for macOS / Linux are still an open decision.
- **Atlas cells:** the canvas reports a smaller ascent than GDI+ for accented capitals, so their ink bled into the row above as faint dots under text. Cells are now padded to the measured ink (`overTop` / `overBottom`), and layout still uses the font-box line height.
- **Home screen:**
  - No QUIT button, because a page can't close itself.
  - No live-session list, because the browser can't scan the session folder. Sessions come from Revit's Go (Phase 5).
  - Recent files are a name list in `localStorage`. A click asks for the file again. IndexedDB handles on Chrome / Edge come later.
- **Opening a file:** Phase 0 only checks the extension and remembers the file. Reading starts in Phase 1.
- **Keys:** `blocksBrowserDefault` stops the browser's default for F1–F11, Tab, Space, Backspace, arrows, Page / Home / End, Alt, Ctrl+S / Ctrl+O and Alt+1–9. F12 is left alone.
- **Tooling:** TypeScript is pinned to 6.0.3 because typescript-eslint 8.71 doesn't support TS 7 yet. `vite.config.ts` is not in the browser type-check, so no `@types/node` is needed.

## Dependencies (for Gavin's dependency table)

All are dev / build only. None ship to the browser, and nothing is added to BimGo.App or BimGo.Revit.

| Package | Version | Licence | Use |
|---|---|---|---|
| vite | 8.3.3 | MIT | Dev server and static build |
| typescript | 6.0.3 | Apache-2.0 | Type-checking |
| vitest | 5.0.3 | MIT | Tests |
| eslint, @eslint/js | 10.12.0, 10.0.1 | MIT | Lint |
| typescript-eslint | 8.71.1 | MIT | Lint rules for TS |
| globals | 17.13.0 | MIT | Lint browser globals |

gl-matrix and fflate (runtime, MIT) arrive in Phase 1.

## Verified

- `npm run lint`, `npm test` (13 tests), `npm run build`: clean. The bundle is 25.5 kB (10.3 kB gzip).
- Headless Chrome (SwiftShader WebGL2), 1280 × 800 at 1× and 2×: the home screen draws in the BimGo look with sharp text at both scales.

## Not verified yet

- A real (non-headless) browser on a GPU, Firefox and Safari.
- The file picker and drag & drop by hand.
- The Pages deployment. GitHub Pages must be set to "GitHub Actions", and the `github-pages` environment must allow the `web` branch.
