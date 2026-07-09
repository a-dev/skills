---
name: css-modules
description: Typed CSS Modules conventions for styling React components. Use when creating or editing *.module.css files, writing className/style props, adding variant/state props, or picking color/theme values. A project's own CSS convention skill wins; if the #styles plumbing is missing, suggest /css-modules-setup first.
---

# Typed CSS Modules — conventions

A system that makes CSS Modules as convenient as utility-first CSS while staying easier to read and debug: real class names in DevTools, component state visible as `data-*` attributes in the DOM, and class access that fails at compile time instead of producing `undefined` at runtime.

This skill is the per-edit rulebook. It assumes the project plumbing is already in place: generated `*.module.css.d.ts` typings, the `cx`/`cssVars` helpers, two-tier tokens, a declared `@layer` order, and shared style modules behind the `#styles` alias. If any of that is missing, don't improvise it inline — suggest the user run `/css-modules-setup` (its audit phase also detects partial or drifted setups).

## The two helpers

The whole runtime surface is two tiny functions plus the shared style modules, all imported from one entry point:

```ts
import { cx, cssVars, layout, typography, utils } from "#styles";
```

- `cx(...args)` joins class strings, skipping falsy values. Falsy entries exist for **optional passthrough only** — a `className` prop that may be `undefined`, an optional enum lookup like `!!size && SIZE_CLASS[size]` — never for boolean state (rule 5).
- `cssVars({ "--_x": … })` is the only sanctioned inline style (rule 6). It rejects non-`--*` keys at the type level.

## Rules

### 1. One `*.module.css` co-located per component

The module file is the component's style namespace. When one file styles two unrelated blocks and names get ambiguous, split the module — don't prefix.

### 2. kebab-case in CSS, camelCase in TSX — never computed keys

`localsConvention: "camelCaseOnly"` means `.button-icon` is consumed as `styles.buttonIcon`; `styles["button-icon"]` is a TS error instead of silent `undefined`. Never compute class strings: the generated typings reject ``styles[`size-${size}`]``, and it would break at runtime anyway — `camelCaseOnly` removes the kebab-case keys it tries to look up. Use a typed lookup (rule 4).

### 3. Class names: role-based, short, no component-name prefix

- `root` for the outermost element — always `root`, not the component's name or role: one uniform, greppable outer class across every component.
- Role names for children: `icon`, `label`, `header`, `item`, `meta`, `action`.
- Do not repeat the component name: `button-icon` ❌, `icon` ✓ — the module file already namespaces it.
- No BEM. No bare modifier classes (`primary`, `--small`). Variant values use `.variant-x` / `.size-x` via a typed lookup (rule 4); boolean state uses `data-*` (rule 5).

### 4. Closed enums → typed class lookups

```tsx
type Variant = "primary" | "secondary";

const VARIANT_CLASS = {
  primary: styles.variantPrimary,
  secondary: styles.variantSecondary,
} satisfies Record<Variant, string>;

<button className={cx(styles.root, VARIANT_CLASS[variant], className)} />;
```

`satisfies Record<Variant, string>` is an exhaustiveness check: extend the union and every lookup errors until updated. The map doubles as the component's variant API, readable at a glance and greppable from both sides.

### 5. Boolean state → `data-*` presence · accessibility state → `aria-*` values

```tsx
<button data-loading={loading || undefined} aria-busy={loading || undefined} />
<button aria-pressed={isPressed} />
```

```css
.root[data-loading] {
  cursor: progress;
}
.root[aria-pressed="true"] {
  background: var(--color-accent-bg);
}
```

- **`data-*`: strip false, match presence.** `|| undefined` removes the attribute; `data-loading="false"` would still match `[data-loading]` and lie. Use presence selectors (`[data-loading]`), not string compares (`[data-loading="true"]`).
- **`aria-*`: keep meaningful false, match values.** React renders aria booleans as strings, so `aria-pressed={isPressed}` correctly yields `aria-pressed="false"` — a toggle that drops the attribute stops announcing as a toggle. That same `"false"` is why presence selectors are wrong here: `[aria-pressed]` matches the *unpressed* state. Compare values (`[aria-pressed="true"]`), and strip with `|| undefined` only where absence means the same thing (`aria-busy`), never where false is semantic (`aria-pressed`, `aria-expanded`, `aria-selected`).
- Style `aria-*` state directly — don't mirror it into `data-*`.
- If a headless-UI library already sets state attributes (`data-disabled`, `data-pending`, …), read those; don't duplicate.
- **No boolean state through `cx` conditionals**: `cx(styles.root, isLoading && styles.loading)` typechecks fine — the problem isn't types, it's that state disappears into a hashed class: nothing in the DOM says "loading", and no other selector can target the state. `data-loading` puts the state on the element. Falsy entries in `cx` exist for _optional passthrough only_ — a `className` prop that may be `undefined`, an optional enum lookup like `!!size && SIZE_CLASS[size]`.

### 6. Inline `style` only for custom properties, via `cssVars()`

