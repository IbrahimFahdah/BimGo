# QOL round brief (2026-10-16)

Minor round before the C-C clash grouping build (grouping carries forward unchanged: see `ai/261014b_Handoff`).

Asked (Gavin):
- Options menu: hide the dark background and the non-graphics buttons for a while to tune settings; Esc leaves it.
- Options bar tidy: Debug → Appearance overrides (later: override by parameter value(s) and by clash search set(s)).
- Unarmed → None in the gun wheel / guide.
- Pause screen left buttons less dense ("chonky") at small resolutions.
- Water material override by Revit asset and optional name keywords; glass the same; placeholder for a dynamic grass
  proxy in Realistic later. In the load-up (Revit Options) window and in the session.
- Clash report export / import only from the main clash area; on the TESTS / SETS tabs export / import tests or sets
  as files, reconciling properties that aren't there (which link replaces which when names don't match). Reporting
  will get its own menu later.
- Leaving clash mode switches the box off.
- Shortcut between sun study and sun settings.

Answers (AskUserQuestion, all recommended):
1. Import: **add; ask on name clash** (one prompt: replace / keep both / skip); unknown link names → a mapping step;
   tests bring the sets they use.
2. **Water + glass keywords**: water from the Water asset (toggle, on) + keywords; glass keywords (empty) force
   see-through on opaque materials; grass a greyed placeholder.
   *Deviation:* water keywords default to **"water"** only (not "water, pool"): keywords only match see-through
   materials, and "pool" would turn pool-fence glass into water. Add "pool" in the field if wanted.
3. Preview: **graphics column only** (PREVIEW button; backdrop, left buttons and non-graphics rows hide; Esc returns).
4. Appearance tab: **greyed placeholder rows** for by parameter value / by search set.
