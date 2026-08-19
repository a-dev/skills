# Skills

Agent skills, plus the scripts that keep them honest. Sources live under `skills/`, grouped by domain.

## Catalog

### Frontend

#### CSS Modules

Read the article: [Atoms, layers, types, tokens: a new CSS methodology built on CSS Modules](https://dev.to/a-dev/atoms-layers-types-tokens-a-new-css-methodology-built-on-css-modules-35ke)

| Skill                                                             | Invocation                   | Purpose                                                                   |
| ----------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------- |
| [`css-modules-setup`](skills/frontend/css-modules-setup/SKILL.md) | manual                       | read-only audit plus explicit bootstrap, align, migrate, and verify modes |
| [`css-modules`](skills/frontend/css-modules/SKILL.md)             | model-invoked after adoption | profile-driven per-edit styling discipline                                |

## Install skills

See what is in here before installing anything:

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

`css-modules.json` holds your decisions. It is the file you edit, and the one the skills and the harness read.

`css-modules.schema.json` holds no decisions at all. It describes what a valid profile looks like, so your editor can check the file, autocomplete the keys, and catch a typo before a script hits it. Any JSON Schema tool can read it too. Setup copies it next to the profile so it works offline and travels with the repo, whatever agent host your teammates run and however they installed the skill.

`audit` and `verify` write neither file. Both are read-only.

[`adapters/hosts.md`](skills/frontend/css-modules-setup/adapters/hosts.md) lists where each host keeps its skills, for the [`skills` CLI](https://github.com/vercel-labs/skills). It also covers catalog verification, the shadow-copy rules, and the discovery check that rejects a copy once it drifts or shadows another install.

## Frontend CSS Modules harness

Vite plus React (Next.js, TanStack Start included) is the only stack with a [tested adapter](skills/frontend/css-modules-setup/adapters/vite-react.md). Anything else needs its own adapter and its own declaration, contract, build, and browser fixtures before it earns the word supported.

### Adoption flow

1. Install both skills into the project.
2. Invoke `css-modules-setup` in `audit` mode.
3. Review discovered choices and any ambiguity.
4. Select `bootstrap` for an undecided app or `align` for a compatible existing app.
5. Review the mutation plan before files change.
6. Verify `.agents/css-modules.json`, configured commands, and the disposable reference fixture.
7. Confirm a second setup dry run proposes no changes.

Migration is a separate step and runs only when you ask for it. Audit and verification never touch source or configuration. Splitting them that way is the whole point. You get to look before anything moves.

### Project contract

Setup writes the profile once. Every styling edit after that obeys it.

The profile covers one app. It records the aliases and helpers that app uses, its shared API, its layer topology, and a semantic color contract if you want one. It also stores the commands that verify your CSS, so the harness runs your checks instead of a default guess.

It says nothing about spacing, sizing, typography, or shape scales. Those are yours. A skill has no business inventing your design system.

Three things in the profile carry their own version number: the portable methodology, the JSON schema, and the stack adapter. [`versions.json`](skills/frontend/css-modules-setup/versions.json) adds the skill package version and the oldest dependency versions the adapter was tested against. Audit reads that manifest and reports an unsupported version without rewriting it. Versions move only through a migration plan you asked for.

### Mechanical checks

Turn on `enforcement` in the profile and setup installs a checker that runs ESLint, Stylelint, and the contract rules. It sits next to your lint configuration. It does not replace it.

```sh
node .agents/css-modules-harness/scripts/check.mjs \
  --root . \
  --run-declarations
```

One command, in this order: the recorded declaration generator, the CSS typecheck, the TSX rules, the CSS rules, and the contract checks that span files.

You can start every rule at warning severity and promote them to errors when the project is ready. Rule IDs never change, so that promotion edits severity and nothing else.

No rule can tell you what earns a place in shared, how tightly semantics should couple, whether the page actually looks right, or what your spacing policy should be. That part stays with review, and probably always will.

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

The bundled planner covers all five setup modes and prints a dry run by default. Writing is opt-in.

```sh
node skills/frontend/css-modules-setup/scripts/setup.mjs bootstrap \
  --root /path/to/project \
  --profile-source /path/to/project/selected-profile.json \
  --inputs /path/to/project/setup-inputs.json
```

Only `bootstrap`, `align`, and an explicitly authorized `migrate` plan accept `--apply`. In bootstrap and align, an existing file with different content counts as a conflict. Migrate can replace only the files listed in its reviewed plan, and only while their content still matches the baseline.

### Development checks

These commands are for working on the skills themselves. A project that installed them needs none of this.

Install the pinned development dependencies, then run everything:

```sh
npm ci
npx playwright install chromium
npm run css:verify
```

For narrower loops, use `css:check`, `css:oxlint`, `css:audit-fixture`, `css:fixture`, or `css:browser`.

The fixture list is long on purpose. It covers:

- npm, pnpm, Yarn, and Bun
- Vite config variants, plus layer maps that use the reference names and layer maps that rename them
- installation itself, meaning Codex and Claude Code discovery paths, duplicate installs, ownership, CI, and version drift
- setup that stays safe when you run it twice
- ESLint, Oxlint, Stylelint, and the contract rules
- declarations, TypeScript, alias composition, and semantic colors
- DOM state, accessibility behavior, and the cascade as Chromium computes it

Evaluation scenarios live under `evals/`. The prompts sit in `evals/css-modules.json` in machine-readable form, and `scripts/evaluate.mjs` scores a host's answers against them, recorded or live, by trigger. None of it ships with the skills.