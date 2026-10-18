# Grids and levels, build A: brief (2026-10-17)

The answers were given in the water round (`ai/261017d_Water_W/0_brief.md`), all the recommended options:
- **Phasing:** A = extraction + lines + levels + panel; B = nodes, hover labels, clash location, minimap.
- **Grid source:** host + links, link grids off by default.
- **Extent:** respect 3D extents (option to ignore).
- **Style:** Revit-like dash-dot with bubbles at both ends.
- **Levels:** outline + tags, planes off.
- **See-through:** faint through walls (also hidden / x-ray).
- **Keys:** Shift+G panel, C cycles off → underfoot → all; both live in clash mode.

## Added during the round (Gavin)

- **Level choices:** above / below / nearest, as well as underfoot and all. Built as off · underfoot · above · below · underfoot ±1 · nearest the eye · all. Above / below step to the next storey (storeys only on), and nearest is the level nearest the eye. Gavin: "that sounds right".
- **Hover a node** to see its grid / level label (e.g. "A1 · Level 2" + coordinates) while nodes are on → **build B**.
- **Clash auto group by grid and by grid + level** (nearest grid intersection, e.g. "Near C4", "Near C4 · Level 2") → **build B**, beside AUTO GROUP by level / category pair.

## Then

A future round: appearance profiles / colour by parameter.
