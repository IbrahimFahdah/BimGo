# C-B4 brief (2026-10-14)

Gavin's answers:
- Scope: **C-B4a and C-B4b** (select all / focus all, and AND / OR rule groups) in one build.
- Caps: **box off above 200** selected clashes (the camera frames all of them); R warns above 500.
- Delivery: full zip as usual.
- C-B2 / C-B3 README §8 checklists: **all passed**.

Choices taken without asking (budget was tight):
- Focus all is the C-B3 selection with every shown clash in it: one button (SELECT ALL SHOWN ↔ CLEAR ALL N) plus Ctrl+A.
  The tinting, G view, union framing, 1–5, R and TO COMMENTS come along unchanged. Elements that are A in one clash
  and B in another are drawn amber.
- Groups are one level deep. Inside a group, "not" rules are ordinary conditions (Revit-like). Top-level "not" rules
  keep the C-B1 subtract rule, so older files read the same. `RuleGroup.Groups` is reserved for nesting (JsonIgnore).
- Extra parameter fields: not in this build.
