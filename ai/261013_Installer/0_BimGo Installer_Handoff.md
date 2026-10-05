# BimGo — Handoff Brief: installers (for a new chat)

**Context:** BimGo is Gavin's personal project, developed on his own PC in his own time (not a work project). Installers, names, IDs and signing are personal, with no employer branding.

**Purpose of the next chat:** design and build the installers for **BimGo 1.0.0**: the standalone app (`BimGo.exe`) on its own, and BimGo for Revit (the add-in for Revit 2025 / 2026 / 2027, which needs the app). **No new features this round**: only the installer, the build / publish steps that feed it, and the small code changes the install layout forces (paths, self-registration, vendor fields).

**Read first:**
1. This brief.
2. `README.md` (§1 overview, §2 getting started, §4 project structure, §8 known limitations, §9 changelog).
3. `ai/261011_V8_1.0/1_build notes 1.0.md` (the latest round).
4. **Ask Gavin for a fresh zip of his working copy before editing** (he builds in Visual Studio; his copy is the source of truth).

---

## 1. Where BimGo is now

- 1.0.0 builds and runs on Revit 2025, 2026 and 2027 (Gavin, 2026-10-12), including the late additions (stair climbing, saved home, bookmark thumbnails, Esc cancels a new bookmark). Gavin is re-testing each Revit year from Visual Studio before installer work starts.
- Solution `src/BimGo.sln`:
  - **BimGo.Core**: net8.0 class library (no Revit, no UI).
  - **BimGo.App**: net8.0-windows WinExe `BimGo.exe`, x64, WinForms in-box only (System.Drawing). Framework-dependent today.
  - **BimGo.Revit**: `BimGo.Revit.dll`, x64, WPF + WinForms. Configurations `Debug|Release R25 / R26 / R27`: R25 and R26 target net8.0-windows, **R27 targets net10.0-windows**. References `RevitAPI` / `RevitAPIUI` from `C:\Program Files\Autodesk\Revit <year>\` (not copied).
- **No NuGet packages** anywhere (design rule: ask before adding any, including installer tooling).

## 2. How it deploys today (developer builds)

| Piece | Where it goes | Mechanism |
|---|---|---|
| App | `%LocalAppData%\Programs\BimGo\` (all output except .pdb) | `InstallBimGoApp` target in `BimGo.App.csproj` (after Build) |
| Add-in | `%AppData%\Autodesk\Revit\Addins\<year>\BimGo\` (dll + deps) and `…\<year>\BimGo.addin` | `CopyToRevitAddins` target in `BimGo.Revit.csproj` |
| `.addin` manifest | `src/BimGo.Revit/BimGo.addin`: `Assembly` = `BimGo/BimGo.Revit.dll` (relative), AddInId `C1A459F6-4B86-42DF-8CA9-C9E2042F1ABA`, FullClassName `BimGo.Application`, **VendorId "Author Name", VendorDescription "Author Description"** (placeholders) | copied by the target |
| Finding the app | `App_Utils.FindExe()`: `%LocalAppData%\Programs\BimGo\BimGo.exe`, else `BimGo.exe` beside the add-in dll | Revit side |
| File association | HKCU `Software\Classes\.bimgo` → `BimGo.Model` (icon from the exe, "Open in BimGo"), `Applications\BimGo.exe`, Start-menu shortcut | `FileAssociation.EnsureRegistered()` on every app start **from the install dir** (unless the user opted out); `BimGo.exe --register` / `--unregister` [`--quiet`] |
| Single instance | named mutex + inbox `%LocalAppData%\BimGo\App\inbox\` | `AppInstance` |

**User data (not installed, created at run time):**
- `%AppData%\BimGo\settings.json`: shared settings (also migrated once from `%AppData%\RvtGo\`).
- `%LocalAppData%\BimGo\`: logs (`Logs\BimGo.App.log`, `BimGo.Revit.log`), live sessions (`Sessions\<id>\`), app inbox, comments for unsaved / cloud models.
- Sidecars beside Revit models: `.bimgo-comments.json`, `-bookmarks.json`, `-sun.json`, `-visibility.json`.

Other placeholders to settle: `<Company>Author</Company>` in all three csproj files; `Program.Version` XML doc still says "3.00.00.01" (cosmetic).

## 3. Decisions to make with Gavin first (ask, don't assume)

1. **Installer technology.** Options: **WiX Toolset v5 / v6** (MSI + optional Burn bundle; .NET-friendly, MSBuild `.wixproj`, comes in as a NuGet-based SDK: needs Gavin's OK under the no-NuGet rule); **Inno Setup** (single `.iss` script and a standalone compiler; no NuGet; per-user installs are easy); **MSIX** (clean install / uninstall, but Revit add-ins and HKCU file associations are awkward from its container: not recommended). Recommend Inno Setup for a simple downloadable setup.exe (fits a personal project and the no-NuGet rule); WiX only if an MSI is wanted for managed deployment later.
2. **Per-user vs per-machine.**
   - Per-user (no admin): app in `%LocalAppData%\Programs\BimGo\`, add-ins in `%AppData%\Autodesk\Revit\Addins\<year>\`, HKCU association. **Matches today's code, so no path changes.**
   - Per-machine (admin, all users): app in `%ProgramFiles%\BimGo\`, add-ins in `%ProgramData%\Autodesk\Revit\Addins\<year>\`, association in HKLM or per user on first run. Needs `App_Utils.FindExe` / `FileAssociation.InstallDir` to find Program Files, and the app's self-registration to stay per user.
3. **One installer or two.** Recommendation: one installer with features: **BimGo app** (always) + **BimGo for Revit 2025 / 2026 / 2027** (each offered only if that Revit is installed: registry `HKLM\SOFTWARE\Autodesk\Revit\…` or `C:\Program Files\Autodesk\Revit <year>\Revit.exe`), plus a standalone-only build of the same installer (or the same file, unticking Revit). Gavin asked for "BimGo for Revit and standalone": confirm whether that means one installer with options or two separate downloads.
4. **.NET runtimes.**
   - App: framework-dependent needs the **.NET 8 Desktop Runtime x64**. Options are to publish it self-contained (bigger, no prerequisite, still no NuGet: runtime packs come with the SDK), or chain or check the runtime in the installer.
   - Add-in: runs in Revit's own runtime (2025 / 2026: .NET 8; 2027: .NET 10), so it needs nothing extra.
   - Recommend a **self-contained app** so standalone users without Revit need nothing else. Check `UseWindowsForms` publish trimming is off.
5. **Code signing.** Is there a personal code-signing certificate (or none for now, accepting the warnings)? If there is one, sign `BimGo.exe`, `BimGo.Core.dll`, `BimGo.Revit.dll` and the installer, otherwise SmartScreen warns and some Revit setups flag unsigned add-ins (Revit shows a "verified / unverified publisher" prompt for unsigned add-ins).
6. **Names and IDs.** Publisher / Company (Gavin's own name or a personal brand, e.g. "Aussie BIM Guru"), `.addin` VendorId (Gavin's own short ID, e.g. reverse-domain style) and VendorDescription; product name "BimGo"; installer UpgradeCode (new GUID, fixed forever); keep the AddInId.
7. **Upgrades and uninstall.**
   - Upgrades: in-place major upgrade (same UpgradeCode, newer version replaces older).
   - Uninstall removes the app, add-ins, `.addin` files, shortcuts and the association (run `BimGo.exe --unregister --quiet`, or remove the keys directly).
   - **Keep user data by default** (settings, logs, sessions, sidecars); optionally ask.
   - Close a running `BimGo.exe` (and warn if Revit is running: a loaded add-in dll is locked).
8. **Legacy cleanup.** Remove an old `RvtGo.addin` (+ `RvtGo\` folder) from each `Addins\<year>\` if present (README §2 step 4 asks users to do this by hand today).
9. **Self-registration vs installer.** Today the app registers `.bimgo` and makes its own Start-menu shortcut on every start from the install dir. With an installer, choose one owner: either the installer writes the association and shortcut and the app's `EnsureRegistered` becomes a quiet repair only (no duplicate shortcut), or the installer runs `BimGo.exe --register --quiet` and lets the app own it. Agree which, so uninstall cleans up exactly what was made.

## 4. Suggested plan

1. Agree the decisions above.
2. **Release publishing** (script or MSBuild target, e.g. `build/publish.ps1`):
   - `dotnet publish src/BimGo.App -c Release -r win-x64 [--self-contained]` → `artifacts/app/`
   - `dotnet build src/BimGo.Revit -c "Release R25|R26|R27"` → `artifacts/revit/2025|2026|2027/BimGo/` + `BimGo.addin`
   - Make the developer copy targets (`InstallBimGoApp`, `CopyToRevitAddins`) **Debug-only**, or switch them off with a property during release builds, so release builds don't touch the build machine's own installs.
   - Version stamped once (Directory.Build.props, or pass `-p:Version=`).
3. **Code adjustments the layout needs** (small, no features):
   - fill in Company / VendorId / VendorDescription;
   - if per-machine, teach `App_Utils.FindExe` and `FileAssociation.InstallDir` the Program Files location (keep the LocalAppData and beside-the-add-in fallbacks);
   - align self-registration with whichever owner was chosen;
   - an "installed by installer" marker if the app should skip its own shortcut.
4. **Installer project** (`installer/`), with the features, Revit detection, upgrade and uninstall rules above, the ">>" icon (`src/BimGo.App/Resources/BimGo.ico`), a licence page (`LICENSE` in the repo root) and an Add / Remove Programs entry with version and publisher.
5. **Signing** of the binaries before packaging and of the installer itself (signtool, timestamped).
6. **Test matrix:**
   - clean machine with no .NET (standalone only);
   - each Revit year installed alone and all three together;
   - upgrade from the dev-build layout and from a previous installer version;
   - uninstall leaves nothing behind except user data;
   - double-click `.bimgo` opens the app;
   - Go from each Revit year launches the installed app;
   - non-admin user (if per-user).
7. Update `README.md` §2 (users install via the installer; developers keep the VS flow) and record decisions in `ai/<date>_Installer/1_build notes installer.md`. Wiki / user-guide material comes after the installer.

## 5. Conventions (unchanged)

- Readable, robust code, XML doc headers, explicit types where clearer; no per-frame allocations.
- **No NuGet packages without asking** (this includes WiX's SDK packages); ask before reorganising folders (a new `installer/` and `build/` folder needs a yes).
- No exceptions to the user: log via `Utilities.Log_Utils.Write`, show a dialog / toast.
- Revit API only in `Commands/`, `Extraction/`, `Bridge/RevitEditor*.cs`, `Live/LiveDispatcher.cs`.
- Format and protocol stay backward compatible (`formatVersion` 1, protocol 1).
- Keep `README.md` and an `ai/<date>_<topic>/` notes file current; zip the repo minus `bin/`, `obj/`, `.vs/` (and any `artifacts/` output).
