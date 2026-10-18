# Sky round brief (2026-10-16): clouds, sun look, grass (before C-C grouping)

Asked (Gavin): dynamic cloud cover from none to plenty (images faded would do; say if not feasible); a smaller sun /
less glare (a graphical thing, lighting needn't respond); Enscape-style dynamic grass (hair-like blades, some lighting);
other minor QOL before grouping (grouping comes next, promised).

Answers (AskUserQuestion, all recommended):
1. Clouds: **procedural layer** (noise, cover slider, drift) in the sun panel, saved in sun.json; reflections and probes
   see them; cover dims the sun disc / glare only, scene lighting unchanged; no image assets.
2. Sun size / glare: **sun panel, per model** (sun.json), reset with the sky.
3. Grass: **instanced blades, own build (B)**: grass surfaces rendered once from above into a height / mask map; a fixed
   budget (~150–250k) of blades placed by the GPU around the camera from the map, wind sway, sun + shadows + lights,
   fade by ~40 m, no shadow casting; Realistic mode only, off on the Basic profile; mostly horizontal grass (top grass
   only under a roof garden).
4. Also: **grass by keywords** (default grass, lawn, turf), **gamepad clash buttons** (G / B / PICTURES / select all, and
   None), **PREVIEW hotkey**, **trademark line**.

Build A = everything but the blades. Build B = grass.
