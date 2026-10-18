# C-C2 clash grouping tools: brief (2026-10-17)

Follows `ai/261016f_Handoff/0_handoff.md` §2 and `ai/261016e_Grouping_C1/0_brief.md` (C-C2 answers). Gavin's answers
this round, including the changes he added while it was being built:

| Question | Answer |
|---|---|
| Dock layout | **TOOLS ▾ menu.** SHOW joins the filter row (STATUS / LEVEL / SHOW); search moves beside SELECT ALL / REPORT…; the grouping row reads GROUP · UNGROUP · TOOLS ▾ (box, pick points, cluster, the automatic methods, remove automatic groups). Same row count as before. |
| Box mode | **The section box**, resized with its handles, with an easy way to move round it and a clear commit. The **group remembers its box** and can **recollect** the clashes in it when the user asks. |
| Moving round the box | **Orbit round the box** (RMB-drag orbits, wheel zooms) and **the dock folds to a slim bar**. Goal: easy to move round the box and to grab the handles. Later, **EDIT BOX…** resizes a group's box, and clashes no longer in it can be taken out. |
| Recollect | **Add what's inside, keep the rest**, with a **prompt** when members no longer lie in the box: optionally remove those N. |
| Proximity | **Not automatic for the whole test.** Clusters are made one at a time, started by the user. First answer: a distance in display units, plus a temporary sphere at the centre showing the clashes it will take. **Changed mid-build:** no distance box; a **handle on the sphere's edge in the XY plane** resizes it by hand. |
| Cluster names | **Cluster N · Level × n clashes** (the level most members are on). |
| Stacked clashes | **Added mid-build:** an infinite-height rectangle catches stacked clashes. It is a **FULL HEIGHT toggle on the box tool**, not a separate tool. |

From the C-C1 brief (unchanged): box rule **clash point inside**; pick mode dots seen through walls (status colour, dimmer
when hidden, bigger + label on hover, amber when picked, nearest 2,000), click toggles, Ctrl+drag marquee adds,
"n picked: NEW GROUP / ADD TO › / CLEAR", Enter commits, Esc leaves, the list selection mirrors the picks; manual methods
**move** grouped clashes and say so; auto methods take ungrouped, unresolved clashes only, minimum 2, one method per run;
pick-mode key **suggested, not bound**.
