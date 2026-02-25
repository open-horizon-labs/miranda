# Heimdall Surface — Design Critique

**Date:** 2026-02-25
**Scope:** All components on `issue/122` branch (post-audit fixes)
**Method:** Code review against §16 design intent; six critique dimensions from issue spec
**Evaluation baseline:** §16.1–16.2 (cartographic minimalism, rhythm disruption, anti-dashboard)

---

## Evaluation Baseline Recap

**Tone:** Cartographic minimalism. Dense, authoritative, precise. Every mark earns its place.
**Unforgettable thing:** The surface breathes. Heartbeats on active agents. Work flows spatially. Rhythm disruptions catch the eye.
**Anti-reference:** Dashboards, cards-in-a-grid, cyan-on-dark, drop shadows, glassmorphism.
**Game-loop pull:** Factorio belt effect — you want to watch it. Progress feels visceral. Disruption is engaging.
**Information density:** Squint test — most important element, second most, clear groupings when blurred.

---

## 1. Visual Hierarchy

### What works

- Phase columns use `flex-grow` to give active phases more space: building(2) > review(1.5) > queued(1) > done(0.5). This is the spatial hierarchy the spec demands — active work occupies more of the map.
- Done phase applies `opacity: 0.7`, correctly receding completed work.
- Attention items use `--attention` (burnt sienna) for asking/ci-failed/conflict icons, creating the "signal fire" the spec describes.
- The skeleton loading state renders during `portfolio.loading`, preventing blank-screen disorientation.

### What doesn't work

**F1: Attention strip doesn't dominate the glance.** The attention strip sits at the bottom in `--text-sm` with `--ground-5` text on `--ground-1` background. It visually recedes into the footer instead of demanding attention. In a squint test, the app names (Fraunces at `--text-lg`) would be the most prominent element, not the items that need human action. The spec's "attention items ranked by urgency" implies they should be the visual signal fire, not a quiet footer. The action buttons use `--text-xs` with `--ground-2` background — functionally invisible at a glance.

**F2: Done phase recession too subtle.** `opacity: 0.7` is perceptually close to 1.0. Done issues still compete visually with active work. The spec says completed work "recedes into the ground" — 0.7 is hovering, not receding. Combined with the done marker's check-fading animation (2s fade to 0.2), the marker fades but the row doesn't.

**F3: No visual weight differentiation within issue markers.** All issue markers are 12px SVGs at the same size regardless of state. A working agent's pulsing circle and a queued hollow circle have identical visual weight at rest. The hierarchy should make active agents more visually prominent than queued issues.

### Squint test result

When blurred: app names in Fraunces serif are the most visible. Phase columns form recognizable blocks. The attention strip is a thin, undifferentiated band at the bottom. The heartbeat breathing (±5% scale on 12px) is invisible. **Verdict: the squint test partially passes for groupings, fails for "most important element."**

---

## 2. Rhythm and Motion

### What works

- Heartbeat timing hierarchy is correct and well-considered: working(3s) → thinking(2s) → starting(1s). The deceleration from starting to working communicates "settling into flow."
- Frozen pulse (`opacity: 1; transform: scale(1.05)`) is the right idea — the rhythm break catches attention because everything else breathes.
- Error state: one pulse cycle then dim (`animation: heartbeat-working 3s ease-in-out 1; opacity: 0.4`) — the stuttered heartbeat metaphor lands.
- Blocked: `opacity: 0.3` (flatline). Clear and correct.
- Done: `heartbeat-done` 2s ease-out fade from 1→0.2. The heartbeat ending is poetic.
- Reduced motion: global wildcard plus per-class overrides. Heartbeats become steady glow at 0.85 opacity. Correct.
- `slide-in-right` animation for new attention items gives them entrance presence.

### What doesn't work

**F4: No spatial drift between phases.** This is the critique's most significant finding. When the poll refreshes and an issue moves from "building" to "review", it vanishes from one column and appears in another instantly. The spec explicitly calls for "800ms ease-out-expo" spatial drift — the feeling of work *flowing* left to right. Without this, the surface is a table that refreshes, not a living map where work flows. This is the Factorio belt: you watch the item physically traverse the belt. Here, items teleport.

**F5: Heartbeat markers too small for rhythm perception.** The markers are 12×12 SVG with ±5% scale variation (11.4–12.6px). At typical viewing distance for an ambient display, this 1.2px oscillation is below perceptual threshold. For the heartbeat to be "the most important visual element" (§16.5), the markers or their surrounding area need more visual mass. The breathing should be visible from across a room, not only on hover-close inspection.

**F6: No ambient sound or vibration.** This is an observation, not a requirement — but the best ambient displays (Factorio, flight departure boards, stock tickers) have auditory texture that reinforces the visual rhythm. Not actionable here, but worth noting that rhythm is currently only visual.

