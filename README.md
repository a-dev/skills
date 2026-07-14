# Skills

The canonical sources live in this repository under `skills/`.

## Install

List the available skills before installing:

```sh
npx skills add a-dev/skills --list
```

Install the two CSS Modules skills into the current project:

```sh
npx skills add a-dev/skills \
  --skill css-modules-setup \
  --skill css-modules
```

Add `--global` for a user-level installation or `--agent codex` / `--agent claude-code` to select a host explicitly.

After installation, verify that both skills appear in the host's available-skill catalog. Skill directories and manual-only behavior vary by host; basic `SKILL.md` instructions are portable, but host metadata may not be.

The [`skills` CLI](https://github.com/vercel-labs/skills) currently maps the supported hosts like this:

| Host        | Project installation | Global installation | Verify                                                                           |
| ----------- | -------------------- | ------------------- | -------------------------------------------------------------------------------- |
| Codex       | `.agents/skills/`    | `~/.codex/skills/`  | `npx skills list --agent codex` and inspect Codex's available skills             |
| Claude Code | `.claude/skills/`    | `~/.claude/skills/` | `npx skills list --agent claude-code` and inspect Claude Code's available skills |

Invoke `css-modules-setup` explicitly through the host's skill mechanism. `disable-model-invocation` and slash-command behavior are host metadata, not a portable guarantee of the Agent Skills format.

## Typed CSS Modules harness

| Skill                                                             | Invocation                   | Purpose                                                                   |
| ----------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------- |
| [`css-modules-setup`](skills/frontend/css-modules-setup/SKILL.md) | manual                       | read-only audit plus explicit bootstrap, align, migrate, and verify modes |
| [`css-modules`](skills/frontend/css-modules/SKILL.md)             | model-invoked after adoption | profile-driven per-edit styling discipline                                |

The Vite + React adapter is the tested reference. Other stacks need their own adapter and fixtures before they should be described as supported.

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

Setup writes a validated project-local contract:

```text
.agents/
  css-modules.json
  css-modules.schema.json
```

The profile records the selected application, aliases, helpers, shared API, layer topology, optional semantic color contract, and CSS-specific verification commands.

It does not prescribe spacing, sizing, typography, or shape scales. Project-specific systems remain project-owned.

The profile versions the portable methodology, JSON schema, and stack adapter separately. Audit reports unsupported major versions without rewriting them; version changes proceed only through an explicit migration plan.

### Read-only audit

From this repository, run:

```sh
node skills/frontend/css-modules-setup/scripts/audit.mjs \
  --root /path/to/project \
  --format human
```

The audit statically inspects files. It does not import Vite configuration, install packages, generate declarations, or write to the target project.

Use `--format json` for machine-readable output. Exit codes are:

- `0`: aligned or only behavior remains to verify;
- `1`: missing or drifted configuration;
- `2`: ambiguity, invalid profile, or audit failure.

### Development checks

The repository uses Node's built-in test runner:

```sh
npm test
```

The fixtures cover npm, pnpm, Yarn, and Bun; differently named coherent layers; ownership and version drift; ambiguous multi-app discovery; relative global imports; semantic-color boundaries; and byte-for-byte read-only behavior.

Skill evaluation scenarios (activation, non-activation, and pressure cases) live under `evals/`. They are author material and are not installed with the skills.
