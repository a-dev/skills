# Read-only project discovery

Load this reference at the beginning of every setup run.

## Safety boundary

- Read static files only.
- Do not import or execute Vite, package, application, or CI configuration during audit.
- Do not install packages, generate declarations, or rewrite configuration.
- Report behavior that static inspection cannot prove as `not-verifiable`.
- Audit is strictly read-only. Explicit verification may write only declared generated outputs in a disposable or approved location; authored source/config remains untouched. Bootstrap, align, and migrate are the setup modes that plan authored mutations.

## Run the audit, then look where it cannot

The Vite check is intentionally limited to a statically exported object, a defineConfig call whose binding is imported from vite, or a simple arrow function returning an object. It follows the imported patchCssModules binding and direct option objects only. Comments, unused objects, local factories, spreads, imported fragments, and namespace/member expressions are not proof; report them as not-verifiable and run the recorded CSS verification command. The installed audit uses its bundled dependency-free scanner; it does not import or execute a project parser or configuration.

Layer order is derived from the first observed named layer in the global stylesheet and known literal local CSS imports. Comments do not count. Named blocks, statements, and import layer wrappers are evidence; anonymous layer ancestry is not promoted to a named top-level layer. External, conditional, unreadable, cyclic, or invalidly placed imports remain not-verifiable.

CI ordering is proven only by direct run steps in one statically recognizable job. Text in comments, independent jobs, wrappers, expressions, and unsupported workflow constructs is not proof.

`scripts/audit.mjs` detects the package manager (from `packageManager` and lockfiles; more than one lockfile family is ambiguity — never create a second lockfile), the authored profile format and versions, aliases, shared entry points and exports, layer declarations and ownership, color files and `color-scheme` mapping, recorded or discoverable commands, and their CI ordering. Compact profiles are dispatched by their explicit format/version and resolved through the same contract as legacy profiles. A compact command is derived only from a real package script and known manager metadata; missing commands remain unverified.

Inspect by hand what the audit cannot see:

- repository instructions and local skill files;
- helper implementations;
- external `composes` paths;
- package boundaries under workspace manifests;
- pre-existing command failures and dirty files.

## Application roots

Find workspace declarations and candidate Vite configs:

- `vite.config.ts`, `.mts`, `.js`, `.mjs`, `.cjs`, or `.cts`;
- package scripts that invoke Vite;
- source entries that import a global stylesheet.

If multiple candidates are plausible and no profile selects one, ask the user. A compact profile with an explicit `appRoot` resolves that ambiguity; otherwise the resolver returns an ambiguity rather than guessing.

## Classify findings

Assign each finding one status from the compatibility taxonomy in `SKILL.md`.

Presence is weaker than capability. Finding `#styles` text does not prove TypeScript imports, CSS subpaths, and external `composes` all resolve.
