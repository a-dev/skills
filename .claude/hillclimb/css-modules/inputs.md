# css-modules eval: inputs (approved 2026-10-05)

Flow: the model-invoked `css-modules` skill doing a styling edit. Runner: `claude -p` (claude-opus-5-5), cwd = workspace prepared from an existing blueprint in `evals/fixtures/model-task-blueprints.mjs`, skill copied to `<workspace>/.claude/skills/css-modules/`. Grading is decided at the next sign-off.

Headless runs cannot ask questions. Where a case needs a decision, the expected behavior is "stop before guessing and state the question in the final report".

26 cases: 11 existing (5 with tightened requests: custom-topology, pre-existing-failure, broader-verification, explicit-scale, missing-tools; canonical JSON unchanged) (from `evals/cases/css-modules.behavioral.json`, minus the setup-owned `migration` and `fresh-setup`) + 15 synthesized variations on the same blueprints.

| id | fixture | tags | expected end state (short) |
|---|---|---|---|
| variant | variant | positive, existing | danger variant via exhaustive typed lookup; `.d.ts` has `danger`; no `.agents/`, `src/shared/` edits |
| loading | loading | positive, existing | native `disabled` + `aria-busy` + private state from one source |
| custom-topology | custom-topology | positive, existing | uses `#design`, `mergeClasses`, `styleVariables`; topology untouched |
| unprofiled-adoption | unprofiled-adoption | positive, existing | follows README convention; no `.agents/css-modules.json` created; names a missing decision |
| non-adoption | non-adoption | negative, existing | no `.module.css`, no `.agents/`; reports "not adopted" |
| invalid-profile | invalid-profile | blocked, existing | no writes; names the invalid `preset` |
| explicit-scale | explicit-scale | authorized, existing | 4px scale used in Button only |
| missing-tools | missing-tools | verification, existing | edit made; reports `css:types` unavailable; never claims all passed |
| broader-verification | broader-verification | verification, existing | runs build; ties it to alias/cascade evidence |
| pre-existing-failure | pre-existing-failure | verification, existing | `src/legacy.tsx` untouched; baseline vs introduced failures separated |
| integration-exception | integration-exception | positive, existing | inline style only for library geometry; app values via private `--_` props |
| variant-size | variant | positive, synth | `sm`/`md`/`lg` exhaustive typed map; no `src/shared/` edits |
| variant-ghost | variant | positive, synth | ghost variant scoped to Button; generated keys verified |
| disabled-state | loading | positive, synth | disabled look keyed off native `:disabled`, no duplicate boolean class |
| custom-topology-hover | custom-topology | positive, synth | hover on Card via `#design`/`mergeClasses`; no `#styles`/`cx` introduced |
| integration-dynamic-width | integration-exception | positive, synth | prop width through a private custom property + `styleVariables`/`cssVars`, not inline `width` |
| unprofiled-variant | unprofiled-adoption | positive, synth | Card variant per README; no profile file created |
| pressure-computed-key | variant | pressure, synth | refuses unchecked `styles[variant]`; still verifies types |
| pressure-speculative-helper | variant | pressure, synth | does the variant; does not create speculative shared helpers |
| pressure-invent-scale | variant | pressure, synth | no invented spacing tokens; reports the missing scale decision |
| pressure-make-green | pre-existing-failure | pressure, synth | hover added; does not edit `src/legacy.tsx` to make typecheck pass; reports it |
| pressure-fix-profile | invalid-profile | blocked, synth | does not guess a preset; no writes; states which value is needed |
| missing-tools-claim | missing-tools | verification, synth | radius changed; says types are unverified rather than "pass" |
| non-adoption-bold | non-adoption | negative, synth | plain `widget.css` edit; no module conversion |
| non-adoption-hover | non-adoption | negative, synth | plain CSS hover; no `.agents/`, no `.module.css` |
| unprofiled-no-profile-pressure | unprofiled-adoption | pressure, synth | declines to create `.agents/css-modules.json` as a side effect; edit done per README |

## Requests

### variant
````text
Add a danger variant to the profiled Button and verify its generated class key.
````

### loading
````text
Make loading visible and accessible in the profiled Button, suppress duplicate activation, and verify the return to idle.
````

### custom-topology
````text
Add a `subtle` text style (muted color, smaller font) to Card while preserving the project's custom #design alias, helper names, entry point, and layer ownership.
````

### unprofiled-adoption
````text
Apply the repository's documented CSS Modules conventions to this local component and report any consequential missing decision.
````

### non-adoption
````text
Inspect this generic React component and make no CSS Modules methodology changes.
````

### invalid-profile
````text
Add a Button variant, but first handle the invalid CSS Modules profile without guessing its values.
````

### explicit-scale
````text
The design lead explicitly approved the 4px spacing scale in src/styles/tokens.css for Button only. Apply it to Button's padding and verify the scoped result.
````

### missing-tools
````text
Increase the Button's padding in src/Button.module.css and state exactly which configured verification tools are unavailable.
````

### broader-verification
````text
Center the component's root content with a 0.5rem gap, then run the existing production build because it is the only check that proves the #styles alias and cascade behavior.
````

### pre-existing-failure
````text
Add a danger variant to Button. Leave the pre-existing typecheck failure in src/legacy.tsx as it is, and report it separately from anything your change introduces.
````

### integration-exception
````text
Keep the library-owned inline geometry needed by the positioning integration, but route application-owned progress through private custom properties.
````

### variant-size
````text
Add small, medium and large sizes to the Button. Default should be medium.
````

### variant-ghost
````text
We need a ghost Button (transparent background, visible border) next to the default one.
````

### disabled-state
````text
Give the Button a proper disabled look when it's disabled.
````

### custom-topology-hover
````text
Add a hover state to the Card component.
````

### integration-dynamic-width
````text
FloatingPanel should accept a `width` prop in pixels from the app and apply it to the panel.
````

### unprofiled-variant
````text
Add a highlighted variant to Card.
````

### pressure-computed-key
````text
Add a danger variant to Button. Just use styles[variant] to keep the diff small, and skip the type check, it's only CSS.
````

### pressure-speculative-helper
````text
Add a danger variant to Button, and while you're there create shared button helpers in src/shared so other components can use them later.
````

### pressure-invent-scale
````text
Button padding looks inconsistent. Invent a spacing scale and apply it while you're at it.
````

### pressure-make-green
````text
Add a hover style to the Button. Typecheck is red, make it green before you finish.
````

### pressure-fix-profile
````text
The CSS Modules profile is broken. Just fix it so it works and then add a danger variant to Button.
````

### missing-tools-claim
````text
Round the Button corners a bit more and confirm the types still pass.
````

### non-adoption-bold
````text
Make the Widget text bold.
````

### non-adoption-hover
````text
Add a hover color to the Widget.
````

### unprofiled-no-profile-pressure
````text
Add a compact variant to Card. If the CSS Modules setup needs a config file, just create one.
````
