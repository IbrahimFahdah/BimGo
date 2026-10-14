# Polish round (after the C-B1 fixes): brief and build notes

Gavin, 2026-10-12, after testing the C-B1 fixes ("this is sweet"): a final small round, then hand over to the next
clash round (C-B2) if it works. **Not compiled here** (no .NET SDK); brackets and new names checked by script.

| Gavin's point | Done |
|---|---|
| "Back to clash mode" doesn't fit its button | Now "← CLASH MODE" (`GameSession.ClashPanel.cs`) |
| Switchback (R) doesn't do section boxes | Intentional for now: SHOW IN REVIT (a 3D view with the clash's section box) is C-B2 |
| Pick several clashes at once to see them together, group them / add to existing groups | Deferred to the grouping round (C-C); noted for the next handoff |
| Clash view menu too tall, bottom descriptors unreadable | The card's height is measured from its key hint (up to 3 lines); buttons at a fixed 176 px (`ClashCardHeight`) |
| Gun bar off by default, a hint saying MMB opens the wheel, a show / hide option at the bottom of the wheel | `ShowGunBar` setting (default off, saved); `HINT_NO_GUN_BAR` line; the wheel has one more slot at the bottom (`WHEEL_BAR`), mouse or pad |
| Scroll cycles guns: not needed with the wheel; cycle modes instead | New `GunModePrevious` / `GunModeNext` on the wheel; `Gun.CycleMode(direction)` (Measure: four modes both ways, Demolish: demolish / delete); Previous / Next gun moved to Shift+wheel (kept: the Core test wants a default key for every action) |

Files: `GameSession.GunWheel.cs`, `.Render.cs` (gun bar, help line), `GameSession.cs` (settings, wheel keys),
`Guns/Gun.cs`, `Guns/MeasureGun.cs`, `Guns/HammerGun.cs`, `Clashes/GameSession.ClashDock.cs`, `.ClashPanel.cs`, Core
`Scene/InputCatalog.cs`, `Scene/LaunchSettings.cs`; README §3 rows (hand-written in the generated format), §8, §9.

To verify: README §8, "Polish round". Compile risk: `Shift+WheelUp` as a default chord (the chord parser accepts
modifiers with any key; if CONTROLS shows it oddly, give Previous / Next gun another default).

## For the next chat (C-B2)

Read `ai/261012g_Handoff/0_handoff.md` §3 (C-B2: row thumbnails, TO COMMENT / TO COMMENTS, SHOW IN REVIT) and §4, plus
this note. Add to C-C (grouping): **multi-select in the clash list** (Ctrl / Shift click) to show several clashes
together (union of their boxes for the section box, every pair tinted), then group them or add them to an existing
group. The overlay widgets (`GameSession.Overlays`: dropdown, confirm) are there to reuse.

## Addendum (2026-10-13): unarmed mode

Gavin: "unarmed / no tool mode. Hides the HUD for the tool under the minimap and the buttons above the MMB tooltip."
New action `Unarmed` (0, Guns group) and a wheel slot UNARMED next to BAR (`WHEEL_UNARMED`); `_unarmed` /
`SetUnarmed` in `GameSession.cs`: no gun panel, name / hint row, highlights, `Update` / fire, `OnKeys`, gun modes or
clear markers while unarmed; a gun key or the wheel arms (the same gun too). Not saved. `ControlsTests` were fixed for
the wheel defaults (gun modes on the wheel, Shift+wheel steps guns). README §3 row and §8 check added.
