# Polish round P, build P-C: leftovers and colour follow-ups (2026-10-18)

Built on `BimGo_Polish_PB` (Gavin's working copy). **Not compiled here** (no .NET SDK): build first, then the Core tests.

Checked by script:
- Brackets, strings (incl. interpolation holes) and char literals in every changed `.cs` file.
- New member names declared once across the `GameSession` partials (and no clash with existing ones).
- UI strings against the font atlas (Latin-1 + `UiFont.EXTRA`).
- Encodings kept (BOMs as they were, LF).
- The changed section-cap shader (`CAP_STENCIL_FS` with `SCENE_VS`) compiles and links in headless WebGL2.

No new keys: README §3 and `ControlsTests` are unchanged.

## In

### Leftovers

| Item | What it does | Where |
|---|---|---|
| **Nested rule groups** | Search-set rule groups nest to any depth. A group header has ANY OF / ALL OF, ADD RULE, **ADD GROUP** (a group inside) and ×; headers number like "GROUP 2.1"; indent shown to 4 levels. Each inner group is one more condition of its group. `RuleGroup.Groups` is now read and written (`clashes.json` additive, omitted when null); `HasConditions`, `AllRules`, `Normalise` (depth cap 16), `Copy` and `SearchSets.GroupMatches` are recursive. | Core `ClashModels.cs`, `SearchSets.cs`; App `GameSession.ClashPanel.cs` (lines rebuilt only when the structure changes) |
| **Groups in CLASHES** | TESTS: a test's row says "· N groups"; its editor lists the groups (name, members, status, MIXED); a click reviews the test with that group picked. | `GameSession.ClashPanel.cs` |
| **Grid location on rows** | Clash dock rows add the nearest grid intersection ("· C-4"); search finds it. | `GameSession.ClashDock.cs` |
| **Grids in photos** | Photo panel tick "Grid lines in the photo" (says when grids are off): the lines show in photo mode and in stills / 360s, widths scaled on 2–4× stills. Off by default, not saved. | `GameSession.Photo.cs`, `Render.cs`, `Grids.cs` |
| **Grass on edits** | The grass field leaves out hidden / demolished / moved elements and adds moved, cloned and placed copies under their transforms; rebuilt on a worker thread 0.75 s after the scene settles (not while a gun holds an element). | Core `GrassField.Build(…, visible, instances)`; App `GameSession.Grass.cs` |
| **Grass in probes** | Probe faces draw blades (low density, 20 m); probes re-bake when the field or height changes. | `SceneRenderer.Grass.cs` (`ProbeGrass`, `DrawGrass(p, probe)`), `SceneRenderer.cs`, `GameSession.Reflections.cs` |
| **Tour sun blend** | `TourPose.BlendFrom / BlendTo / BlendT`: over a glide from stop to stop; across fades half on the fade-out, half on the fade-in (0.5 at black, seamless). The app moves date (day of year) and time (fractional minutes) between the two stops' suns; shadows on / off switch half way. | Core `TourTimeline.cs`; App `GameSession.Tour.cs`, `Sun.cs` (`_sunBlendMinutes`) |
| **Bookmarks keep crouch** | `BookmarkRecord.Crouched` (written only when true). GO arrives crouched (`CharacterController.HoldCrouch`; crouch, jump or flying stands up); the tour films from the crouched eye (the player's crouch / stand ratio). The list shows "· CROUCHED". | Core `BookmarkModels.cs`; App `Player.cs`, `CharacterController.cs`, `GameSession.Bookmarks.cs`, `Tour.cs`, `BookmarkStore.cs` |
| **Comment / BCF eye height** | `CommentView.EyeHeight` (null on older comments): stamped with the standing eye when a view is set; GO applies it; BCF export uses it (else the preset), import converts with the current preset and stamps it; the approach view for comments without one uses the preset. | Core `CommentModels.cs`; App `CommentStore.cs`, `GameSession.Bcf.cs`, `Comments.cs` |

### Colour profile follow-ups

| Item | What it does | Where |
|---|---|---|
| **Bin methods** | Ranges profiles: CUT BY **EQUAL WIDTH** (as before) / **EQUAL COUNT** (quantile edges; repeated edges merge, so fewer ranges can come out) / **CUSTOM** (BREAKS…: typed "300; 450; 600"; units ignored; only breaks inside the numbers' span are used; none: one range). A value on a break goes in the lower range. `AppearanceProfile.Binning`, `Breaks` (additive). | Core `AppearanceProfiles.cs` (`BinMethod`, `RangeEdges`, `ParseBreaks`, `FormatBreaks`, `CleanBreaks`); App `GameSession.ColourProfilesPanel.cs` |
| **Profile-coloured caps** | While a profile shows, the section caps take the colour (×0.8) of the profile-coloured element seen through the cut; other elements keep the flat cap colour. Stencil: parity in bit 1, bit 2 marks coloured pixels; the cap polygon then writes depth for all. | `Shaders.CAP_STENCIL_FS` (`uCapColourPass`), `SceneRenderer.Section.cs`, `Gl.REPLACE` |
| **Legend for big stills** | The legend is laid out on a 1/k screen and flushed over the whole k× still (2–4×), so it reads as on screen. | `GameSession.Photo.cs` (`RenderPhotoView(…, legendScale)`) |
| **Hidden rows' copies** | `DynamicSet.SourceHidden` (shared with the profile's hidden rows): moved / cloned copies of those elements aren't active: no drawing, shadows, picking or collision. | `Physics/DynamicSet.cs`, `GameSession.ColourProfiles.cs` |
| **Import reconciliation** | Profile files gain `Links` (UniqueId + name) at export. Import first rewrites link values not in this model by the link's name, and level values by name (this model's spelling), in set rules and in link / level rows of by-value profiles; the misses are toasted (first three) and logged. | Core `ProfileFiles.Build(…, links)`, `ProfileFiles.Reconcile`, `ProfileReconcile`; App import |
| **Profile per bookmark** | `BookmarkRecord.ColourProfile` (id, "" = none showing, null = leave alone; older bookmarks null). Stamped when a bookmark is made or SET HERE; GO shows it (saved like a toggle); the tour shows each stop's quietly and puts the profile back at the end. The list shows "· PROFILE NAME" / "· PROFILE OFF". | Core `BookmarkModels.cs`; App `GameSession.Bookmarks.cs` (`StampBookmark`, `ApplyBookmarkProfile`), `Tour.cs`, `BookmarkStore.cs` (`Stamp`, `ProfileName`) |

### Tests (+6)
`ClashTests.Sets_Groups_NestAnyDepth`, `TourTests.Blend_GlideAndFadesHandOverTheState`,
`TourTests.Bookmark_CrouchAndProfileAreOptional`, `AppearanceProfileTests.Ranges_EqualQuantileAndCustomEdges`,
`AppearanceProfileTests.Ranges_BreaksParseCleanAndRoundTrip`, `AppearanceProfileTests.Import_LinksAndLevelsMatchedByName`.

### README
Compacted (204 KB → ~113 KB): §8 keeps only this build's to-verify entry, the standing limitations (merged, updated for
P-C) and a new **Roadmap and future goals** subsection (Round K additions, Media area, night sky, rain, Round X, later);
the clash detection bullet in §5 is a structured summary; new §5 bullets for sky / water / grass and the panel shell;
P-C notes on colour profiles, tour, eye height, photo mode; AI note 3 updated (§8 convention); §9 rows.

