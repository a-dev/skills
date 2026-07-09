---
name: css-modules-setup
description: One-time bootstrap and drift audit of the typed CSS Modules system in a Vite + React project — vite-css-modules typings, cx/cssVars helpers, two-tier design tokens with light-dark() theming, cascade layer order, shared style modules behind the #styles alias. Audits before writing, so it is safe to re-run at any time to check whether a project is still aligned with the convention; it only fills gaps and never overwrites. Per-edit conventions live in the companion css-modules skill.
disable-model-invocation: true
---

# Typed CSS Modules — project setup & alignment audit

Bootstraps (or audits) the plumbing that the `css-modules` conventions skill assumes: typed modules generation, the `cx`/`cssVars` helpers, two-tier tokens, a cascade layer order, and shared style modules behind the `#styles` alias. Recipes assume **Vite + React**; porting notes are at the end.

Safe to re-run: Phase 0 audits first, later phases only fill the gaps it found.

## Phase 0 — audit before touching anything

Resolve the styles root first: follow the `#styles` alias if one is configured; otherwise glob for `**/styles/index.ts`. If neither hits, the `<styles-root>` rows below are `missing` and the root gets chosen in step 1.

Check every marker and print a status table (`aligned` / `missing` / `drifted`) **before** making any change:

| Marker | Where to check |
| --- | --- |
| `patchCssModules({ generateSourceTypes: true, … })` plugin | `vite.config.ts` |
| `localsConvention: "camelCaseOnly"` | `vite.config.ts` → `css.modules` |
| `devSourcemap: true` | `vite.config.ts` → `css` |
| `css:dts` script, run by `prepare` | `package.json` |
| `*.module.css.d.ts` ignored | `.gitignore` |
| CI runs `css:dts` before `tsc --noEmit` | CI workflow files |
| `cx` + `cssVars` helpers | `<styles-root>/lib/` |
| Token tiers: palette + semantic | `<styles-root>/vars/` |
| `@layer` order + `base` element defaults | `<styles-root>/global.css` |
| Shared modules + entry point | `<styles-root>/index.ts` |
| `#styles` alias, subpaths included (`#styles/*`) | Vite `resolve.alias` or `package.json` `imports` |

Then:

- **Everything aligned** → report that and stop; there is nothing to do.
- **Missing** → scaffold from the recipes below.
- **Drifted** (present but deviating: a different alias name, another helper implementation, another size-scale) → do **not** overwrite. Report the drift and adapt the remaining steps to the project's existing choices — the project wins unless the user explicitly asks to migrate.

## 1. Pick the styles root (ask the user)

Skip this when the audit already found a styles root — an existing location is the project's choice; keep it.

Otherwise, before scaffolding anything, ask the user where the styles system should live, suggesting **`shared/styles`** as the default (`src/shared/styles` when sources live under `src/`). Any answer works — consumers only ever import from the `#styles` alias, so the location never leaks into component code.

Whatever root is chosen, the structure inside it is fixed:

```
<styles-root>/
  index.ts               entry point, re-exported behind #styles
  global.css             layer order, token imports, base element defaults — first import in the app entry
  lib/
    cx.ts
    css-vars.ts
  vars/
    palette.css  colors.css  fonts.css  shape.css
  layout.module.css
  typography.module.css
  utils.module.css
```

Recipes below write `<styles-root>` wherever the path appears; substitute the chosen root (project-root-relative, so it includes the `src/` segment when there is one) while writing files.

## 2. Dependencies and Vite config

```sh
npm i classix && npm i -D vite-css-modules
```

```ts
// vite.config.ts
import { patchCssModules } from "vite-css-modules";

export default {
  css: {
    devSourcemap: true,
    modules: { localsConvention: "camelCaseOnly" },
  },
  // declarationMap → Go to Definition lands in the .css source
  plugins: [patchCssModules({ generateSourceTypes: true, declarationMap: true })],
};
```

## 3. Typings workflow

- Add `*.module.css.d.ts` to `.gitignore` — the typings are generated, never hand-authored.
- Add scripts: `"css:dts": "vite-css-modules"` and `"prepare": "npm run css:dts"`. With no globs the CLI covers `**/*.module.css` under the resolved Vite root — no path to keep in sync with the project layout. Typings regenerate automatically while the dev server runs; `prepare` regenerates them on every install, so fresh clones typecheck without a manual step.
- **CI must run `css:dts` before `tsc --noEmit`** — the type layer only exists where it is generated (`npm ci` already triggers it via `prepare`, but an explicit step keeps the ordering visible).

## 4. The two helpers

```ts
// <styles-root>/lib/cx.ts — pin the type locally so the underlying lib is swappable
import { cx as classix } from "classix";

export type ClassValue = string | false | null | undefined;
export const cx = (...args: ClassValue[]): string => classix(...args);
```

```ts
// <styles-root>/lib/css-vars.ts — the only sanctioned inline style
import type { CSSProperties } from "react";

type CssVars = Record<`--${string}`, string | number>;
export function cssVars(vars: CssVars): CSSProperties {
  return vars as CSSProperties;
}
```

