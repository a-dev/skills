This repository contains Agent Skills plus executable harness artifacts. `package.json` runs the audit/setup/evaluation tests, a disposable Vite + React build fixture, and Playwright browser checks; there is no production application.

`skills/frontend/css-modules/SKILL.md` - per-edit CSS Modules conventions; model-invocable while styling.
`skills/frontend/css-modules-setup/SKILL.md` - explicitly invoked one-time bootstrap + alignment audit (`disable-model-invocation: true`; host command behavior varies).

The canonical project-profile schema, version contract, stack/host adapters, templates, audit/setup/source-check scripts, evaluations, and fixtures live under `skills/frontend/css-modules-setup/`. Keep executable claims in the Markdown synchronized with those artifacts.
