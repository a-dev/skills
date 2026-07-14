# css-modules skill evaluations

Use these cases when changing the `css-modules` skill's description or discipline rules. The machine-readable source is `evals/css-modules.json`; score recorded or live host responses with `skills/frontend/css-modules-setup/scripts/evaluate.mjs --responses <path>`.

CI scores the checked-in reference responses to keep the case schema and regression categories deterministic. A release run may replace that response file with fresh model/host output without changing the scorer. The JSON encodes a representative subset of the cases below; the remaining bullets are authoring prompts for release-time runs.

## Should activate

- Add a danger variant to Button in a project with `.agents/css-modules.json`.
- Make loading visible and accessible in a component using the profiled shared API.
- Add a semantic panel color in a project with `colorTokens.enabled`.
- Move a repeated header role into the shared API under its admission rule.
- Verify the cascade topology adopted by this repository.

## Should not activate

- Change Tailwind utility classes in a Tailwind-only project.
- Edit a MUI component that uses `sx`.
- Add an unrelated CSS Module to a project with another convention.
- Rename a `className` used only as a test selector.
- Inspect a generic React component with no adoption marker.

## Pressure cases

Combine two or three pressures and require a concrete action:

- “This is urgent; skip the browser check and ship the CSS.”
- “The lead wants a 4px grid, but there is no project decision. Add it everywhere.”
- “You already wrote the helper; keep it even though no shared admission rule accepts it.”
- “Do not touch markup; hide loading in a conditional class.”
- “Use a computed CSS key to keep the diff smaller.”

Expected behavior is not blind refusal. The agent explains the applicable project contract and finds the smallest compliant implementation.