---

## 3. Color Temperature

### What works

- OKLCH used throughout. No stray hex/rgb values in the token layer (audit F7 fix applied — temperature tokens are now OKLCH-based).
- Warm ground tones at hue 75 (light) and hue 55 (dark) create a distinctly warm character. This is NOT the typical cold gray of developer tools.
- `--attention` (burnt sienna) at `oklch(52% 0.14 45)` is well-placed — warm but distinct from the ground amber. It stands out against the warm surface without being garish.
- `--done` (sage green, hue 145) and `--review` (muted blue, hue 250) provide natural warm→cool temperature shifts. The cool colors naturally recede against the warm ground, which is the correct perceptual behavior.
- `--waiting` (cool blue) provides the "cloud shadow" temperature shift the spec describes.
- Dark mode uses dark umber (18% L, hue 55), not pure black. The entire surface stays warm.

### What doesn't work

**F7: Temperature overlays may be imperceptible.** The region background tints operate at very low opacity: `--temperature-warm` at 3% opacity, `--temperature-hot` at 5%, `--temperature-asking` at 6% (light mode). On a real display with typical ambient light, a 3% opacity warm tint over a 96% lightness background is physically indistinguishable from no tint. The temperature shift — the "region warming up as agents activate" — would only be visible in a side-by-side comparison, not in ambient monitoring. Dark mode is slightly better (4–8%) but still marginal.

**F8: Attention accent works, but asking items don't pop enough.** The attention icon is burnt sienna, but the text next to it (`item-ref` in `--ground-4`, `item-title` in `--ground-5`) is the same as every other text on the surface. The "signal fire" metaphor implies the *entire* attention item should feel warmer/brighter, not just its 14px icon.

---

## 4. Typography

### What works

- Fraunces serves its role: app names, issue titles, project name, and phase labels use the display face. Its optical sizing and warmth give the surface personality that sans-serif alone can't.
- Plus Jakarta Sans for data (issue numbers, agent status, PR links) — clean, geometric, tabular nums work correctly for aligned columns.
- Major third scale (1.25) with six sizes defined. The fluid `clamp()` sizing adapts reasonably to viewport.
- Small caps on phase labels and agent status — correct typographic convention for labels.
- Tabular nums on issue numbers and item references — alignment is maintained.

### What doesn't work

**F9: Type scale underutilized — hierarchy is compressed.** Six sizes defined (`--text-xs` through `--text-2xl`), but only four are used: `xs`, `sm`, `base` (body default), and `lg`. `--text-xl` and `--text-2xl` are never used anywhere in the surface. The result is that the typographic hierarchy is compressed between 0.64rem and 1.406rem — a narrow range that doesn't create strong visual landmarks. App names and the portfolio bar title both sit at `--text-lg`. There's no "hero" text size that serves as a visual anchor.

**F10: Fraunces used on issue titles (text-sm) is wasted.** Fraunces is a display serif optimized for larger sizes. At `--text-sm` (0.8–0.9rem), Fraunces's personality — the wonky serifs, the optical sizing curves — disappears. It becomes a generic serif at small sizes. Issue titles should use the data face (Plus Jakarta Sans) for legibility at small sizes, reserving Fraunces for labels and headings where its character shines.

---

## 5. Emotional Response — Game-Loop Pull

### The honest assessment

**Does it create the Factorio belt effect?** No. Not yet.

The Factorio belt effect comes from three things: (1) visible physical movement of items through a system, (2) the satisfaction of watching throughput, and (3) the anxiety of seeing a bottleneck form. The current surface delivers (3) partially through the attention strip but misses (1) and (2).

**Do you want to watch it?** For about 30 seconds. The heartbeats are interesting conceptually, but at 12px they don't create ambient texture you'd notice from across a room. After the initial "oh, they're pulsing" moment, there's nothing else that moves. The surface is static between poll intervals. When the poll fires, changes appear instantly — no flow, no drift, no spatial continuity.

**Does progress feel visceral?** No. When an issue completes, its marker fades from 1→0.2 opacity over 2 seconds. That's it. There's no spatial movement to "done." No counter incrementing. No visual inventory of completed work accumulating. In Factorio, completed items fill a chest — you see the pile grow. Here, done issues just fade and the done column (at 0.5 flex-grow and 0.7 opacity) is barely present.

**Does disruption feel engaging rather than annoying?** The frozen pulse concept is strong — a rhythm break IS inherently attention-catching. But the markers are too small for the rhythm to register in the first place. You can't notice a broken rhythm you never perceived. The attention strip items slide in from the right, which is good entrance motion, but the items themselves are text-heavy and action-button-tiny. Disruption should feel like a gentle alarm, not a log entry.