## 5. Design tokens — two tiers

```
<styles-root>/vars/
  palette.css   primitive: closed color ramps (--color-gray-100 … --color-blue-700)
  colors.css    semantic:  --color-text-primary, --color-panel-bg, …
  fonts.css     semantic:  --fs-*, --fw-*, --lh-*
  shape.css     semantic:  --rounded-*
```

- Components will consume the semantic tier only (enforced by the `css-modules` conventions skill); the palette exists solely to feed semantic tokens.
- Pick one size-scale naming with the user and enforce it (e.g. `xxs / xs / s / m / l / xl / xxl` — never mixed with `sm / md / lg`). The scale names steps for component `size` variants and sized tokens (`--rounded-*`, `--fs-*`); spacing stays free — no `--space-*` tier is scaffolded, `padding`/`margin`/`gap` take raw values.
- Token files are unlayered plain `:root` custom properties, not rules.

**Theming via `light-dark()`** (recommended): every semantic color token carries both values inline, and the resolved theme lands as `data-theme="light|dark"` on `<html>` mapped to `color-scheme`:

```css
/* colors.css — one line per semantic token, both themes */
:root {
  --color-text-primary: light-dark(var(--color-gray-900), var(--color-gray-100));
}
```

The `color-scheme` mapping is an element default, not a token — it lives in `global.css` under `@layer base` (section 6), keeping token files rules-free.

Component modules never reference `[data-theme]` — that rule lives in the conventions skill; the setup just has to make it possible.

## 6. Global stylesheet and cascade layer order

`<styles-root>/global.css` is the one global stylesheet, imported first in the app entry (`import "#styles/global.css"`). It declares the layer order, loads the token files, and holds `base`-layer element defaults such as the `color-scheme` theme mapping:

```css
/* global.css — the @layer statement must precede the @imports */
@layer reset, base, layout, typography, ui, utils;

@import "./vars/palette.css";
@import "./vars/colors.css";
@import "./vars/fonts.css";
@import "./vars/shape.css";

@layer base {
  html {
    color-scheme: light dark; /* OS decides by default */
  }
  html[data-theme="light"] {
    color-scheme: light;
  }
  html[data-theme="dark"] {
    color-scheme: dark;
  }
}
```

- Reset, global base, shared style modules, and reusable UI primitives each declare their layer (`@layer ui { … }`).
- `utils` deliberately comes **after** `ui`: later layers win, utilities are call-site escape hatches, and `visually-hidden` on a Button must beat the Button's own `position` and size rules — an escape hatch that loses is no escape hatch.
- Feature/page component modules stay unlayered — unlayered styles beat every layer, so app code can always override shared primitives and utilities without specificity hacks.

## 7. Shared style modules behind one alias

Create `layout.module.css` (structural grammar: `page`, `container`, `section`), `typography.module.css` (`h1`…`h4`, `body`, `caption`, `mono`), `utils.module.css` (escape hatches: `visually-hidden`, truncation, `rounded-*`). Seed exactly these baseline sets — they are the convention's standard library and the one blessed exception to the second-consumer rule (conventions rule 10); anything beyond them waits for its second consumer. Re-export everything from a single entry point behind an import alias (Vite `resolve.alias` or the `package.json` `imports` field):

```ts
// <styles-root>/index.ts
export { cx, type ClassValue } from "./lib/cx";
export { cssVars } from "./lib/css-vars";
export { default as layout } from "./layout.module.css";
export { default as typography } from "./typography.module.css";
export { default as utils } from "./utils.module.css";
```

```ts
import "#styles/global.css"; // app entry, once, before anything else
import { cx, layout, typography, utils } from "#styles"; // components
```

The alias must cover subpaths, not only the bare specifier — `composes: … from "#styles/layout.module.css"` (conventions rule 11) and the `global.css` entry import both rely on it:

- `package.json` `imports`: two entries — `"#styles": "./<styles-root>/index.ts"` and `"#styles/*": "./<styles-root>/*"`.
- Vite `resolve.alias`: point `#styles` at the styles-root **directory** (Vite resolves the bare import to its `index.ts`), and mirror both forms in tsconfig `paths` so TypeScript agrees.

## 8. Verify

1. Run `css:dts`, then `tsc --noEmit` — both must pass.
2. Restyle one small existing component following the `css-modules` conventions skill as a smoke test: typed lookup for a variant, `data-*` for a boolean, a semantic token for color.

From here on the companion `css-modules` skill (model-invocable) carries every per-edit rule — this setup skill never needs to fire during normal coding.

## Porting notes

- **Next.js**: CSS Modules are built in; generate typings with `typed-css-modules` (watch mode in dev); set camelCase via css-loader's `exportLocalsConvention`.
- **Other bundlers**: any css-loader/postcss-modules pipeline with `exportLocalsConvention: "camelCaseOnly"` gives the same naming contract.
- Everything except the typings generation ports to any stack, including Vue/Svelte/Astro with modules support.
