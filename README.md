# Skills

Agent skills and scripts that test their behavior. Sources live under `skills/`, grouped by domain.

## Catalog

### Frontend

#### CSS Modules

Background article: [Atoms, layers, types, tokens: a new CSS methodology built on CSS Modules](https://dev.to/a-dev/atoms-layers-types-tokens-a-new-css-methodology-built-on-css-modules-35ke)

| Skill                                                             | Invocation                   | Purpose                                                                   |
| ----------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------- |
| [`css-modules-setup`](skills/frontend/css-modules-setup/SKILL.md) | manual                       | read-only audit plus explicit bootstrap, align, migrate, and verify modes |
| [`css-modules`](skills/frontend/css-modules/SKILL.md)             | model-invoked after adoption | styling edits guided by the project profile                                |

## Install skills

List the available skills:

```sh
npx skills add a-dev/skills --list
```

### Frontend CSS Modules

`css-modules-setup` creates a project profile and installs its schemas in the harness folder when you apply the plan:

```text
.agents/
  css-modules.json
  css-modules-harness/
    assets/
      css-modules.compact.schema.json  # compact profile
      css-modules.schema.json          # legacy profile
```

`css-modules.json` records your project decisions in the compact `css-modules-compact` format or the supported legacy format. Edit this file; the skills and harness read it.

The schemas define the profile structure for editor validation and autocomplete. Setup installs both in `css-modules-harness/assets/`, even with checks off, and points the profile's `$schema` at the matching file. Editors can read these files offline. The audit and checker read the schemas bundled with their own scripts, regardless of the profile's `$schema` value. `show-config` displays the resolved contract without writing it.

`audit` and `verify` do not write the profile or schemas.

[`adapters/hosts.md`](skills/frontend/css-modules-setup/adapters/hosts.md) lists where each host keeps its skills, for the [`skills` CLI](https://github.com/vercel-labs/skills). It also covers catalog verification, the shadow-copy rules, and the discovery check that rejects a copy once it drifts or shadows another install.

## Frontend CSS Modules harness

Vite plus React (TanStack Start included) is the only stack with a [tested adapter](skills/frontend/css-modules-setup/adapters/vite-react.md). The methodology is portable. The adapter uses the Vite plugin `patchCssModules` for generated declarations. A non-Vite bundler such as Next.js needs a separate adapter with declaration, contract, build, and browser fixtures.

### Adoption flow

1. Install both skills into the project.
2. Invoke `css-modules-setup` in `audit` mode.
3. Review discovered choices and any ambiguity.
4. Select `bootstrap` for an undecided app or `align` for a compatible existing app.
5. Review the mutation plan before files change.
6. Verify `.agents/css-modules.json`, configured commands, the real generated-project scenarios, and the disposable reference fixture.
7. Confirm a second setup dry run proposes no changes.

Migration requires an explicit request. Audit and verification leave authored source and configuration unchanged.

### Project contract

Setup creates a profile for one app, and subsequent styling edits follow it. The profile records aliases, helpers, the shared API, layer topology, optional semantic colors, and the project's CSS verification commands.

The profile does not define spacing, sizing, typography, or shape scales. Existing project conventions govern those choices.

The profile versions three contracts separately: the portable methodology, the JSON schema, and the stack adapter. [`versions.json`](skills/frontend/css-modules-setup/versions.json) adds the skill package version and the oldest dependency versions the adapter was tested against. Audit reads that manifest and reports an unsupported version without rewriting it. Version changes require an explicitly requested migration plan.

### Mechanical checks

Turn on `enforcement` in the profile and setup installs a checker that runs ESLint, Stylelint, and the contract rules. The checker preserves your existing lint configuration.

```sh
node .agents/css-modules-harness/scripts/check.mjs \
  --root . \
  --run-declarations
```

The command runs these checks in order: the recorded declaration generator, the CSS typecheck, the TSX rules, the CSS rules, and the contract checks that span files.

You can start every rule at warning severity and promote them to errors when the project is ready. Rule IDs never change, so that promotion edits severity and nothing else.

Review still determines which styles belong in the shared API, which semantics should be coupled, whether the page looks right, and which spacing policy to use.

### Read-only audit

From this repository, run:

```sh
node skills/frontend/css-modules-setup/scripts/audit.mjs \
  --root /path/to/project \
  --format human
```

The audit only inspects files. It does not import Vite configuration, install packages, generate declarations, or write anything to the target project.

Use `--format json` for machine-readable output. Without `--check`, the audit just reports. It exits `0` whenever it finishes and `2` only when it cannot run at all.

Add `--check` when CI runs the audit. It stays read-only and turns the findings into exit codes:

- `0`: aligned, or only behavior remains to verify;
- `1`: missing or drifted configuration;
- `2`: ambiguity, invalid profile, or audit failure.

### Setup planner

The bundled planner supports `audit`, `bootstrap`, `align`, `migrate`, `verify`, and `show-config`. It prints a dry run by default; writes require explicit flags.

```sh
node skills/frontend/css-modules-setup/scripts/setup.mjs bootstrap \
  --root /path/to/project \
  --profile-source /path/to/project/selected-profile.json \
  --inputs /path/to/project/setup-inputs.json
```

Only `bootstrap`, `align`, and an explicitly authorized `migrate` plan accept `--apply`. In bootstrap and align, an existing file with different content counts as a conflict. Migrate can replace only the files listed in its reviewed plan, and only while their content still matches the baseline.

### Development checks

Use these commands when developing this repository. Projects using the skills do not need them.

Install the pinned development dependencies, then run everything:

```sh
npm ci
npx playwright install chromium
npm run css:verify
```

For narrower loops, use `css:check`, `css:oxlint`, `css:audit-fixture`, `css:eval:fixtures`, `css:evaluate`, `css:eval:grader`, `css:eval:run`, `css:fixture`, or `css:browser`.

The fixtures cover:

- npm, pnpm, Yarn, and Bun
- Vite config variants, plus layer maps that use the reference names and layer maps that rename them
- Codex and Claude Code discovery paths, duplicate installs, ownership, CI, and version drift
- safe repeated setup
- ESLint, Oxlint, Stylelint, and the contract rules
- declarations, TypeScript, alias composition, and semantic colors
- DOM state, accessibility behavior, and the cascade as Chromium computes it

Evaluation scenarios live under `evals/`. `evals/css-modules.json` and `scripts/evaluate.mjs` are deterministic scorer tests over checked-in sample responses; their pass count does not measure whether models follow the skills. Behavioral cases, immutable task blueprints, run-record schema/template, fixture preparation, and artifact-based grading live under `evals/cases`, `evals/fixtures`, and `scripts/grade-evaluation.mjs`. Live comparison evidence is a separate, explicitly authorized Task 31 workflow and is currently pending; CI never invokes models.
