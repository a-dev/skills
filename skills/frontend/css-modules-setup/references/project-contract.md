# Project contract and templates

Load this reference when creating or updating `.agents/css-modules.json`.

## Source of truth

The authored profile records decisions that agents cannot safely infer on every task. Executable configuration remains authoritative for runtime behavior. Legacy and compact inputs both pass through `scripts/contract.mjs` and produce one in-memory contract; the resolved output is generated and read-only.

Compact input is identified by `format: "css-modules-compact"` and `version: 1`. The pinned `vite-react@1` preset supplies methodology/adapter metadata, helpers, baseline layers, and path derivations. The compact example intentionally permits an empty `sharedApi.modules` list. See `resolved-contract.md` for the complete mapping.

When the two disagree, report drift. Do not rewrite either side during audit.

## Required project choices

The generic schema records:

- application and styles roots;
- global stylesheet and shared entry point;
- alias and helper names;
- shared modules and admission rule;
- layer order, ownership, and local-module strategy;
- composition policy;
- optional semantic color contract;
- CSS-specific verification commands and runtime cases;
- narrow integration exceptions.

It deliberately does not define spacing, sizing, typography, or shape scales.

The command surface is deliberately narrow:

- `css:generate` generates CSS Module declarations;
- `css:types` runs the TypeScript check that validates those declarations;
- `css:check` optionally runs CSS-specific lint or contract checks;
- `css:verify` optionally runs a CSS-specific fixture or runtime check.

Compact commands are optional. Setup derives a command only when a same-named package script and package-manager metadata are discovered; explicit `commands` values override discovery. Missing scripts remain absent and unverified. `setup.mjs show-config` and `scripts/contract.mjs` expose commands and provenance without writing.

`css:check` is the preferred aggregate entry when it is recorded: `check.mjs --run-declarations` runs declaration generation and typechecking once, then the static checks. Its execution report distinguishes authored source/config edits (none) from generated declaration outputs. A relevant existing project build or component test remains an agent-owned integration step; the generic planner does not merge arbitrary Vite, TypeScript, package, or CI configuration.

Do not record generic application `lint`, `test`, `build`, or `dev` commands. A project may use a broad TypeScript command behind `css:types` when that is the only way it validates generated declarations.

## Shared boundaries

Preserve a coherent existing shared API. Compact bootstrap starts with no shared modules; add a real module through `sharedApi.modules` or a later explicit admission decision. Do not invent empty classes. Existing projects may retain, remove, rename, combine, or split their modules.

An atom is any reusable class published through the selected shared API. It may have one declaration or several related declarations.

Record an admission strategy:

- `project-review`: project review decides;
- `second-semantic-consumer`: require two consumers sharing one reason to change;
- `explicit`: follow a named repository document.

## Layer topology

The audit compares the selected order with first appearances in CSS evidence, not with a later repeated declaration. It parses the global stylesheet, named blocks/statements, and literal local imports in effective order while ignoring comments. External, conditional, cyclic, unreadable, or invalidly placed imports are reported as not-verifiable. An anonymous layer does not make a nested named layer a top-level layer.

Layer names and modules are separate. Several shared modules may belong to one layer.

The checker uses exact layer identity. A dotted name such as `atoms.compound` and nested blocks `@layer atoms { @layer compound { ... } }` describe the same identity, but neither is silently collapsed to the parent `atoms`. An anonymous layer is recorded as an anonymous ancestry segment and never satisfies a named layer. The selected ownership policy is exact for both style rules and named animation definitions: shared keyframes must be in their recorded layer, while local unlayered modules may keep unlayered keyframes. Keyframe steps are not DOM style rules and are checked by the dedicated `css-modules/keyframes-layer-by-profile` diagnostic.

The reference proposal is:

```css
@layer reset, base, atoms, ui;
```

Record:

- the complete order;
- ownership globs;
- local module strategy;
- any documented `!important` exception.

Layer ownership resolves by file path. Exactly one matching ownership glob selects its layer. More than one match is ambiguous. When no glob matches, `layers.localModules` is the fallback:

