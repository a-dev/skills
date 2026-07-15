# Skills

The canonical sources live under `skills/`, organized by domain. Each domain
can contain one or more related skill families.

## Catalog

### Frontend

#### CSS Modules

| Skill                                                             | Invocation                   | Purpose                                                                   |
| ----------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------- |
| [`css-modules-setup`](skills/frontend/css-modules-setup/SKILL.md) | manual                       | read-only audit plus explicit bootstrap, align, migrate, and verify modes |
| [`css-modules`](skills/frontend/css-modules/SKILL.md)             | model-invoked after adoption | profile-driven per-edit styling discipline                                |

Other domains and skill families belong alongside `frontend` as the
repository grows.

## Install skills

List all available skills before choosing one or more to install:

```sh
npx skills add a-dev/skills --list
```

### Frontend CSS Modules

An applied `css-modules-setup` plan creates two project-contract files:

```text
.agents/
  css-modules.json
  css-modules.schema.json
```

`css-modules.json` is the project configuration consumed by the skills and harness. `css-modules.schema.json` contains no project decisions and **is not a second configuration file**; it only describes the profile's allowed shape for editor validation, autocomplete, and generic JSON Schema tools. Setup copies the schema beside the profile so it works offline and remains available to collaborators regardless of their agent host or whether the skill is installed globally or in the project. Read-only `audit` and `verify` modes do not create either file.

Install both CSS Modules skills into the current project for a selected host:

```sh
npx skills add a-dev/skills \
  --skill css-modules-setup \
  --skill css-modules \
  --agent codex
```

Use `--agent claude-code` for Claude Code, and add `--global` for a user-level installation.

Host paths for the [`skills` CLI](https://github.com/vercel-labs/skills), catalog verification, the executable discovery check that rejects drifted or shadowing copies, and the shadow-copy rules live in [`adapters/hosts.md`](skills/frontend/css-modules-setup/adapters/hosts.md).

## Frontend CSS Modules harness

The [Vite + React adapter](skills/frontend/css-modules-setup/adapters/vite-react.md) is the tested reference. Other stacks need their own adapter and equivalent declaration, contract, build, and browser fixtures before they should be described as supported.

### Adoption flow

1. Install both skills into the project.
2. Invoke `css-modules-setup` in `audit` mode.
3. Review discovered choices and any ambiguity.
4. Select `bootstrap` for an undecided app or `align` for a compatible existing app.
5. Review the mutation plan before files change.
6. Verify `.agents/css-modules.json`, configured commands, and the disposable reference fixture.
7. Confirm a second setup dry-run proposes no changes.

Migration is separate and requires an explicit request. Audit and verification do not mutate source or configuration.

### Project contract

The generated profile records the selected application, aliases, helpers, shared API, layer topology, optional semantic color contract, and CSS-specific verification commands.

It does not prescribe spacing, sizing, typography, or shape scales. Project-specific systems remain project-owned.

The profile versions the portable methodology, JSON schema, and stack adapter separately. [`versions.json`](skills/frontend/css-modules-setup/versions.json) also records the skill package version and the adapter's minimum tested dependencies. Audit consumes that manifest and reports unsupported versions without rewriting them; version changes proceed only through an explicit migration plan.

### Mechanical checks

When a profile enables `enforcement`, setup bundles an ESLint/Stylelint/contract checker without replacing the project's lint configuration. A project can begin with warning severity, then promote the same stable rule IDs to errors.

```sh
node .agents/css-modules-harness/scripts/check.mjs \
  --root . \
  --run-declarations
```

That single CSS command runs the recorded declaration generator and CSS typecheck before TSX rules, CSS rules, and cross-file contract checks. Architectural judgment—shared admission, semantic coupling, visual quality, and project-owned spacing/sizing policy—remains review work.

### Read-only audit

From this repository, run:

```sh
node skills/frontend/css-modules-setup/scripts/audit.mjs \
  --root /path/to/project \
  --format human
```

The audit statically inspects files. It does not import Vite configuration, install packages, generate declarations, or write to the target project.

Use `--format json` for machine-readable output. Without `--check`, the audit is informational: it exits `0` whenever it completes and `2` only when it cannot run.

Add `--check` when CI runs the audit. It preserves the read-only behavior and turns the findings into the CI exit contract:

- `0`: aligned or only behavior remains to verify;
- `1`: missing or drifted configuration;
- `2`: ambiguity, invalid profile, or audit failure.

### Setup planner

The bundled planner exposes the five setup modes and prints a dry-run by default:

```sh
node skills/frontend/css-modules-setup/scripts/setup.mjs bootstrap \
  --root /path/to/project \
  --profile-source /path/to/project/selected-profile.json \
  --inputs /path/to/project/setup-inputs.json
```

Only `bootstrap`, `align`, and explicitly authorized `migrate` plans accept `--apply`. Existing files with different content are conflicts in bootstrap/align; migrate may replace only files shown in its reviewed plan and only while their content still matches the baseline.

### Development checks

Install the pinned development dependencies, then run the full CSS harness:

```sh
npm ci
npx playwright install chromium
npm run css:verify
```

For narrower loops, use `css:check`, `css:oxlint`, `css:audit-fixture`, `css:fixture`, or `css:browser`. The fixtures cover npm, pnpm, Yarn, and Bun; reference and differently named layer maps; Vite config variants; ownership, CI, and version drift; Codex and Claude Code discovery paths; duplicate installations; safe/idempotent setup; ESLint, Oxlint, Stylelint, and contract rules; declarations and TypeScript; alias composition; semantic colors; DOM state; accessibility behavior; and browser-computed cascade results.

Skill evaluation scenarios live under `evals/`. `evals/css-modules.json` is the machine-readable prompt contract, and `scripts/evaluate.mjs` scores recorded or live host responses by trigger and pressure category. Evaluation assets are author material and are not installed with the skills.
