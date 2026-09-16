# Mechanical enforcement

Load this reference when the project enables checks in `.agents/css-modules.json`, when adding `css:check`, or when a checker finding needs an exception. Legacy `enforcement` and compact `checks` resolve to the same checker settings.

## One aggregate command

The project command recorded as `commands["css:check"]` should invoke the bundled checker with declaration verification:

```sh
node .agents/css-modules-harness/scripts/check.mjs \
  --root . \
  --run-declarations
```

The command runs the recorded `css:generate` and `css:types` commands once, reports those generated declaration outputs separately from authored edits, and then:

1. the `css-modules/*` TSX rules for state, class lookup, and inline styles, on the resolved lint engine (ESLint or Oxlint);
2. Stylelint rules for selectors, colors, layers, and `!important`;
3. cross-file checks for semantic tokens, shared exports/public classes, layer-ownership ambiguity, and external `composes` paths.

It never invokes `commands["css:check"]` recursively. It does not add generic application lint, test, build, or development commands to the CSS profile.

## Lint engine

The TSX rules run on one lint engine, resolved as the explicit compact `lintEngine`, otherwise the linter the project already runs (Oxlint or ESLint config files and package scripts, then dependencies), otherwise ESLint. An Oxlint project gets `oxlint` and `oxc-parser` and no ESLint or Babel packages; an ESLint project gets `eslint`, `@babel/eslint-parser`, and `@babel/core`. Stylelint and the cross-file checks run with either engine.

`check.mjs` loads ESLint and its Babel parser only for the ESLint engine. With Oxlint it runs the rules through `check-oxlint.mjs` and uses `oxc-parser` for the shared-export analysis, so an Oxlint project never needs ESLint installed. A project that runs both linters stays on ESLint unless the profile sets `lintEngine`.

## Oxlint adapter

With the Oxlint engine, the aggregate command already runs this adapter. For a faster TSX-only loop, run it on its own:

```sh
node .agents/css-modules-harness/scripts/check-oxlint.mjs \
  --root .
```

The adapter loads `harness/oxlint-plugin.mjs`, reads helper names, private boolean attributes, severity, and exceptions from the same project profile, and reports the same `css-modules/*` rule IDs as the ESLint adapter. On its own it covers only the TSX rules; `css:check` adds Stylelint and the cross-file contract checks.

Oxlint JavaScript plugins are currently alpha. Install the exact `oxlint` and `oxc-parser` versions recorded in the bundled `versions.json` and update them only through an explicit harness migration. Switching an installed project from Oxlint to ESLint is a `migrate` run; it removes the unused Oxlint adapter files.

## Migration severity

Start an existing project with:

```json
{
  "enforcement": {
    "severity": "warning",
    "privateBooleanAttributes": ["data-loading"]
  }
}
```

Warnings are reported but do not fail the command. Move to `error` only after the baseline is reviewed. Rule definitions and IDs do not change between the two levels.

Severity applies to the `css-modules/*` rules only. A file that fails to parse is reported as an error by both adapters and fails the command at either level, because no rule ran against it.

## Narrow exceptions

Record an exception only when an objective rule cannot model a required integration:

```json
{
  "kind": "rule",
  "rule": "css-modules/custom-property-style-only",
  "scope": "src/integrations/floating-menu.tsx",
  "match": "floatingStyles",
  "reason": "Floating UI owns computed positioning at this integration boundary."
}
```

The checker requires the rule ID and file glob. `match` narrows the exception to one diagnostic in that file. Keep the reason specific enough for a reviewer to decide whether the exception still exists.

## Rule evidence contracts

Custom rules report proven violations in the syntax they analyze. They do not prove the absence of every architectural problem. A matching narrow exception is the only suppression mechanism; do not turn an analysis limit into a blanket exception.

### TypeScript/JSX rules

- `css-modules/no-computed-key` enforces that a tracked CSS Module binding is indexed with a literal key or a static property. `styles["root"]` and an exhaustive lookup such as `SIZE_CLASS[size]` are valid; `styles[key]` and string construction are invalid. The rule tracks default CSS imports and recorded shared-module exports through the configured public alias, with lexical import bindings rather than names. It does not prove TypeScript's full inferred key union or dynamic CSS-module imports.
- `css-modules/no-boolean-state-class` keeps private boolean state out of conditional CSS classes. For an imported configured class helper, direct `condition && styles.loading`, ternaries, arrays, and computed-key object forms such as `{ [styles.loading]: condition }` are reported. Static lookup maps passed to the helper are valid. The rule proves conditional CSS-module syntax, not the meaning of every condition; a deliberate visual variant needs review or a narrow exception.
- `css-modules/custom-property-style-only` requires application-owned inline style entries to use private `--_*` keys or the imported configured variables helper. `style={{ "--_progress": progress }}` and `style={cssVars(...)}` are valid; `style={{ opacity: progress }}` is invalid. Library-owned geometry is an exception recorded at its integration boundary. The rule does not infer the ownership of an opaque style object.
- `css-modules/no-duplicate-state` rejects a configured private `data-*` state attribute when the same element also has its native or ARIA semantic source, for example `disabled` plus `data-disabled`. The paired semantic attribute is valid without the duplicate. It checks JSX attribute presence, not state aliases spread from another object.
- `css-modules/data-boolean-presence` requires a private boolean data attribute to use a presence-safe expression. `loading || undefined`, `loading ? true : undefined`, `loading ? undefined : true`, `true`, `null`, and `global undefined` are supported; `loading ?? undefined`, a false branch, `false`, and a shadowed `undefined` are invalid. The check distinguishes known false serialization from an unknown expression and does not claim that a supported ternary's condition has the intended product meaning. SSR or browser evidence is still required for runtime claims.