- `unlayered` requires the module's rules to remain outside `@layer`;
- `profiled` assigns `localModules.layer` to every unmatched CSS Module;
- `custom` delegates to `localModules.document`.

Scoped ownership and the fallback may intentionally select the same layer. The path rule remains unchanged: an ownership match wins, and only unmatched modules use the fallback. When more than one glob matches, audit reports the module as `ambiguous` and the checker reports `css-modules/layer-ownership-ambiguous`; neither falls back to the local-module strategy, because that would assert a layer the profile never selected.

## Template rules

Files under `assets/templates/` contain placeholders. Resolve every placeholder from discovered or selected values before creating a project file.

Treat any remaining `{{PLACEHOLDER}}` as a setup failure. Render placeholders from these profile decisions:

- `LAYER_ORDER` and `SHARED_LAYER` come from `layers`; the color import and `color-scheme` blocks use the reviewed `colorLayer` input;
- `CLASS_HELPER` and `CSS_VARIABLE_HELPER` come from `helpers`;
- `SHARED_EXPORTS` comes from `sharedApi.modules`;
- `CLASS_NAME` and `DECLARATIONS` come from the reviewed `sharedModules` input;
- `PALETTE_TOKENS` and `SEMANTIC_COLOR_TOKENS` require developer-provided color values.

When `colorTokens.enabled` is false, render `COLOR_IMPORTS` and `COLOR_SCHEME_BLOCK` as empty strings. Do not create the palette or colors files.

When it is true, `COLOR_SCHEME_BLOCK` must use the selected base layer, `colorTokens.themeAttribute`, and the recorded modes. Built-in modes map as `system → light dark`, `light → light`, and `dark → dark`; a light-only mode produces a light base scheme. Existing custom mode labels require `colorTokens.modeMapping` with one of `light`, `dark`, or `light dark`, and are never emitted as arbitrary `color-scheme` values. Semantic tokens must map palette values to roles; component modules consume the roles, never the palette.

The reference component is not a template. It lives in `fixtures/vite-react/` as adapter evidence, and `references/reference-fixture.md` explains why it is never copied into a target application.

Do not create optional modules to make the reference map appear complete. Create only the selected modules and exports.

Color templates apply only when `colorTokens.enabled` is true. Palette values require project input; never invent a brand palette silently.

## Runtime export provenance

When enforcement is enabled, `sharedApi.modules[].export` is a runtime CSS-module contract, not just a name in a barrel. The bundled checker follows direct default CSS-module re-exports, local imported bindings, and relative `export *` barrels. A proven wrong value, wrong module, or type-only export is a violation. External imports, namespace values, cycles, and unresolved expressions are reported as analysis uncertainty; no finding is treated as proof in those cases.

The TSX rules run on one lint engine, resolved as the explicit compact `lintEngine`, otherwise the linter the project already runs (Oxlint or ESLint config files and package scripts, then dependencies), otherwise ESLint. An Oxlint project gets `oxlint` and `oxc-parser` and no ESLint or Babel packages; an ESLint project gets `eslint`, `@babel/eslint-parser`, and `@babel/core`. Stylelint and the cross-file checks run with either engine.

## Profile validation

Copy the schema for the profile's format beside the project profile so editors can resolve it. The installed harness carries its own copy of the canonical legacy schema under `.agents/css-modules-harness/assets/`, so a compact project needs no `.agents/css-modules.schema.json`.

The audit validates required shape without executing application code. Behavioral verification remains a separate explicit action.

Setup preflights normalized destinations and canonicalizes existing parent paths before mutation. A symlink whose resolved parent remains inside the target root is allowed; an escaping parent, duplicate destination, or changed preimage blocks the write set. This is not transactional or adversarial race protection: a filesystem change after preflight can still produce a partial apply, which reports touched files.

If the methodology, schema, or adapter version differs from the supported version, read `references/migrations.md`. Audit reports the mismatch; only explicit `migrate` mode may rewrite the profile or executable configuration.
