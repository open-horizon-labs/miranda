# Heimdall Surface — Design Audit

**Date:** 2026-02-24
**Scope:** All components on `issue/121` branch
**Method:** Static code analysis against WCAG 2.2 AA, OKLCH theming spec, performance budgets

---

## 1. Accessibility

### 1.1 Contrast (WCAG AA)

Computed approximate contrast ratios from OKLCH lightness values:

| Pair | Light | Dark | Threshold | Verdict |
|------|-------|------|-----------|---------|
| `--ground-3` on `--ground-0` | 2.43:1 | 2.60:1 | 4.5:1 (normal) | **FAIL** |
| `--ground-4` on `--ground-0` | 4.06:1 | 4.41:1 | 4.5:1 (normal) | **FAIL** |
| `--ground-5` on `--ground-0` | 7.04:1 | 7.74:1 | 4.5:1 (normal) | PASS |
| `--attention` on `--ground-1` | 2.42:1 | 5.05:1 | 4.5:1 (normal) | **FAIL light** |
| `--ground-3` on `--ground-1` | 2.19:1 | — | 4.5:1 (normal) | **FAIL** |

**Affected elements:**
- Phase labels (`PhaseColumn .phase-label`) use `--ground-3` at `--text-xs` — fails AA for normal AND large text
- Issue numbers (`IssueMarker .issue-number`) use `--ground-4` at `--text-xs` — fails AA for normal text
- Agent status (`IssueMarker .agent-status`) use `--ground-4` at `--text-xs` — fails AA for normal text
- Item ref (`AttentionStrip .item-ref`) use `--ground-4` at `--text-xs` — fails AA for normal text
- Attention icons in light mode on ground-1 background — fails AA entirely

**Fix:** Darken `--ground-3` to ~55% L and `--ground-4` to ~42% L in light mode. Adjust `--attention` light-mode L to ~52%.

### 1.2 Keyboard Navigation

- `IssueMarker` renders as `<span>` — not focusable, no keyboard navigation path through the issue list
- No `tabindex` on any issue or region
- No roving tabindex or arrow-key navigation for regions → phases → issues
- Phase columns and app regions are not keyboard-navigable

**Fix:** Add focusable wrappers with `tabindex="0"` or `role="listitem"` where appropriate. Implement roving tabindex for issue lists.

### 1.3 Focus Indicators

- No `:focus-visible` styles on ANY interactive element
- Spec requires: "2px `--attention` outline with offset"
- `action-btn` (button and anchor) has no focus ring
- PR links in IssueMarker have no focus ring

**Fix:** Add global `:focus-visible` rule: `outline: 2px solid var(--attention); outline-offset: 2px;`

### 1.4 Screen Reader Support

- `<header>`, `<main>`, `<footer>` landmarks present in `+page.svelte` — good
- **Missing:** ARIA live region on attention strip. When items appear/disappear, screen readers get no notification
- **Missing:** `aria-hidden="true"` on SVG icons in `AttentionStrip` (present in `IssueMarker` — inconsistent)
- **Missing:** `aria-label` on attention items explaining the reason and action
- Phase column `<section>` lacks `aria-label` or `aria-labelledby` linking to the phase header

**Fix:** Add `aria-live="polite"` to attention strip container. Add `aria-hidden` to decorative SVGs. Add `aria-label` to phase sections.

### 1.5 Touch Targets

- `action-btn` in AttentionStrip: padding `0.25rem 0.5rem` at `--text-xs` (~0.72rem) yields ~19px height
- WCAG 2.5.8 (Level AA, WCAG 2.2) requires minimum 24x24 CSS pixels for touch targets
- The 44x44px threshold from platform guidelines (Apple HIG, Material) and WCAG 2.5.5 (Level AAA) is the stronger recommendation
- At ~19px, the button fails both the 24px AA floor and the 44px best-practice target

**Fix:** Increase action-btn to at least `min-height: 24px; min-width: 24px;` for WCAG 2.5.8 AA compliance. For best-practice touch UX, target 44px using `::after` pseudo-element tap area expansion.

### 1.6 Reduced Motion

