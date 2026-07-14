# Read-only project discovery

Load this reference at the beginning of every setup run.

## Safety boundary

- Read static files only.
- Do not import or execute Vite, package, application, or CI configuration during audit.
- Do not install packages, generate declarations, or rewrite configuration.
- Report behavior that static inspection cannot prove as `not-verifiable`.
- Run write-capable verification only in explicit `verify`, `bootstrap`, `align`, or `migrate` modes.

## Package manager

Use `packageManager` and lockfiles:

| Marker                    | Manager |
| ------------------------- | ------- |
| `pnpm-lock.yaml`          | pnpm    |
| `yarn.lock`               | Yarn    |
| `bun.lock` or `bun.lockb` | Bun     |
| `package-lock.json`       | npm     |

More than one current lockfile is ambiguity. Never create a second lockfile.

## Application roots

Find workspace declarations and candidate Vite configs:

- `vite.config.ts`, `.mts`, `.js`, `.mjs`, `.cjs`, or `.cts`;
- package scripts that invoke Vite;
- source entries that import a global stylesheet;
- package boundaries under workspace manifests.

If multiple candidates are plausible and no profile selects one, ask the user.

## Existing style contract

Inspect:

- repository instructions and local skill files;
- `.agents/css-modules.json` and its schema;
- CSS Module aliases in package imports, Vite, and TypeScript;
- shared entry points and their exports;
- external `composes` paths;
- all top-level layer-order declarations;
- layer ownership in shared modules;
- helper implementations;
- palette, semantic color, and `color-scheme` files;
- CSS declaration generation and class-key typecheck commands;
- CSS-specific lint, contract, fixture, or browser commands, when present;
- CI ordering for those CSS-harness commands.

## Classify findings

Assign each finding one status from the compatibility taxonomy in `SKILL.md`.

Presence is weaker than capability. Finding `#styles` text does not prove TypeScript imports, CSS subpaths, and external `composes` all resolve.
