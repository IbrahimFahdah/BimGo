# Water round W and the grids round: brief (2026-10-17)

Gavin: C-C3 (clash grouping and reports) "all worked perfectly". Next: water controls, then grids and levels.
After that, a future round: appearance profiles / colour by parameter.

## Answers (AskUserQuestion, all the recommended options)

| Question | Answer |
|---|---|
| Phasing | **W** (water / grass sliders), then **grids A** (extraction + lines + levels + panel), then **grids B** (nodes, labels, clash "near C4 · L2", minimap) |
| Water / grass controls | Ripple strength 0–200 % (0 skips the waves), ripple speed 0–200 % (0 = still), grass sway 0–200 %; **per machine** like water colour; also in the **Revit Options** window |
| Grid source | **Host + links** (link transforms); a "Link grids" toggle in the panel, **off by default** |
| Grid extent | **Respect 3D extents**: a grid shows only on levels inside its Revit 3D vertical extent; a panel option ignores it |
| Grid style | **Revit-like**: dash-dot line on the level plane, circled bubble with the grid name at both ends (billboard); colour / opacity / width in the panel |
| Levels | **Outline + tags**: a faint rectangle at each level around the grid extents, a level tag (name + elevation) at each bubble; planes off by default |
| See-through | **Faint through walls**: full where visible, ~25 % behind geometry, bubbles on top; panel: depth-tested / faint / x-ray |
| Keys | **Shift+G** opens the grids panel (like Shift+O sun); **C** cycles grids off → underfoot level → all levels; both live walking, flying and in clash mode (both checked free in every situation) |

Added by Gavin mid-round: **hover a node to see its grid / level label** ("A1 · Level 2", with coordinates) whenever nodes are on (grids build B).