- Global `@media (prefers-reduced-motion: reduce)` in `app.css` handles heartbeat animations — good
- **Missing:** `slide-in-right` animation in `AttentionStrip.svelte` (component-scoped) not covered
- **Missing:** `rotate-slow` animation in `IssueMarker.svelte` (component-scoped) not covered
- These component-scoped animations will still play for users who requested reduced motion

**Fix:** Add `@media (prefers-reduced-motion: reduce)` blocks in each component's `<style>` to disable their local animations.

---

## 2. Performance

### 2.1 Polling (no SSE)

- Store uses `setInterval` at 5s — acceptable for ambient display
- `_refreshing` guard prevents parallel fetches — good
- `onDestroy` → `portfolio.stop()` cleans up interval — good
- No memory leak risk identified in the polling pattern

### 2.2 Animation Performance

- Heartbeat animations use `transform` + `opacity` — GPU compositable, good
- `rotate-slow` uses `transform: rotate()` — compositable, good
- `slide-in-right` uses `transform: translateX()` + `opacity` — compositable, good
- **Issue:** `AppRegion` temperature transition: `transition: background ...` — `background` is NOT compositable. Triggers paint on every frame during the 1s transition.

**Fix:** Use pseudo-element with `opacity` transition for temperature overlay instead of transitioning `background` directly.

### 2.3 Font Loading

- Google Fonts loaded via `<link>` with `display=swap` — prevents FOIT, good
- Variable fonts (Fraunces opsz+wght, Plus Jakarta Sans wght) served — good
- **Missing:** No `@font-face` metric fallbacks with `size-adjust` — layout shift on font swap
- Relying on Google Fonts CDN (serves WOFF2 automatically based on UA) — acceptable
- `<link rel="preconnect">` for fonts.googleapis.com and fonts.gstatic.com — good

### 2.4 Initial Render

- SPA with `ssr: false`, `prerender: true` — HTML shell is prerendered but content requires JS + API
- **Issue:** No loading skeleton or indicator while `portfolio.loading === true` — users see a blank screen
- First meaningful content depends on API response latency
- The `loading` state IS tracked in the store but the page doesn't render a skeleton for it

**Fix:** Add a loading skeleton in `+page.svelte` that shows while `portfolio.loading` is true.

### 2.5 State Updates

- Svelte 5 runes ($state, $derived) provide fine-grained reactivity — efficient
- Store replaces entire `apps` array each refresh — Svelte's keyed `{#each}` by `app.name` handles this efficiently
- `$derived` computations are lazy — only evaluated when accessed
- No obvious bottleneck for 60fps budget

---

## 3. Theming

### 3.1 Light/Dark Mode

- Design tokens fully defined for both modes via `@media (prefers-color-scheme: dark)` — good
- All components use CSS custom properties — good
- `color-scheme: light dark` declared on `:root` — good
- Theme-color meta tags for both schemes in `app.html` — good

**Issue:** `AppRegion.svelte` temperature computation uses hardcoded rgba values:
```js
if (askingCount > 0) return 'var(--attention-tint, rgba(255, 180, 60, 0.06))';
if (activeCount >= 3) return 'rgba(255, 140, 50, 0.05)';
if (activeCount >= 1) return 'rgba(255, 160, 80, 0.03)';
```
These are warm orange tints that work in light mode but are wrong in dark mode (bright orange on dark background is too vivid). Should use OKLCH-based tokens.

### 3.2 OKLCH Consistency

- All design tokens in `app.css` use OKLCH — good
- `PhaseColumn .phase-review` uses `color-mix(in oklch, ...)` — good
- `+page.svelte .error-banner` uses `color-mix(in oklch, ...)` — good
- **Violation:** `AppRegion.svelte` temperature backgrounds use raw `rgba()` — rogue hex/rgb values

**Fix:** Define `--temperature-*` tokens in OKLCH and use them in the temperature computation.

### 3.3 Warm Ground Tints

- Light mode: all ground tokens at hue 75 — consistent warm tone
- Dark mode: ground tokens at hue 55 — intentional warmer shift for dark backgrounds
- No stray neutral grays — all grounds maintain warm character

