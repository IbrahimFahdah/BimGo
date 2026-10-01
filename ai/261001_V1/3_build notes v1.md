# RvtGo — Build Notes (v1, 2026-10-01)

First full pass of the spec delivered as `RvtGo.zip` (template fork, all 9 build stages). Written without a compiler in the sandbox (no NuGet/.NET SDK access), so expect a first round of build fixes in Visual Studio.

## Decisions taken during the build
- R27 stays on `net10.0-windows` per the template (spec said .NET 8 for all); R25/R26 on `net8.0-windows`.
- GL: 4.1 core requested, 3.3 core fallback; GLSL 330. Scene renders to an off-screen FBO so MSAA can be toggled in session.
- Built-in categories are stored as strings and resolved with `Enum.TryParse` so missing categories in a Revit version are skipped instead of breaking the build.
- Scene origin = rounded median of element centres (float precision on large sites). Comments are stored in metres in Revit internal coordinates.
- Doors (revised by Gavin): no open/close system. Doors render exactly as modelled and are always no-clip (excluded from collision); still scannable and toggleable.
- Component stairs with runs are skipped in favour of runs/landings/supports (avoids duplicates).
- Excluded: view-specific elements, secondary design options, demolished elements, linked models.
- Orthographic 3D views → random spawn (only perspective eyes are used).
- Minimap is a real plan render (cut 1.2 m above level; back faces drawn as poché).
- Comment gun X = press twice to delete all comments (safety).
- In-session display settings (colour, MSAA, FOV, sensitivity, VSync, invert Y, show FPS) are saved back to settings on exit.
- GlobalUsings: `global using System.IO;` and `global using ElementRecord = RvtGo.Scene.ElementRecord;` (disambiguation).

## To verify first in Revit
1. Build errors (namespace clashes WPF/WinForms/Revit, any API signature drift on 2026/2027).
2. `Mesh.DistributionOfNormals` / `GetNormal`, `Element.DemolishedPhaseId`, `Document.IsModelInCloud`, `Level.ProjectElevation`.
3. Railing top/hand rails doubled or not.
4. Feel: walk/run speeds (3.2 / 6.5 m/s), jump, step-up 200 mm, mouse sensitivity scale.

Logs: `%LocalAppData%\RvtGo\RvtGo.log`. Settings: `%AppData%\RvtGo\settings.json`.

## Changelog
- 2026-10-01: v1 delivered.
- 2026-10-01: Door open/close system removed (doors static + no-clip); global usings updated.