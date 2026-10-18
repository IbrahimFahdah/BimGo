# Round K, build K-B: brief (2026-10-18)

Baseline: `BimGo_Flythrough_KA` (Gavin: "all good", no changes needed; K-A confirmed, so its README §8 entry goes).
Scope (handoff §2b): the 3D editing of camera paths: the path drawn in 3D, fly + snap editing (K / ← / → / SET), gizmo
drag, a scrubber with Space preview, collision flags. Gavin: "keen for the user to modify spline points and add / remove /
enter and reframe the view angle at points".

## Answers (AskUserQuestion, 2026-10-18; all the recommended options)

| Question | Answer |
|---|---|
| Editor mode | **Like clash mode**: EDIT IN 3D (MEDIA → PATHS) or a hotkey; a dock on the right, free cursor, WASD flies, up / down keys, RMB-drag looks; click a key's marker to select; Esc leaves |
| Reframing at a key | **Fly, then SET**: ← / → jump into the key's view; fly and look freely; Enter / SET writes position and view; snapping away without SET leaves the key as it was |
| Dragging keys | **Gizmo + target**: X / Y / Z arrows on the selected key (snapping, Shift free); a look-at key's target has its own handles; the view direction can be dragged |
| Scrubber | **Scrub drives the camera**: dragging flies the camera along the path with its heading; Space plays from there; stopping leaves you on the path, where K inserts a key at that point |

Decided while building (no question needed): the editor flies on its own actions (W A S D, E / Q, Shift faster) because
← / → are the key snaps and the walking moves include the arrow keys; Space previews, so up is E (not Space); Shift+K
toggles the editor (K is lights while walking); Ctrl+Z undoes path changes in the editor.
