# Polish round P, build P-C: brief (2026-10-18)

Baseline: `BimGo_Polish_PB` (Gavin's working copy unchanged after P-B, "worked perfectly"). Scope from the roadmap brief
(`claude/BimGo_Roadmap_Polish_Flythrough_Brief.md`, P-C).

## Answers (AskUserQuestion, 2026-10-18)

| Question | Answer |
|---|---|
| Split P-C? | **One build** (all twelve items) |
| Nesting depth of search-set rule groups | **Any depth** (UI indents; `clashes.json` additive) |
| Tour sun blend + crouch | **Do them in P-C** (Round K's path player reuses the blend) |
| Bin methods for colour ranges | **Custom + quantile** beside equal width |

Mid-build requests: compact the README at the end (drop confirmed builds' to-verify entries, less verbose); note the
Round K additions and future goals (below) in the README and the handoff.

## Gavin's notes for later (2026-10-18)
- Path editor also **in tour mode** as an alternative approach; **spline corner logic** (smoothness of turns between
  keys) with the camera **pivoting to face progressively along the path**; fly around and **adjust nodes** on the spline,
  **add frames on the path**, **snap into a frame** and move it yourself.
- A **sun animation** in there at some point.
- Photo / video / tour should feel integrated or linked: a **Visualize / Media / Production** area.
- **Night sky:** moon on / off, moonlight brightness slider, procedural stars with controls like the clouds.
- **Rain:** rain on / off, drops hitting the screen now and then, general rainfall.
