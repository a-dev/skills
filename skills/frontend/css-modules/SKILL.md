---
name: css-modules
description: Use when styling React components in a project that adopted this typed CSS Modules methodology, identified by a valid .agents/css-modules.json profile, explicit repository instructions, or a direct user request. Trigger for CSS Modules, className/style props, variants, component state, semantic colors, or themes. Do not apply to Tailwind, CSS-in-JS, MUI sx, or unrelated CSS Modules projects. Project-local conventions win.
---

# Typed CSS Modules for styling edits

Use this skill for styling edits in a project that has adopted the methodology. Project conventions override the examples and defaults here. Use the manual `css-modules-setup` skill for installation, bootstrap, alignment, migration, and verification planning.

## Start with adoption

Activate when at least one condition is true:

1. `.agents/css-modules.json` exists and is valid (legacy or compact format).
2. Repository instructions explicitly adopt this methodology.
3. The user directly asks to apply or migrate to it.

The presence of a `*.module.css`, `className`, or React component alone does not establish adoption. If a project is explicitly adopted but has no JSON profile, follow its recorded repository conventions and inspect the relevant implementation. Do not invent a permanent profile. Ask only about missing choices that affect the edit, such as competing shared entry points, incompatible layer ownership, or a required color value. If the user only asks to inspect or verify an unprofiled project, stay read-only and use the setup skill's audit route.

## Example

Compose shared styles and local role classes in JSX. Use the names and layers recorded in the project contract:

```css
/* shared/styles/atoms.module.css */
.cluster {
  display: flex;
  gap: 0.5rem;
}

/* Button.module.css */
.root {
  color: var(--color-action-fg);
}

.root[data-loading] .spinner {
  opacity: 1;
}
```

```tsx
import { cx, atoms } from "#styles";
import styles from "./Button.module.css";

const VARIANT_CLASS = {
  primary: styles.variantPrimary,
  secondary: styles.variantSecondary,
} satisfies Record<"primary" | "secondary", string>;

export function Button({ variant = "primary", loading = false, className, children }) {
  return (
    <button
      className={cx(atoms.cluster, styles.root, VARIANT_CLASS[variant], className)}
      data-loading={loading || undefined}
      disabled={loading}
    >
      <span className={styles.spinner} aria-hidden="true" />
      {children}
    </button>
  );
}
```

Adapt the example to the project's alias, helper, shared admission rule, semantic roles, layers, spacing, and loading policy. Use an exhaustive typed lookup for closed variants. Here, loading disables the button and adds a private presence-only visual marker. Add meaningful ARIA state when needed.

## Load the project contract

Before editing, read:

1. `.agents/css-modules.json`, when present;
2. repository instructions;
3. the nearest comparable component and shared-style entry point;
4. project commands relevant to the change.

Legacy and compact profiles resolve to one generated in-memory contract. Executable configuration remains authoritative. If it conflicts with the authored profile, report drift instead of guessing. Do not convert formats during a daily edit; migration is an explicit setup operation.

## Contract boundaries

| Kind                 | Meaning                                                | Examples                                                                                                                                       |
| -------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Methodology contract | Invariants this skill relies on                        | one owner per authored styled element; exhaustive closed variants; presence-only private booleans; meaningful ARIA false values remain present |
| Project policy       | Choices the repository must record or clearly document | aliases and helpers; shared admission; composition; layer order/ownership; colors; spacing and sizing; local fallback                          |
| Adapter detail       | How the selected stack makes the policy executable     | Vite alias and `patchCssModules`; generated declaration command; package scripts; host-specific lint integration                               |

Examples do not establish project policy. Do not invent a spacing, sizing, typography, or shape scale unless the user or project policy explicitly selects it.

## Classify before editing

| Concern                  | Route                            |
| ------------------------ | -------------------------------- |
| Closed design variant    | exhaustive typed class lookup    |
| Native state             | native attribute or pseudo-class |
| Accessibility state      | ARIA value selector              |
| Private boolean state    | presence-based `data-*`          |
| Headless-library state   | library-owned attribute          |
| Continuous runtime value | private custom property          |
| Reusable class           | project shared-admission policy  |
| Local composition        | local CSS Module                 |

For loading, disabled, pressed, expanded, selected, invalid, busy, or headless-library state, read `references/state-and-accessibility.md`. For fragments, injected HTML, nesting, `asChild`, composition, or library geometry, read `references/edge-cases.md`.

## State and layer boundaries

One state value may drive several distinct behaviors: `loading` can disable a native button, expose `aria-busy`, and add a private visual marker. Avoid duplicate representations of the same meaning. Private booleans must omit the false attribute (`value || undefined` or another supported presence expression); `aria-pressed={false}` must remain present because false is meaningful.

Use the profile's layer order and ownership. Do not hardcode reference names or add wrappers to make a check pass. Verify the selected contract against the cascade. Normal declarations follow configured layer order; important declarations reverse it. Equal-specificity rules in one layer still depend on source order. Unmatched local modules may be intentionally unlayered or may follow a project fallback; report drift rather than normalizing it.

## Edit and verify

1. Inspect. Identify owners, the shared API, state channels, color contract, relevant scripts, and any existing failure. For a small local selector edit, do not launch unrelated checks.
2. Classify. Decide whether each new class is local or admitted shared API, and choose the state/variant/runtime route before writing.
3. Edit. Make the smallest scoped change. Preserve caller classes, generated key names, and project-owned values.
4. Check. A class-key or shared/layer change warrants declaration/type/contract checks. A state or theme change warrants the applicable browser/component runtime case. A comment-only edit needs the narrowest relevant check. Use the nearest existing build, preview, component test, or package/type command when it provides the needed evidence; do not change application configuration merely to create a check.
5. Report. Separate authored edits, generated outputs, command results, DOM state, accessibility behavior, visual output, pre-existing failures, and unavailable evidence. DOM ARIA attributes do not prove that a screen reader announced anything.

Run the profile's applicable `css:generate`, `css:types`, `css:check`, and `css:verify` commands. Report a missing recorded command as unverified. Never claim runtime behavior from static checks alone.

## Source rules

- Use one co-located `*.module.css` per component boundary and short role names such as `root`, `icon`, `label`, and `action`.
- With `camelCaseOnly`, consume kebab-case classes as camelCase. Literal bracket access is equivalent to dot access; dynamic string construction is prohibited. An exhaustive typed lookup map is the supported closed-variant form.
- Every authored styled element owns a class. Relationship selectors between owned classes, pseudo-elements, and narrow injected-content exceptions are documented in `references/edge-cases.md`.
- Component modules consume semantic roles only when the profile enables the color contract. `currentColor`, `transparent`, and appropriate CSS system colors remain valid exceptions.
- Application-owned runtime values use the configured custom-property helper with private `--_` names. Library-owned geometry may remain inline only at the documented integration boundary.
- Follow the profile's `markup`, `composes`, or `mixed-with-rule` composition policy and the exact shared admission rule.

## Completion

Complete the edit when every changed style has an owner and every state has one semantic source. Run applicable profile checks, observe relevant runtime behavior when possible, and report unverified cases. Do not invoke setup implicitly.