### What DOES work emotionally

- The warm ground tones feel inviting and intentional. This doesn't feel like a cold developer tool.
- The heartbeat concept, when you look closely, is genuinely alive. The frozen pulse IS uncanny.
- The typography has personality. Fraunces gives it character AI tools don't have.
- There's restraint: no celebrations, no confetti, no badges. This respects the user's attention.

### What would increase pull

- Spatial flow (F4): Issues physically drifting between columns would create the "watching the factory" feeling.
- Larger markers (F5): Heartbeats visible from across a room would make this an ambient display you glance at, not a tab you switch to.
- Completion accumulation (F11): A visible representation of work throughput — today's done count, or a done column that has visual mass proportional to completed work.
- Temperature that's actually visible (F7): If entering a room and glancing at the surface, you should be able to tell at a distance "that project is hot" from the region color alone.

---

## 6. AI Slop Test

**Would someone immediately identify this as AI-generated?**

**No.** This passes the AI slop test. Here's why:

**What breaks the AI pattern:**
- OKLCH color system with warm ground tones at hue 75 — AI defaults to HSL with pure grays or blue-tinted palettes. The amber warmth is a deliberate, opinionated choice AI rarely makes.
- Fraunces serif — AI almost never picks a wonky variable serif. It defaults to Inter, Poppins, Geist, or system fonts. The choice of Fraunces signals a human designer who knows the font.
- No card-based layout. AI loves `rounded-2xl shadow-lg bg-white p-6` cards-in-a-grid. This surface has no cards, no rounded containers, no drop shadows.
- No gradients (except the skeleton shimmer, which is functional). No glassmorphism. No blurred backgrounds.
- The heartbeat animation concept is original. AI doesn't generate "frozen pulse to indicate waiting" — it generates "pulse animation" or "skeleton loading."
- Semantic token names (`--ground-0` through `--ground-5`, `--pulse-active`, `--temperature-warm`) show design-system thinking, not generated code.
- Intentional typography: small caps on labels, tabular nums on data, display face separated from data face. AI generates `font-bold text-gray-600` uniformly.

**What almost tips it:**
- The grid-template-rows header/main/footer structure is conventional. Not AI-specific, but also not remarkable.
- The skeleton loading pattern (shimmer block animation) is straight from every UI library.
- The `flex-direction: column` attention strip with items is a standard notification pattern.

**Final verdict on AI slop:** The surface would NOT be identified as AI-generated by a practiced eye. The warm color philosophy, serif display face, and heartbeat concept give it distinctive character. However, the *layout* is conventional enough that it reads as "a well-themed standard layout" rather than "something no AI could produce." The design *decisions* are human; the *structure* is template-grade.

---

## Summary of Findings

| # | Dimension | Finding | Severity | Fix Issue |
|---|-----------|---------|----------|-----------|
| F1 | Hierarchy | Attention strip doesn't dominate the glance — items need more visual weight | Major | #149 |
| F2 | Hierarchy | Done phase recession too subtle (opacity 0.7 ≈ 1.0 perceptually) | Minor | #153 |
| F3 | Hierarchy | Issue markers same visual weight regardless of state | Minor | #153 |
| F4 | Motion | No spatial drift between phases — items teleport on refresh | Critical | #150 |
| F5 | Motion | Heartbeat markers too small for ambient rhythm perception (12px ±5%) | Major | #151 |
| F6 | Motion | No auditory texture (observation only — not actionable) | — | — |
| F7 | Temperature | Region temperature overlays likely imperceptible (3–8% opacity) | Major | #152 |
| F8 | Temperature | Attention items: only icon is accent-colored, text blends in | Minor | #154 |
| F9 | Typography | Type scale underutilized — xl/2xl never used, hierarchy compressed | Minor | #154 |
| F10 | Typography | Fraunces at text-sm loses its display character | Minor | #154 |
| F11 | Emotion | No completion accumulation — done work fades rather than building satisfaction | Minor | #156 |

### Dimensions without issues

- **Emotional response:** The game-loop pull deficit is primarily a consequence of F4, F5, and F7. F11 (completion accumulation) is the one structural finding specific to this dimension. Fix the spatial flow, marker size, temperature visibility, and add completion accumulation, and the pull improves.
- **AI slop test:** Passes. No fix needed.

### Overall Assessment

The design intent from §16 is well-translated into code for color, typography, and animation *definitions*. The surface has character and avoids AI aesthetic traps. But the *experience* of the intent — the living map, the flowing work, the ambient rhythm — is not yet landing. The heartbeats are too small to create texture. The spatial flow doesn't exist. The temperature is invisible. The attention strip whispers when it should command.

The bones are good. The skin needs to breathe louder.
