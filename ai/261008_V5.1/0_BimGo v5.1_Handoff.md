# BimGo — Handoff Brief v5.1 (for a new chat)

**Purpose of the next chat:** confirm v5 + v5.1 compile and pass their checklists, then start the **sun / shadows / time-of-day** round. Both v5 and v5.1 were written without a compiler.

**Read first:**
1. This brief.
2. `README.md` (controls, `.bimgo` format, live protocol, known limitations, changelog).
3. `ai/261008_V5.1/1_build notes v5.1.md` and `ai/261007_V5/1_build notes v5.md` (decisions, "To verify", test checklists).
4. **Ask Gavin for a fresh zip of his working copy before editing.** He builds and fixes in Visual Studio; his copy is the source of truth.

---

## 1. Where BimGo is now

- Solution `src/BimGo.sln`: **BimGo.Core** (net8.0), **BimGo.App** (net8.0-windows, `BimGo.exe`), **BimGo.Revit** (R25/R26 net8, R27 net10).
- v4 built and worked. v5 (push to Revit, existing/new phases, file association, comments QoL, snap defaults) and v5.1 (below) are **not yet compiled**.
- v5.1: `NotApplicable` removed from `PhaseResolver`; **Redo** (Ctrl+Y / Ctrl+Shift+Z, file mode); **viewpoint bookmarks** (B, Ctrl+1–9, pause-menu list, stored in `.bimgo` `bookmarks.json` or a `<model>.bimgo-bookmarks.json` sidecar live); **coordinate readout** (L: shared / project / internal, double precision; extraction now captures the internal → shared transform in `model.site`).

## 2. Agreed order (Gavin, 2026-10-05)

| Round | Scope |
|---|---|
| v5.1 | Build fixes, redo, bookmarks, coordinate readout (done, to build) |
| **Next** | **Sun + shadows + time-of-day slider**, as its own round (UI/UX and performance) |
| Then | Linked models (each link a sub-model: own transform and id namespace; format + picking changes) |
| Then | Revisit guns (Gavin undecided on more guns / gun-bar rethink) |
| Later | Incremental refresh, flattened save, named pipes, tests (NuGet → ask), push follow-ups, signing / installer |

## 3. Notes for the sun / shadow round

- Site data already captured: `SiteInfo.TrueNorthAngle`, survey / base points, and (v5.1) `SharedAngle`. Gavin has a `GetRevitSunVector` method (True North applied): ask for it.
- Questions to settle with Gavin first: sun from the model's Revit sun settings vs. location + date/time in the app; slider UI (time of day, day of year), where it lives (pause menu card vs. HUD key); shadow quality presets (off / low / high) vs. performance on big models; whether the time is saved per file / bookmark.
- Renderer facts: OpenGL 4.1 core (3.3 fallback), GLSL 330, forward rendering into an optionally multisampled target, static batches + dynamic instances, transparent pass after opaque, fog. A shadow-map pass would need depth-only draws of static batches and dynamic instances from the sun (cascades likely for interiors + site).

## 4. Conventions (unchanged)

- Readable, robust code, XML doc headers, explicit types where clearer; no LINQ / allocations in per-frame paths (`TextBuffer`, cached strings).
- No NuGet packages without asking; ask before reorganising folders.
- No exceptions to the user: log via `Utilities.Log_Utils.Write`, show a toast/dialog.
- Revit API only in `Commands/`, `Extraction/`, `Bridge/RevitEditor*.cs`, `Live/LiveDispatcher.cs`.
- Qualify clashing names. Format and protocol stay backward compatible (additive fields; `formatVersion` 1, protocol 1).
- Revit API: `ElementOnPhaseStatus` has no `NotApplicable` (use `None`).
- Keep `README.md` and an `ai/<date>_V<n>/` notes file current; zip the repo minus `bin/`, `obj/`, `.vs/`.
- Font atlas: Latin-1 plus `EXTRA` in `UiFont.cs` (v5.1 added `≈`; arrows ↑ ↓ ← → were already there).
- Keys in use: WASD/arrows, Space, Shift, Ctrl, V, 1–8, wheel, Q/E (gizmo), N, T, E, R, G, Z/X/C (gizmo), H, X, B, L, Tab, F1, F5, F11, PgUp/PgDn, Ctrl+S/Z/Y/1–9. Free letters: F, I, J, K, M, O, P, U, Y (unmodified).
