---
name: css-modules
description: Portable typed-CSS-Modules convention pack, project-agnostic. Use when styling React components with CSS Modules in a project that has no CSS convention skill of its own — setting up typed modules, naming classes, adding variant/size props, boolean state via data-*, design tokens, shared style modules, cascade layers.
disable-model-invocation: true
---

# Typed CSS Modules — universal convention pack

A system that makes CSS Modules as convenient as utility-first CSS while staying easier to read and debug: real class names in DevTools, component state visible as `data-*` attributes in the DOM, and class access that fails at compile time instead of producing `undefined` at runtime.

This pack is self-contained and project-agnostic. Recipes assume **Vite + React**; porting notes are at the end. When adopting it in a project, remove the `disable-model-invocation` flag (or write a project overlay skill) so it triggers automatically.

## Setup (Vite)

```ts
// vite.config.ts
import { patchCssModules } from "vite-css-modules";

export default {
  css: {
    devSourcemap: true,
    modules: { localsConvention: "camelCaseOnly" },
  },
  plugins: [patchCssModules({ generateSourceTypes: true, declarationMap: true })],
};
```

- Add `*.module.css.d.ts` to `.gitignore` — the typings are generated, never hand-authored.
- Add a script: `"css:dts": "vite-css-modules 'src/**/*.module.css'"`. Typings regenerate automatically while the dev server runs; run the script after batch edits, on a fresh clone, and in CI.
- **CI must run `css:dts` before `tsc --noEmit`** — the type layer only exists where it is generated.

## The two helpers

The whole runtime surface of the system is two tiny functions, re-exported from the shared-styles entry point (below):

```ts
// shared/styles/lib/cx.ts — pin the type locally so the underlying lib is swappable
import { cx as classix } from "classix";

export type ClassValue = string | false | null | undefined;
export const cx = (...args: ClassValue[]): string => classix(...args);
```

```ts
// shared/styles/lib/css-vars.ts — the only sanctioned inline style
import type { CSSProperties } from "react";

type CssVars = Record<`--${string}`, string | number>;
export function cssVars(vars: CssVars): CSSProperties {
  return vars as CSSProperties;
}
```

## Rules

### 1. One `*.module.css` co-located per component

The module file is the component's style namespace. When one file styles two unrelated blocks and names get ambiguous, split the module — don't prefix.

### 2. kebab-case in CSS, camelCase in TSX — never computed keys

`localsConvention: "camelCaseOnly"` means `.button-icon` is consumed as `styles.buttonIcon`; `styles["button-icon"]` is a TS error instead of silent `undefined`. Never compute class strings: ``styles[`size-${size}`]`` is `undefined` under `camelCaseOnly`.

### 3. Class names: role-based, short, no component-name prefix

- `root` (or the component's own role, e.g. `button`) for the outermost element.
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

### 5. Boolean state → `data-*` presence · accessibility state → `aria-*`

```tsx
<button data-loading={loading || undefined} aria-busy={loading || undefined} />
```

```css
.root[data-loading] {
  cursor: progress;
}
```

- `|| undefined` strips the attribute when false; `data-loading="false"` would still match `[data-loading]` and lie.
- Use presence selectors (`[data-loading]`), not string compares (`[data-loading="true"]`).
- Style `aria-*` state (`[aria-pressed]`, `[aria-expanded]`) directly — don't mirror it into `data-*`.
- If a headless-UI library already sets state attributes (`data-disabled`, `data-pending`, …), read those; don't duplicate.
- **No boolean state through `cx` conditionals**: `cx(styles.root, isLoading && styles.loading)` is a modifier class in disguise with the silent-`undefined` failure mode. Falsy entries in `cx` exist for _optional passthrough only_ — a `className` prop that may be `undefined`, an optional enum lookup like `!!size && SIZE_CLASS[size]`.

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

No descendant element selectors (`.card h2`, `.tags li`). Sole exception: styling injected pre-rendered HTML (Markdown output) that cannot carry classes.

### 8. Tokens in two tiers; components consume the semantic tier only

```
shared/styles/vars/
  palette.css   primitive: closed color ramps (--color-gray-100 … --color-blue-700)
  colors.css    semantic:  --color-text-primary, --color-panel-bg, …
  fonts.css     semantic:  --fs-*, --fw-*, --lh-*
  shape.css     semantic:  --rounded-*
```

- Palette tokens and raw color literals never appear in component modules — only semantic tokens.
- One-off tinting goes through `color-mix()` against a semantic token: `color-mix(in oklch, var(--color-panel-bg) 92%, transparent)`.
- Promote a recipe to a new semantic token when it appears in 2+ places or should differ between themes.
- Pick one size-scale naming and enforce it (e.g. `xxs / xs / s / m / l / xl / xxl` — never mixed with `sm / md / lg`).

### 9. Cascade layers: shared styles are the floor, component modules the ceiling

Declare the order once in a global stylesheet:

```css
@layer reset, base, layout, typography, utils, ui;
```

- Reset, global base, shared style modules, and reusable UI primitives each declare their layer (`@layer ui { … }`).
- Feature/page component modules stay **unlayered** — unlayered styles beat every layer, so app code can always override shared primitives without specificity hacks.
- Token files are unlayered plain `:root` custom properties, not rules.

### 10. Shared style modules behind one alias

`layout.module.css` (structural grammar: `page`, `container`, `section`), `typography.module.css` (`h1`…`h4`, `body`, `caption`, `mono`), `utils.module.css` (escape hatches: `visually-hidden`, truncation, `rounded-*`). Re-export everything from a single entry point behind an import alias (Vite `resolve.alias` or the `package.json` `imports` field):

```ts
// shared/styles/index.ts
export { cx, type ClassValue } from "./lib/cx";
export { cssVars } from "./lib/css-vars";
export { default as layout } from "./layout.module.css";
export { default as typography } from "./typography.module.css";
export { default as utils } from "./utils.module.css";
```

```ts
import { cx, layout, typography, utils } from "#styles";
```

Class names here are a public API — descriptive kebab-case that survives grep. Don't admit anything theme-aware (that's a token) or component-shaped (that's a UI primitive), and wait for the second consumer before adding a class.

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

Markup composition keeps decisions at the call site; `composes` removes markup churn when the same combination repeats. Both are legitimate defaults — choose per team taste, then apply it consistently.

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
    styles[`size-${size}`],      // computed key — undefined under camelCaseOnly
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

## Recommended companions (separable)

- **Theming via `light-dark()`**: resolved theme as `data-theme="light|dark"` on `<html>` mapped to `color-scheme`; every semantic color token carries both values inline: `--color-text-primary: light-dark(var(--color-gray-900), var(--color-gray-100));`. Component modules never contain `[data-theme]` selectors — needing one means a semantic token is missing.
- **Logical properties**: `padding-inline`, `margin-block`, `inset-inline-*` over physical equivalents; keep `width`/`height` physical.

## Porting notes

- **Next.js**: CSS Modules are built in; generate typings with `typed-css-modules` (watch mode in dev); set camelCase via css-loader's `exportLocalsConvention`.
- **Other bundlers**: any css-loader/postcss-modules pipeline with `exportLocalsConvention: "camelCaseOnly"` gives the same naming contract.
- Everything except the typings generation (rules 1–3, 5, 7–12) is plain CSS + JSX and ports to any stack, including Vue/Svelte/Astro with modules support.
