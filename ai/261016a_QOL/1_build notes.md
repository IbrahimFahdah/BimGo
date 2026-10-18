# QOL round build notes

Not compiled here (no .NET SDK reachable). Brackets / parentheses checked by script; new UI strings checked against
the font atlas (Latin-1 + `UiFont.EXTRA`); test expectations worked through by hand.

## Files
- **Core** `Scene/MaterialOverrides.cs` (new): keyword parse / clean / format, `IsWaterAsset`, `IsSeeThrough` (flag, or
  older files: glass reflectivity / name-rule water), `IsWater`, `Look` (water, shine, roughness, bump), `ApplyWater`.
- `Scene/LaunchSettings.cs`: `WaterFromAsset` (true), `WaterKeywords` ("water"), `WaterKeywordsOpaque`, `GlassKeywords`; sanitised.
- `Scene/MaterialData.cs`: `SceneMaterial.SeeThrough` (written only when true).
- `Clashes/ClashSetupFiles.cs` (new): `ClashSetupFile` (`bimgo-clash-tests` / `bimgo-clash-sets`, links table),
  `Build` / `Export` / `Parse` (refuses the other kind and clash reports with a pointer) / `Read`, `Plan` (taken names;
  missing links by UniqueId / name / label, auto-matched by the exported name; missing levels), `Apply` (sets: add /
  replace keeping the id / keep both "(2)" / skip; tests: sets matched by id then name else added, tests likewise,
  replace keeps the id and clears `LastRunModel`), `Reconcile` (replace or drop values), `UniqueName`.
- **Revit** `Extraction/ReflectivityReader.cs`: `Configure(settings)`; Water schema gated by `WaterFromAsset`; name rule
  uses the keyword list (opaque too when ticked); `IsGlassByName` (never mirrors) makes `IsSeeThrough` true.
- `Extraction/SceneExtractor.cs`: `Configure` in the constructor; an opaque glass-keyword material gets alpha 115 (≈ 55 %).
- `Extraction/SceneExtractor.Materials.cs`: `SeeThrough` written.
- `Forms/OptionsWindow.xaml(.cs)`: Materials tab → WATER & GLASS OVERRIDES card (asset tick, water keywords, opaque
  tick, glass keywords, greyed grass).
- **App** `Rendering/MaterialTextures.cs`: water rule properties; the table uses `MaterialOverrides.Look`; `RefreshTable`
  re-uploads only the table (inputs kept from the last `Initialise`). `SceneRenderer.SetWaterOverride`, `WaterMaterialCount`.
- `Game/GameSession.Appearance.cs` (new): overrides state (read / write settings), Appearance tab, `KeywordRow`,
  `PlaceholderRow`, options preview (`_menuPreview`, `BuildMenuPreview`, `CloseMenuPreview`).
- `GameSession.Menu.cs`: tabs DISPLAY / REFLECTIONS / APPEARANCE; `BuildProfileRow` split out; PREVIEW button; preview
  branch before the backdrop; slimmer left stacks; `MenuButton(compact:)` (body font).
- `GameSession.cs`: reads / writes the overrides; water rule before the renderer's `Initialise`; Esc closes the preview
  first; `SetPaused` clears it.
- `GameSession.GunWheel.cs`, `GameSession.Render.cs`, `Core/Scene/InputCatalog.cs`, README §3: Unarmed → None.
- `Game/Clashes/GameSession.ClashSetup.cs` (new): EXPORT / IMPORT TESTS… / SETS…, the reconcile card (name choice,
  one dropdown per missing value, wheel scroll), `FinishClashImport`, `CancelClashImport`.
- `GameSession.ClashPanel.cs`: footer buttons per tab; the card replaces the body and buttons while open (tabs locked);
  Esc cancels it.
- `GameSession.ClashDock.cs`: REPORT… dropdown beside SELECT ALL SHOWN (run after drawing: it opens a dialog).
- `GameSession.ClashMode.cs`: `ExitClashMode` switches the section box off when BOX is on.
- `GameSession.Sun.cs` (STUDY…), `GameSession.SunHours.cs` (SUN SETTINGS…).
- Tests: `MaterialOverrideTests` (5), `ClashSetupTests` (7).

## To verify (APIs / behaviour)
- Deconstruction into properties in `MaterialOverrides.ApplyWater` (C# allows it; check no warning-as-error).
- `MaterialTextures.RefreshTable` after a Textures panel rebuild (the stored inputs are replaced by each `Initialise`).
- Preview: the scene keeps rendering under the pause menu (it does today, behind the 94 % backdrop).
- Reflection probe placement still reads the extracted `Water` flag (keyword water may get no nearby probe).
