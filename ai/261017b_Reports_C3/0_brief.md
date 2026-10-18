# C-C3 clash reports and two fixes: brief (2026-10-17)

Gavin confirmed C-C2 works as intended. Clash detection is done after this round.

| Question | Answer |
|---|---|
| Picking clashes | **By default, a clash picked in the view (its dot) becomes the current clash**, without the PICK POINTS tool. |
| G key | **Keep G (the model view: ghost / wireframe / real / hidden) live** in the grouping tools. |
| Report formats | **HTML + XML export.** The BimGo JSON report stays as the import / export exchange. **No PDF for now**, so PDFsharp stays out. |
| Scope | **An export card with choices:** scope (what the list shows / the selection / this test / all tests), format, pictures on / off, and how groups appear. |
| Pictures | **Fresh 960 × 540**, rendered at export, with progress and CANCEL. |
| HTML layout | **Cover and summary**, **a section per group**, **a card per clash**, plus **an option to compact a group into one item** with a summary of the number and type of items involved. |
