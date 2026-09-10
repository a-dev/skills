# Disposable Vite + React reference fixture

Load this reference when `verify` cannot use an existing project CSS fixture, or when changing the setup templates, audit, adapter, or runtime claims in this skill.

The bundled fixture lives under `fixtures/vite-react/`. Verification copies it to a temporary directory before Vite generates declarations, so the canonical fixture and target project remain unchanged.

Run the deterministic build/type contract:

```sh
node <css-modules-setup-skill>/scripts/verify-reference.mjs
```

It must:

- generate declarations and declaration maps for every fixture CSS Module;
- pass `tsc --noEmit` against the generated class interface;
- pass a Vite production build, including alias-based external `composes`;
- prove a deliberately invalid CSS class lookup fails typechecking.

The generated-project lane also follows the actual setup path for two custom cases:

- a compact profile with zero shared modules, which creates helpers, global layers, and an empty barrel without placeholder CSS, then performs an explicit project-review admission of a real shared module, runs the real declaration CLI, TypeScript, build, and source checks, verifies inferred public classes, and exercises frozen-list additions/removals;
- a custom legacy profile migrated with `migrate --to compact`, which compares before/after resolved choices, preserves aliases/helpers/topology, and repeats alignment with no changes.

The lane records static-audit uncertainty separately from the stronger generated declaration, typecheck, and build evidence. It does not copy the maintained fixture into a target.

Run the browser assertions from the skills repository:

```sh
npm run css:browser
```

The spec in `browser-tests/reference.spec.mjs` covers the runtime behaviors setup step 6 must prove: light/dark/system semantic mappings, Tab focus, Enter/Space activation, disabled/loading suppression and deterministic completion, a meaningful pressed toggle, caller classes, custom properties, reduced motion, and a component-attributed forced-colors rule. Its disposable mutation controls remove the reduced-motion or forced-colors rule and must fail the corresponding assertion. DOM ARIA evidence is reported separately from screen-reader announcement evidence, which this browser lane does not claim.

The same spec builds the fixture with its real `vite.config.ts`, serves the production output, reverses the fixture import order in a disposable copy, and checks both alias composition and the selected local-over-shared precedence. Every temporary copy/server is closed and removed by the test helper.

Do not copy the fixture into a target application's production source. It is evidence for the adapter, not an application starter component.
