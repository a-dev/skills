# A-dev skills

Personal Claude Code skills, plain Markdown. Install a skill by symlinking its directory into `~/.claude/skills/` (all projects) or `<project>/.claude/skills/` (one project).

## CSS Modules — a two-part skill

The typed CSS Modules convention pack is split by invocation contract:

| Skill | Invocation | Purpose |
| --- | --- | --- |
| [css-modules-setup](skills/frontend/css-modules-setup/SKILL.md) | **Manual only** — `/css-modules-setup` (`disable-model-invocation: true`) | One-time project bootstrap + alignment audit |
| [css-modules](skills/frontend/css-modules/SKILL.md) | **Automatic** — the model invokes it while styling | Per-edit conventions: class naming, typed variant lookups, `data-*` state, semantic tokens, layers, composition |

### Adopting the convention in a project

1. Install both skills (symlink).
2. Run `/css-modules-setup` once. It **audits first** and prints an `aligned / missing / drifted` table, asks where the styles root should live (suggested default: `shared/styles`), then scaffolds only what's missing — it never overwrites existing choices.
3. Done — from now on `css-modules` triggers by itself whenever styles are written or edited.

### Checking that a project is still aligned

Re-run `/css-modules-setup` at any time: Phase 0 compares the project against the current recipes and reports drift without changing anything that already exists. Quick manual markers that a project is on the convention:

- `patchCssModules(…)` and `localsConvention: "camelCaseOnly"` in `vite.config.ts`
- `css:dts` + `prepare` scripts in `package.json`, `*.module.css.d.ts` gitignored, CI running it before `tsc`
- a styles root (default `shared/styles`, chosen during setup) with `lib/` (`cx`, `cssVars`) and `vars/` (palette + semantic tokens)
- `<styles-root>/global.css` declaring `@layer reset, base, layout, typography, ui, utils;` plus the `color-scheme` theme mapping in `@layer base`
- the `#styles` alias resolving to the styles root (`index.ts` for the bare import, `#styles/*` for subpaths)
