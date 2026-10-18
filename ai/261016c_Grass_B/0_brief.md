# Grass round, build B brief (2026-10-16)

From the sky round brief (`ai/261016b_Sky_A/0_brief.md`, answers taken): **instanced blades, own build**: grass surfaces
rasterised once from above into a height / mask map; a fixed budget of blades placed by the GPU around the camera from
it; wind sway; sun, shadows and lights; fade by the distance; no shadow casting; Realistic mode only; mostly horizontal
grass; grass by keywords (default grass, lawn, turf). Gavin: "no issues with frame rate" on build A; "ask all queries up
front if any remain otherwise take it away" → no further questions; defaults chosen (below).

Added mid-build (Gavin): **water tint / base colour option at startup**, "it's quite blue currently, or an absorption of
sky factor if that's what's doing it". Both: the blue is mostly the sky reflection on top of Revit's (often blue) water
colour, so a water colour (Revit / Pool / Pond / Dark presets, or #RRGGBB) and a reflection strength (0–100 %), in the
Revit Options window and the session.

Defaults chosen: blades on, Medium density, 120 mm (±40 %), 40 m; near grid to 12 m (+4 m cross-fade band); covers
2 cm–2 m above the grass remove it; water colour = Revit's, reflection 100 % (as before).