## Not in
- Grid bubbles / labels (2D) in photos (the lines and nodes only).
- Grass in AO and the minimap.
- Dragging rules between groups; an indent past 4 levels (deeper groups still work, drawn at level 4).
- A way to clear a bookmark's profile other than SET HERE with profiles off.

## How to check
1. **Build**, then the **Core tests** (all pass; README §3 untouched).
2. **Nested groups:** CLASHES → SETS, a set: ADD GROUP, then on its header ADD GROUP → "GROUP 1.1" indented; put rules in
   both; the element count follows (e.g. Level 2 AND (pipes OR (walls AND type contains 200))). × on an inner group asks
   when it has rules. Save, reopen: kept. An older build reading the file ignores the inner groups.
3. **Groups in CLASHES:** a test with groups: the row says "· N groups"; the editor lists them; click one → clash mode on
   that test with the group picked.
4. **Grid node:** a model with grids: dock rows show "· C-4"; type `C-4` in the search.
5. **Grids in photos:** C (grids on), M, tick "Grid lines in the photo": lines in the preview; take a 2× still and a 360:
   lines in both at a similar weight. Grids off: the tick says so.
6. **Grass:** Realistic lawn: demolish / hide an element sitting on the lawn → after a moment blades grow under it; move a
   grass-topped element (or clone it) → blades follow; a glass / shiny surface near the lawn reflects blades (probes on).
7. **Tour sun:** two bookmarks with different sun times (shadows on), PLAY TOUR in Glide: the shadows sweep during the
   glide; in Fade: they move through the fades with no jump at black. A stop without a sun: blends to the tour start's.
8. **Crouch:** crouch, B (bookmark), stand and walk off, GO → you arrive crouched; Ctrl or Space stands; the tour films it
   low. The list shows CROUCHED.
9. **Eye height:** Seated preset, make a comment (SET VIEW HERE), Standing, GO to the comment → seated again; EXPORT BCF and
   open it elsewhere: the camera at seated height.
10. **Bins:** a by-value profile on a number parameter → Ranges: CUT BY EQUAL COUNT (counts even out), CUSTOM → BREAKS…
    "300; 600" → three ranges; reopen: kept.
11. **Caps:** a profile colouring walls, a section box through them → the cut faces show the wall colours (lighter grey
    where elements aren't coloured).
12. **Legend:** legend in shots ticked, a 3× still → the legend the same size relative to the picture as on screen.
13. **Hidden rows:** a profile row HIDE on a category, move one of its elements with Gizmo first → its moved copy hides
    and casts no shadow.
14. **Import:** export a by-set profile using a link-model rule from one model, import into another where the link has a
    different instance (same name) → toast "matched by name"; a level missing → "not in this model: Level: …" (and the log).
15. **Profile per bookmark:** profile A showing, B; switch to profile B, B again; GO between them → the profile follows;
    play the tour → each stop shows its own and the original returns at the end.