### 3.4 Attention Accent Economy

- `--attention` usage inventory:
  - `AttentionStrip`: asking, ci-failed, conflicts icon colors — correct (these need attention)
  - `IssueMarker`: error state (`filled-accent`) — correct
  - `IssueMarker`: CI fail badge — correct
  - `+page.svelte`: error banner — correct
- `--attention` does NOT appear on non-attention items — economy maintained
- `PortfolioBar` pulse uses `--pulse-active`, not `--attention` — correct separation

---

## 4. Responsive

### 4.1 Container Queries

- `AppRegion` declares `container-type: inline-size` with `@container (max-width: 768px)` rule — works
- `PhaseColumn` declares `container-type: inline-size` but has **no @container rules** — unused declaration
- `+page.svelte .app-regions` declares `container-type: inline-size` but has **no @container rules** — unused declaration
- Only one breakpoint (768px) defined — spec mentions "all three breakpoints"

**Fix:** Add container query rules for compact (<480px) and narrow (480-768px) viewports. Remove unused `container-type` declarations or add rules for them.

### 4.2 Horizontal Scroll

- `.surface` uses `overflow: hidden` — prevents page-level horizontal scroll
- Text elements use `overflow: hidden; text-overflow: ellipsis` — handles long content
- No fixed-width elements that could cause overflow
- No horizontal scroll issues identified

### 4.3 Touch Interactions

- Action buttons in AttentionStrip are the primary touch targets — size issue flagged in 1.5
- PR links in IssueMarker are small text links — adequate for non-primary interactions
- No drag or complex gesture handlers — appropriate for ambient display

### 4.4 Attention Strip Sticky Behavior

- `position: sticky; bottom: 0` with `max-height: 30vh; overflow-y: auto` — good
- On compact viewports, 30vh may consume too much screen real estate for a footer
- Consider reducing to 20vh on compact viewports

---

## Summary

### Findings by Severity

| # | Severity | Dimension | Finding | Fix Issue |
|---|----------|-----------|---------|-----------|
| F1 | Critical | A11y | Contrast failures: ground-3 (2.4:1), ground-4 (4.1:1), attention-on-light (2.4:1) | #128 |
| F2 | Major | A11y | No focus indicators (`:focus-visible`) on any interactive element | #129 |
| F3 | Major | A11y | No keyboard navigation through regions/issues | #129 |
| F4 | Major | A11y | Missing ARIA live regions for attention strip updates | #130 |
| F5 | Major | A11y | Touch targets at ~19px, below 24px AA minimum (WCAG 2.5.8) | #131 |
| F6 | Major | A11y | Reduced motion: component-scoped animations not suppressed | #132 |
| F7 | Major | Theming | Hardcoded rgba in temperature backgrounds (not OKLCH, not dark-mode aware) | #133 |
| F8 | Major | Performance | No loading skeleton — blank screen until API responds | #134 |
| F9 | Minor | Performance | Temperature background transition triggers paint (not compositable) | — |
| F10 | Minor | A11y | AttentionStrip SVGs missing aria-hidden | #130 |
| F11 | Minor | A11y | Missing aria-label on attention items (reason + action) | #130 |
| F12 | Minor | A11y | Phase column section missing aria-label/aria-labelledby | #130 |
| F13 | Minor | Responsive | Only 1 of 3 container query breakpoints implemented | — |
| F14 | Minor | Performance | No @font-face metric fallbacks for layout shift prevention | — |

Minor findings without fix issues (F9, F13, F14) are deferred — address opportunistically during fix work. Minor ARIA findings (F10-F12) are tracked under #130.

### What Passed

- Dark/light mode token coverage (complete)
- OKLCH color consistency (except temperature — F7)
- Attention accent economy (used only where needed)
- Warm ground tints (consistent hue across all neutrals)
- Animation performance (transform + opacity, GPU compositable)
- Polling lifecycle (clean start/stop, no memory leaks)
- HTML landmark structure (header/main/footer)
- SVG aria-hidden in IssueMarker (partial — missing in AttentionStrip)
