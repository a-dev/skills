---
name: css-modules-setup
description: Audit, bootstrap, align, migrate, or verify the typed CSS Modules methodology in a project.
disable-model-invocation: true
---

# Typed CSS Modules setup and alignment

Invoke this skill manually to install or verify the configuration used by the model-invoked `css-modules` skill.

The Vite + React adapter is the tested reference. The shared API, layer topology, visual values, and CSS-specific verification commands belong to the project. Read `references/resolved-contract.md` for the legacy-to-resolved field map.

Use the compact, versioned format for new profiles:

```json
{
  "$schema": "./css-modules.compact.schema.json",
  "format": "css-modules-compact",
  "version": 1,
  "preset": "vite-react@1",
  "styles": { "root": "src/shared/styles", "alias": "#styles" },
  "composition": "markup",
  "colors": false,
  "checks": "warn"
}
```

The preset derives the entry point, global stylesheet, `#styles/*` subpath, helpers, and baseline layers. It derives commands only from actual package scripts and package-manager metadata; absent commands stay absent. Advanced fields preserve custom topology, helper names, multiple color files and `modeMapping`, composition rules, documents, exceptions, and frozen classes. Legacy profiles remain supported and resolve to the same in-memory contract.

## Choose a mode

The plan reports mutation, compatibility, and verification status separately. A plan with no file actions may still be incompatible. Compatibility blockers prevent writes.

Every run starts with `audit`, then proceeds only into the mode the user requested.

| Mode          | Purpose                                            | Mutation contract                                                                                                           |
| ------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `audit`       | discover the project and report alignment          | never writes                                                                                                                |
| `bootstrap`   | create a selected baseline in an undecided project | writes after a plan is accepted                                                                                             |
| `align`       | fill safe gaps around compatible choices           | preserves compatible alternatives                                                                                           |
| `migrate`     | replace an incompatible convention                 | requires an explicit migration request                                                                                      |
| `verify`      | run behavioral checks and disposable fixtures      | does not edit authored source/config; declared generated outputs may be written in a disposable or approved output location |
| `show-config` | print resolved choices and provenance              | read-only; never writes                                                                                                     |

A generic "set this up" request authorizes `bootstrap` or `align`, not `migrate`. Inspection, audit, and verification requests never authorize mutation.

Use the bundled setup planner for a deterministic plan:

```sh
node <css-modules-setup-skill>/scripts/setup.mjs <mode> \
  --root <project-root> \
  --format human
```

The planner is read-only by default. `bootstrap`, `align`, and `migrate` accept `--apply` only after the printed plan is reviewed. `migrate` additionally requires `--authorize-migrate`; `audit` and `verify` reject `--apply`. Verify may plan declaration generation in a disposable or approved location. The planner never executes those commands.

For a read-only resolved view, run `show-config`:

```sh
node <css-modules-setup-skill>/scripts/setup.mjs show-config \
  --root <project-root> --format human
```

## Step 1: audit the project

The audit recognizes directly exported Vite objects, defineConfig calls imported from vite, and simple arrow-returned objects. It cannot verify spreads, imported fragments, unresolved factories, or namespace bindings. CI checks recognize direct run steps in the same job.

Read `references/discovery.md`. The bundled audit discovers the package manager, application roots, aliases, helpers, shared modules, layers, color files, CSS-specific commands, CI ordering, and version drift. Also record repository instructions, pre-existing command failures, and dirty files.

Run the bundled audit when available:

```sh
node <css-modules-setup-skill>/scripts/audit.mjs \
  --root <project-root> \
  --format human \
  --check
```

The audit parses files but never imports executable Vite or application configuration. A check that cannot be proven statically reports `not-verifiable` with a follow-up command.

Complete when one application target is selected, every finding has a status, and the target worktree is unchanged.

## Step 2: resolve missing choices

Preserve a coherent existing project contract.

Ask only when the repository cannot answer safely, including:

- multiple plausible application roots;
- conflicting layer-order declarations;
- competing shared-style entry points;
- incompatible aliases or helpers;
- missing color values when the user selected the color-token contract;
- a requested migration with more than one valid destination.

For an undecided greenfield project, the compact preset starts with these choices:

- styles root: `src/shared/styles`;
- alias: `#styles` with bare and subpath resolution;
- helpers: `cx` and `cssVars`;
- shared modules: empty until a real reusable style is admitted;
- layer topology: `reset, base, atoms, ui`;
- local component modules: unlayered;
- composition: markup.

Every item is editable. Module categories and cascade layers are separate decisions; several modules may belong to one layer.

Use `sharedApi.modules` for an existing API or an intentional first module. Ordinary public classes are inferred when no frozen `publicClasses` list is selected; a list remains exact.

Do not ask for or create a spacing, sizing, typography, or shape scale. Preserve such systems when the project already defines them.

Complete when all decisions required for the requested mode are either discovered or explicitly selected.

## Step 3: print the change plan

The human and JSON plans include the audit findings, compatibility blockers, selected application and package manager, file actions, dependencies, commands, and outstanding integration steps. Replacement actions include their exact before/after content.

Before writing, print:

