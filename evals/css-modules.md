# CSS Modules evaluation lanes

The repository has two deliberately separate lanes:

- **Scorer tests** use `evals/css-modules.json` and the checked-in responses in `evals/fixtures/css-modules.responses.json`. `npm run css:evaluate` checks schema wiring and regression signals only. It is not model-adherence evidence: a response field and substring match cannot prove activation, tool use, code quality, or verification honesty.
- **Behavioral runs** use the case specifications in `evals/cases/css-modules.behavioral.json`, disposable workspaces prepared by `scripts/prepare-eval-fixtures.mjs`, run records, and `scripts/grade-evaluation.mjs`. They inspect artifacts, diff scope, check results, applicable DOM evidence, and provenance. Live host traces may be unavailable and must remain unavailable in the record.

The scorer cases include adoption context, project policy, request provenance, and allowed scope. They distinguish an unapproved request to invent a scale or normalize topology from a direct request that explicitly authorizes the corresponding scoped change. The legacy keyword false-pass and negated-phrase false-failure examples remain regression controls for the old scorer; they are not claimed to be semantic grading.

## Offline fixture workflow

Validate the canonical case specifications and prepare a disposable copy without model calls:

```sh
npm run css:eval:fixtures
npm run css:eval:prepare -- --case variant --output tmp/css-eval-variant
```

Prepared workspaces and run outputs belong under ignored `tmp/`. Canonical case specifications are immutable inputs. The preparation command refuses to overwrite a non-empty destination and prints the selected case's allowed edits, existing failures, checks, and judgment questions.

Grade an externally captured record after copying it to an ignored path:

```sh
node skills/frontend/css-modules-setup/scripts/grade-evaluation.mjs \
  --record tmp/css-eval-run.json \
  --case variant
```

The record must state its task/skill/fixture revisions, model and settings (or explicit unknown values), host, request, available tool trace, patch/artifacts, command results, final report, and missing evidence. The patch is an inspectable file snapshot or unified diff: every changed path has an action plus before/after content. Generated outputs include their captured path and content, and artifact-evidence entries index those generated files. Report signals are structured IDs with `supportedBy` references such as `patch:src/Button.tsx`, `generated:src/Button.module.css.d.ts`, `command:css:types`, `dom:loading present`, or `activation:profile-unavailable`; claims and response prose are never proof. Do not fill unavailable metadata with guesses. A human may add the explicit rubric fields for semantic sharing, reasonable clarification, and integration exceptions; the grader does not turn those judgments into keyword rules.

The shared runner prepares each immutable blueprint in a disposable workspace and executes every declared deterministic route. Use `npm run css:eval:run` for generation, type, audit, setup-plan, source-check, and build routes; add `-- --browser` to execute declared development or production Playwright routes as well. The runner reports expected baseline failures separately and confirms that canonical blueprints remain unchanged.

## Release-time comparison, currently pending

Task 31 is a bounded comparison plan, not a result in this repository. When explicitly authorized and a host route is available, compare Luna with one capable comparison model, earlier and revised skill text, six representative cases, and three repeats per model/skill revision: 2 models × 2 revisions × 6 cases × 3 repeats = 72 runs. Record exact model/settings, host, fixture and skill revisions, task completion, unwanted edits, false refusals, clarification count, verification honesty, cost where available, missing evidence, and sample limits. A smaller pilot may estimate cost before the full matrix.

Live results are not run by deterministic CI. Demonstrated regressions require a separately scoped fix and reruns only for affected cases. No broad model ranking or universal reliability claim follows from this small sample.