```tsx
<Bar style={cssVars({ "--_progress": `${pct}%` })} />
```

```css
.bar {
  inline-size: var(--_progress);
}
```

Inline visual properties (`style={{ width: … }}`) bypass the cascade entirely — no module rule can ever override them. `cssVars()` rejects non-`--*` keys at the type level.

### 7. Every styled element gets its own class

No descendant element selectors (`.card h2`, `.tags li`). Sole exception: injected HTML your components don't author — Markdown render output, WYSIWYG/rich-text content, CMS bodies — whose markup cannot carry classes.

### 8. Components consume the semantic token tier only

Tokens come in two tiers under the styles root's `vars/` — primitive palette ramps (`--color-gray-100` … `--color-blue-700`) and semantic tokens (`--color-text-primary`, `--color-panel-bg`, `--fs-*`, `--fw-*`, `--lh-*`, `--rounded-*`).

- Palette tokens and raw color literals never appear in component modules — only semantic tokens.
- One-off tinting goes through `color-mix()` against a semantic token: `color-mix(in oklch, var(--color-panel-bg) 92%, transparent)`.
- Promote a recipe to a new semantic token when it appears in 2+ places or should differ between themes.
- Spacing is free: `padding` / `margin` / `gap` take raw values — the system deliberately has no spacing token tier.
- The size scale names *steps*, not lengths. It lives mostly in UI components — `size` prop variants (rule 4) — plus sized tokens (`--rounded-*`, `--fs-*`) where the developer needs them. Follow the project's naming exactly (e.g. `xxs / xs / s / m / l / xl / xxl`) — never mix in a second scale (`sm / md / lg`).

### 9. Layers: shared styles are the floor, component modules the ceiling

The order is declared once in the global stylesheet: `@layer reset, base, layout, typography, ui, utils;`.

- Shared style modules and reusable UI primitives declare their layer (`@layer ui { … }`).
- `utils` sits **after** `ui` because later layers win: utilities are call-site escape hatches, and `utils.visuallyHidden` on a Button must beat the Button's own `position` and size rules — an escape hatch that loses is no escape hatch.
- Feature/page component modules stay **unlayered** — unlayered styles beat every layer, so app code can always override shared primitives and utilities without specificity hacks.
- Token files are unlayered plain `:root` custom properties, not rules.

### 10. Shared style modules (`#styles`) are a public API

`layout.module.css` (structural grammar: `page`, `container`, `section`), `typography.module.css` (`h1`…`h4`, `body`, `caption`, `mono`), `utils.module.css` (escape hatches: `visually-hidden`, truncation, `rounded-*`) — all re-exported from the `#styles` entry point.

Class names here are a public API — descriptive kebab-case that survives grep. Don't admit anything theme-aware (that's a token) or component-shaped (that's a UI primitive), and wait for the second consumer before adding a class — the baseline set seeded by `/css-modules-setup` is the one blessed exception.

### 11. Composition: two equal mechanisms — pick one and be consistent

**In markup**, via `cx` — combinations visible at every call site and in DevTools:

```tsx
<header className={cx(layout.section, typography.h2, utils.singleLineTruncate)} />
```

**In CSS**, via `composes` — factored once, markup carries one class:

```css
.header {
  composes: section from "#styles/layout.module.css";
  composes: h2 from "#styles/typography.module.css";
}
```

Markup composition keeps decisions at the call site; `composes` removes markup churn when the same combination repeats. Both are legitimate defaults — follow whichever the codebase already uses; if neither is established yet, pick one and apply it consistently.

### 12. Private custom properties: `--_` prefix

`--foo` is public API (token or documented component input — safe to set from outside); `--_foo` is internal plumbing. The underscore is social, not enforced by CSS, but `grep "var(--_"` reveals a component's internal state surface.

## Patterns — good vs. bad

```tsx
// ✓ typed lookup for enums, data-* for booleans, aria for a11y state
<button
  className={cx(styles.root, VARIANT_CLASS[variant], className)}
  data-loading={loading || undefined}
  aria-pressed={isPressed}
/>

// ✗ three silent-failure anti-patterns
<button
  className={cx(
    styles.root,
    isLoading && styles.loading, // boolean state in cx — use data-loading
    styles[`size-${size}`],      // computed key — typings reject it; use a typed lookup
  )}
  data-variant={variant}         // closed enum on data-* — loses the typed lookup
/>
```

```css
/* ✓ theme-aware tinting through a semantic token */
background: color-mix(in oklch, var(--color-panel-bg) 92%, transparent);

/* ✗ palette token or raw color in a component module */
background: color-mix(in oklch, var(--color-gray-100) 92%, transparent);
background: #f5f7fa;
```

## Theming and logical properties

- Semantic color tokens resolve light and dark via `light-dark()` — component modules never contain `[data-theme]` selectors. Needing one means a semantic token is missing; add the token instead.
- Prefer logical properties: `padding-inline`, `margin-block`, `inset-inline-*` over physical equivalents; keep `width`/`height` physical.
