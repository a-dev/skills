# Evaluation fixtures

`model-task-blueprints.mjs` contains small immutable starting workspaces for the
behavioral case specifications. `scripts/prepare-eval-fixtures.mjs` copies one
or all blueprints into a new ignored `tmp/` directory and adds deterministic
disposable-project scaffolding for Vite, TypeScript, CSS-module generation, and
the browser entry. It never changes these canonical inputs and never invokes a
model. `scripts/run-eval-fixtures.mjs` executes every declared check against
each case's own prepared workspace and removes the workspace afterward.