- target application and package manager;
- mode;
- files to create and modify;
- dependencies and CSS-harness package scripts to add;
- configuration merges;
- preserved compatible alternatives;
- CSS-harness commands that will run;
- explicit non-goals.

In `audit` and `verify`, print the plan as a report and do not offer automatic edits.

Complete when the user can see the entire write set before mutation begins.

## Step 4: apply the configuration

Alignment and bootstrap stop on blocking compatibility findings. Apply only supported, explicitly requested migrations. Report unsupported migrations.

For Vite + React, read `adapters/vite-react.md`. For profile and template semantics, read `references/project-contract.md`.

If audit reports a version mismatch, read `references/migrations.md`. Do not update versions or configuration outside explicit `migrate` mode.

Rules:

- use the detected package manager and workspace syntax;
- never create a second lockfile;
- handle Vite, TypeScript, package, and CI integration explicitly; the planner does not replace those files or provide a general-purpose merge;
- preserve plugins, aliases, CSS options, lifecycle scripts, and user choices;
- never replace an existing `prepare` command;
- do not overwrite a present file in `bootstrap` or `align`;
- stop on incompatible drift unless `migrate` was explicitly selected;
- report each touched file immediately if a later phase fails.

When the selected profile enables `enforcement`, read `references/mechanical-enforcement.md`. The TSX rules run on one lint engine, resolved as the explicit compact `lintEngine`, otherwise the linter the project already runs (Oxlint or ESLint config files and package scripts, then dependencies), otherwise ESLint. An Oxlint project gets `oxlint` and `oxc-parser` and no ESLint or Babel packages; an ESLint project gets `eslint`, `@babel/eslint-parser`, and `@babel/core`. Stylelint and the cross-file checks run with either engine.

Use the files under `assets/templates/` as parameterized source material through `scripts/setup.mjs`. In `bootstrap`, pass the developer-reviewed values with `--inputs <json-path>`. An unresolved required input returns `needs-input`; it never becomes an empty class or invented visual value.

The palette and semantic color templates apply only when the developer selects the article's color contract. Visual values require project input.

Complete when every planned change is applied, every unplanned conflict stops the run, and no unrelated file changes. The plan prints the remaining agent-owned integration steps.

## Step 5: write the project contract

Use the setup planner to copy the selected schema beside `.agents/css-modules.json` and create that authored file from the reviewed input. Compact profiles receive `css-modules.compact.schema.json`; legacy profiles receive `css-modules.schema.json`. A compact project does not keep the legacy schema copy: `align` reports a leftover one as a conflict, and `migrate` deletes it.

The authored profile records decisions the daily skill cannot safely rediscover. All consumers use the same resolved in-memory profile. Executable configuration remains authoritative. Do not edit show-config output.

Do not add fields for generic spacing or sizing scales. A project-specific extension may document them outside the generic schema.

Validate the profile with:

```sh
node <css-modules-setup-skill>/scripts/audit.mjs \
  --root <project-root> \
  --format json
```

Complete when the profile validates, describes the selected app, and agrees with executable configuration.

## Step 6: verify the setup

setup.mjs prints planned commands without executing them. Run them separately and record the results before claiming verification. Verification leaves authored source and configuration unchanged. Generated declarations and maps must be disposable or explicitly approved.

Run:

1. the recorded aggregate `css:check --run-declarations` when available; it runs generation and typechecking once and reports generated outputs separately;
2. otherwise `commands["css:generate"]` followed by `commands["css:types"]`, which proves generated class-key access through TypeScript;
3. `commands["css:check"]`, when the project records a CSS-specific static check;
4. `commands["css:verify"]`, or the bundled disposable reference fixture, when recorded;
5. the read-only audit and setup dry-run again.

Record `css:check` as the bundled `check.mjs --run-declarations` invocation from `references/mechanical-enforcement.md`, so declarations, CSS typing, the selected TSX lint engine, Stylelint, and cross-file contracts have one ordered entry point. Existing projects may record `enforcement.severity` as `warning` before promoting it to `error`. Do not run separate generation/typechecking commands after that aggregate unless a failure requires a focused reproduction.

Read `references/reference-fixture.md` when the selected project has no existing CSS-specific runtime fixture or when validating changes to this harness itself.

Do not add generic application commands to the profile. A narrowly relevant existing build, preview, component test, or package/type command is agent-owned and permitted when needed to verify aliases, external composition, or production CSS behavior; report unrelated failures separately.

Do not restyle an existing production component as a smoke test.

Verification should prove:

- bare and subpath aliases resolve;
- external `composes` builds when selected;
- generated declarations reject invalid class keys;
- the selected layer precedence works in a browser when runnable;
- semantic colors switch with `color-scheme` when enabled;
- native, ARIA, and private state render as expected.

Complete when commands pass or introduced failures are isolated, runtime claims have evidence, generated outputs are identified, authored files remain unchanged by verify, and a second setup run proposes no changes.

## Practical walkthroughs

Inspect, review, apply, then verify. Complete package installation and Vite, TypeScript, package, and CI integration yourself; the planner does not install packages or merge existing integration files.

### Minimal compact start