### CSS rules

- `css-modules/class-pattern` enforces kebab-case authored local classes; `.stack` and `.button-icon` are valid, while `.buttonIcon` is invalid. `:global(...)` classes are the supported external-integration exception. It does not validate generated camelCase declarations.
- `css-modules/no-palette-in-component` rejects recorded palette custom properties in component modules; semantic role variables are valid. It proves only references to palette declarations found in the configured palette files, not values hidden behind arbitrary custom-property indirection.
- `css-modules/no-raw-color-in-component` rejects named, hexadecimal, and recognized functional colors only in supported color-bearing longhands, shorthands, gradients, and box/text-shadow positions. `color: red` and `background: linear-gradient(red, #fff)` are invalid, while `animation-name: red`, `grid-area: tan`, and `font-family: black` are valid. `transparent`, `currentColor`, CSS system colors, custom properties, and unknown functions are not authored raw-color findings. Untyped custom properties and unsupported value grammars remain outside the proof.
- `css-modules/no-local-theme-selector` keeps the configured theme attribute in its recorded owner. A matching selector in that owner is valid; `[data-theme="dark"]` in a component module is invalid. It checks selector text only and does not prove that the owner maps every mode correctly.
- `css-modules/layer-by-profile` compares authored style rules with the exact configured layer ancestry. `@layer atoms { .root {} }` is valid for `atoms`; `@layer unexpected { @layer atoms { .root {} } }` is not. Dotted and nested names are equivalent only when their full identities match; anonymous layers are distinct. Keyframe steps are excluded from this rule.
- `css-modules/keyframes-layer-by-profile` applies the same exact ownership policy to named `@keyframes`/`@-webkit-keyframes` definitions and reports the definition at-rule. A definition in the expected layer is valid; a shared-module definition outside it is invalid. Keyframe steps are not DOM selectors and are not analyzed by descendant rules.
- `css-modules/no-descendant-type` rejects a bare type in a descendant compound, such as `.root h2`, while `.root h2.title` and `.root .title` are valid. Native nesting, `&`, selector-list pseudos, and nested group rules carry the same ownership relationship. A scoped `:global(.markdown)` injected-content boundary is the documented exception. Unparseable selectors are reported for manual review rather than silently passing.
- `css-modules/no-important` rejects `!important`; a documented narrow integration exception is valid. It does not judge cascade necessity or whether an unrelated global stylesheet contains the declaration.
- `css-modules/state-selector-shape` requires explicit ARIA values and presence selectors for private booleans: `[aria-pressed="true"]` and `[data-loading]` are valid, while `[aria-pressed]` and `[data-loading="true"]` are invalid. It does not infer state semantics from arbitrary attributes.

### Cross-file contract rules

- `css-modules/semantic-token-resolves` checks `var(--name)` in the shared color-value positions against declarations in recorded semantic files. Names do not need a `--color-` prefix; defined roles pass, missing roles in `color`, `background`, `border`, and shadow positions fail, private `--_*` references are ignored, and a fallback leaves the reference unproven rather than producing an unconditional missing-token error. The bounded parser excludes variables in explicit background position/size slots and gradient angle/position headers, while retaining variables in parsed gradient color-stop slots. A variable in an ambiguous first gradient slot or multi-token shorthand slot is left unproven; a sole `background: var(--role)` remains a supported color slot. Width/spacing positions and unrelated properties are valid. Arbitrary variable flow and unknown functions are not proven.
- `css-modules/shared-entry-export` requires each recorded export to resolve at runtime to its recorded CSS Module. Direct default re-exports, local imports/re-exports, and relative star barrels are supported; numeric values, another CSS Module, type-only exports, and missing runtime exports fail. Cycles, namespace exports/imports, external sources, and unresolved expressions become `uncertainties` instead of being certified or called missing.
- `css-modules/shared-public-class` compares the parsed classes in each recorded shared module with its `publicClasses` allowlist. A listed existing class passes; an unlisted or absent class fails. It does not infer whether a class should be promoted to the shared API.
- `css-modules/layer-ownership-ambiguous` reports a module matched by more than one ownership glob. A single matching glob or the selected local-module fallback is valid; the checker never guesses between overlapping owners. The finding is about profile ambiguity, not CSS precedence.
- `css-modules/composes-path-resolves` requires an external `composes ... from` path to resolve through the recorded style alias to a discovered module. A valid alias path passes; an outside or missing path fails. It does not execute the CSS Modules transformer.

The checker exposes unsupported export analysis as `uncertainties` and uses `status: "uncertain"` only when no warning or error finding exists. Uncertainty remains present alongside ordinary warnings; it exits successfully like other static limitations. `passed` means the supported checks found no violation, not exhaustive semantic proof.

## Judgment remains review work

The checker intentionally does not decide:

- whether two consumers are semantically related enough to share a class;
- whether a new public abstraction belongs in the project API;
- whether spacing or sizing values should use a scale;
- whether a local visual difference is desirable;
- which project boundary or composition strategy should be adopted.

The agent applies those decisions from the project profile and reports ambiguity. A linter must not silently turn a reference default into project architecture.
