# Resolved CSS Modules contract

The setup tools accept two authored formats and produce one in-memory contract. The authored file remains the source of intent; the resolved contract is generated, read-only output for setup, audit, checks, and review.

## Dispatch and provenance

`format: "css-modules-compact"` with `version: 1` dispatches the compact schema. A file without that discriminator dispatches the legacy schema (`profileSchemaVersion: 1`). Validation is schema-driven first, followed by cross-field checks. The resolver never reads or writes files.

Every resolved choice has one of these provenance labels:

- `explicit` — present in the authored profile;
- `discovered` — taken from explicit project facts supplied by the edge (app root, package manager, or package scripts);
- `preset` — derived from the pinned `vite-react@1` preset.

If an explicit choice disagrees with a discovered executable fact, the resolver retains the explicit value and returns a `drift` record. It does not silently replace either side. Multiple discovered application roots return `ambiguities` until `appRoot` is explicit.

`node scripts/contract.mjs --root <project> --format human` (or `setup.mjs show-config`) prints the generated profile, provenance, exact layer owners, commands, drift, and unverified parts. JSON output has the same information. This output is not an editable second configuration source.

## Field mapping

| Legacy field | Resolved equivalent | Compact authoring | Migration limit |
| --- | --- | --- | --- |
| `$schema` | schema metadata only | `$schema` pointing to `./css-modules-harness/assets/css-modules.compact.schema.json` | never compared as behavior |
| `methodologyVersion` | `profile.methodologyVersion` | pinned by `preset` | unsupported methodology is rejected |
| `profileSchemaVersion` | legacy schema compatibility | `version` | only supported schema versions migrate |
| `adapter.name`, `adapter.version` | resolved adapter metadata | pinned by `preset` | a non-preset adapter is field-specific unsupported |
| `appRoot` | resolved application root | explicit only when discovery is ambiguous/non-default | no root guessing among multiple apps |
| `stylesRoot` | `stylesRoot` | `styles.root` | retained exactly |
| `globalStylesheet` | `globalStylesheet` | derived as `<styles.root>/global.css`, or `styles.globalStylesheet` | retained exactly when overridden |
| `alias.bare` | `alias.bare` | `styles.alias` | retained exactly |
| `alias.subpath` | `alias.subpath` | derived as `<styles.alias>/*`, or `styles.subpath` | retained exactly when overridden |
| `helpers.classNames`, `helpers.cssVariables` | resolved helper bindings | preset `cx`/`cssVars`, with `helpers` overrides | retained exactly |
| `sharedApi.entryPoint` | resolved barrel path | derived as `<styles.root>/index.ts`, or `styles.entryPoint` | retained exactly |
| `sharedApi.modules[].name` | module identity | `sharedApi.modules[]` | retained exactly |
| `sharedApi.modules[].export` | runtime barrel export | `sharedApi.modules[]` | retained exactly; `null` stays `null` |
| `sharedApi.modules[].path` | CSS source path | `sharedApi.modules[]` | retained exactly |
| `sharedApi.modules[].layer` | exact layer identity | `sharedApi.modules[]` | retained exactly |
| `sharedApi.modules[].publicClasses` | frozen public class allowlist | `sharedApi.modules[]` | retained exactly; ordinary classes remain inferable when absent |
| `sharedApi.admissionRule.strategy` | shared-class admission policy | `sharedApi.admissionRule.strategy` | retained exactly |
| `sharedApi.admissionRule.document` | admission documentation | `sharedApi.admissionRule.document` | retained exactly |
| `layers.order` | ordered first-appearance contract | preset topology or `layers.order` | retained exactly |
| `layers.ownership[]` | exact-one path owner map | derived from `styles.root`, or `layers.ownership` | overlap remains ambiguous; no precedence invention |
| `layers.localModules.strategy/layer/document` | unmatched-module fallback | preset, or `layers.localModules` | retained exactly |
| `layers.importantPolicy` | project policy text | `layers.importantPolicy` | retained exactly |
| `composition.mode` | composition policy | `composition` string | retained exactly |
| `composition.rule` | mixed composition rule | `compositionRule` | retained exactly |
| `colorTokens.enabled` | color capability | `colors: false` or an enabled `colors` object | disabled/enabled state is preserved |
| `colorTokens.paletteFiles` | palette sources | `colors.paletteFiles` | all files retained |
| `colorTokens.semanticFiles` | semantic sources | `colors.semanticFiles` | all files retained |
| `colorTokens.themeOwner`, `themeAttribute`, `modes` | theme ownership and labels | corresponding `colors` fields | retained exactly |
| none (discovered) | `lintEngine`: explicit, else the project's Oxlint/ESLint setup, else `eslint` | optional `lintEngine` | both sides resolve through the same discovery |
| `colorTokens.modeMapping` | lossless custom-mode-to-CSS-scheme map | `colors.modeMapping` | every mapping is retained; unsupported values reject |
| `commands` | actual runnable command map | discovered package scripts, or explicit `commands` overrides | absent scripts remain absent; commands are never invented |
| `runtimeVerification.entry` | verification guidance | `runtimeVerification.entry` | guidance is not execution evidence |
| `runtimeVerification.themes`, `viewports`, `interactions`, `states`, `preferences`, `directions` | verification dimensions | same object fields | retained exactly; unexecuted dimensions stay unverified |
| `enforcement.severity` | checker severity | `checks: off`, `warn`, or `error` | `off` removes enforcement |
| `enforcement.privateBooleanAttributes` | private state attributes | `enforcement.privateBooleanAttributes` | retained exactly |
| `exceptions[].kind/scope/rule/match/reason` | narrow suppression records | `exceptions[]` | retained exactly; stale matches remain reportable |
| `extensions` | project-owned extension data | `extensions` | copied without interpretation |

## Ownership and consumers

`resolveLayerOwner` is authoritative. It returns exactly one matching glob, the selected local-module fallback, `ambiguous` for overlapping globs, or `undecided` for a custom fallback. Shared API interpretation likewise returns the configured helpers, public alias and entry point sources, runtime exports, and module identities. Audit, setup, ESLint, Oxlint, and cross-file checks consume this result instead of implementing independent fallback or helper-name rules.

The default compact preset has `reset, base, atoms, ui` order, an atoms glob under `styles.root`, a ui glob beside it, unlayered local modules, and no shared modules. A compact bootstrap can therefore create helpers, an empty barrel, and global layer setup before any visual class exists. When a real module is later admitted, ordinary public classes are discovered; a `publicClasses` list remains an exact frozen allowlist.

## Migration and evidence limits

Legacy-to-compact conversion is explicit: `setup.mjs migrate --authorize-migrate --to compact`. The planner constructs a candidate, resolves both sides, and compares the resolved profiles before any write. A difference becomes a field-specific unsupported diagnostic; no lossy candidate is applied. Custom topology, helper names, entry point, all color files and `modeMapping`, command overrides, documents, exceptions, and frozen classes are preserved. The candidate points `$schema` into the harness assets, and any old schema copy beside the profile is deleted in the same plan. A second run is `already-compact` with no changes. Audit, align, daily checks, and show-config never migrate implicitly.

The resolved profile is an in-memory result. Generated declarations and maps remain verification effects, distinct from authored source/config edits. Static audit limits—alias resolution, dynamic Vite configuration, type freshness, and runtime behavior—remain `not-verifiable` evidence with follow-up commands; they are not converted into proof by normalization.