1. Put the versioned compact example in `compact-profile.json`, then inspect:

   ```sh
   node <css-modules-setup-skill>/scripts/audit.mjs \
     --root <project-root> --format human --check
   ```

2. Review the no-write plan. For a new Vite + React target, use `bootstrap` with `--profile-source compact-profile.json`. With `sharedApi.modules` omitted and `colors: false`, it needs no template values and creates helpers, a usable empty barrel, global layer setup, and verification configuration without a placeholder class.

3. Apply only after reviewing the exact write set:

   ```sh
   node <css-modules-setup-skill>/scripts/setup.mjs bootstrap \
     --root <project-root> --profile-source compact-profile.json \
     --format human --apply
   ```

4. Complete the printed agent-owned Vite/TypeScript/package integration, then inspect the resolved result with `show-config`. Run the actual recorded generation/typecheck command, the bundled `check.mjs --run-declarations` when enforcement is enabled, the relevant build, and a final read-only audit. Generated declarations/maps are reported separately from authored edits.

### Admit the first shared module later

When project review identifies the first reusable style, add it in a scoped edit:

1. Add its `name`, optional `export`, CSS `path`, and resolved `layer` to `sharedApi.modules` in the authored compact profile (normally `.agents/css-modules.json`). Keep the selected `sharedApi.admissionRule`, such as `project-review`.
2. Author the real `.module.css` file, publish it from the existing shared entry point, and update the intended consumer. Review these module, barrel, and consumer edits explicitly; `align` does not generate their contents.
3. Run `align` to validate the updated profile and write set, then run the recorded `css:generate` and `css:types` commands, the relevant build, and the bundled source checker. The generated declaration exposes the ordinary public classes when `publicClasses` is omitted.
4. Add `publicClasses` only when the project wants a frozen API. The checker then rejects both an authored class not on the list and a listed class removed from the module with `css-modules/shared-public-class`.

### Advanced choices and migration

Add `helpers`, `layers`, `sharedApi.modules`, `styles.entryPoint`, `styles.globalStylesheet`, `runtimeVerification`, `exceptions`, or `enforcement` only when the project needs them. An enabled `colors` object must name every palette/semantic file, theme owner, attribute, mode, and custom `modeMapping`; values are supplied through reviewed `--inputs` data. Set `lintEngine` only to override the discovered engine, for example `"oxlint"` in a project with no linter yet or in one that runs both linters.

For an existing legacy profile, first inspect and review the migration candidate. Apply only this explicit command:

```sh
node <css-modules-setup-skill>/scripts/setup.mjs migrate \
  --root <project-root> --to compact --authorize-migrate \
  --format human --apply
```

The planner compares legacy and compact resolved profiles before writing. It preserves topology, helper and barrel paths, module exports/classes, all color files and `modeMapping`, command overrides, documents, exceptions, and composition policy. A lossy field produces a field-specific blocker and no writes. The same migration deletes the now-unused `.agents/css-modules.schema.json`, and, after a switch from Oxlint to ESLint, the unused Oxlint adapter files; each deletion is shown in the plan and refused if the file changed after planning. `audit`, `align`, daily checks, and `show-config` never migrate.

Read `references/resolved-contract.md` for the complete field map, provenance labels, exact-one-owner rule, and static evidence limits. Read `adapters/vite-react.md` for the narrow integration steps required to make aliases, declaration generation, and production builds executable.

## Step 7: report results and recovery steps

Report:

- selected mode and application;
- created and modified files;
- preserved alternatives;
- CSS-harness commands and results;
- runtime cases verified;
- `not-verifiable` cases;
- pre-existing versus introduced failures;
- scoped rollback instructions for touched files.

On partial failure, do not erase successful user-owned changes. Name the last completed phase and every touched file.

Complete when the user can reproduce verification and reverse only this setup's changes if needed.

## CLI exit codes

| Code | Meaning                                                                             |
| ---- | ----------------------------------------------------------------------------------- |
| 0    | Valid plan; static uncertainty may remain and is shown with follow-up commands      |
| 1    | Actionable incompatibility, including an unsupported version or blocked apply       |
| 2    | Invalid input, ambiguous target, file conflict, or missing required developer input |

audit.mjs --check and setup.mjs --check use the same aligned, missing, drifted, ambiguous contract. Static uncertainty alone remains exit 0; it is not runtime success. A second dry-run with missing infrastructure is reported as compatibility missing, not full alignment.

## Compatibility taxonomy

| Status                   | Meaning                                                    |
| ------------------------ | ---------------------------------------------------------- |
| `aligned`                | matches the portable contract and recorded project choices |
| `missing`                | a required selected capability is absent                   |
| `drifted`                | executable configuration conflicts with the profile        |
| `ambiguous`              | multiple valid owners or targets exist                     |
| `not-verifiable`         | static inspection cannot prove behavior safely             |
| `compatible-alternative` | different implementation with verified equivalent behavior |

## Completion

Complete setup when the project contract is explicit, configuration and profile agree, verification has run, and a second dry run proposes no changes or compatibility blockers. Do not use production components as test fixtures or migrate without authorization.
