import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { evaluateResponses } from "../scripts/evaluate.mjs";
import {
  gradeRunRecord,
  runOfflineGraderControls,
  validateRunRecord,
} from "../scripts/grade-evaluation.mjs";
import { prepareEvalFixtures } from "../scripts/prepare-eval-fixtures.mjs";
import { runEvaluationFixtures } from "../scripts/run-eval-fixtures.mjs";
import {
  readBehavioralCases,
  validateBehavioralCases,
} from "../scripts/validate-eval-fixtures.mjs";
import { MODEL_TASK_BLUEPRINTS } from "../../../../evals/fixtures/model-task-blueprints.mjs";

test("all behavioral cases have immutable blueprints and complete task metadata", async () => {
  const spec = await readBehavioralCases();
  assert.deepEqual(validateBehavioralCases(spec), []);
  assert.equal(spec.cases.length, 13);
  assert.deepEqual(
    spec.cases.map(({ id }) => id),
    [
      "variant",
      "loading",
      "custom-topology",
      "unprofiled-adoption",
      "non-adoption",
      "invalid-profile",
      "migration",
      "explicit-scale",
      "missing-tools",
      "broader-verification",
      "pre-existing-failure",
      "integration-exception",
      "fresh-setup",
    ],
  );
  assert.ok(
    Object.keys(MODEL_TASK_BLUEPRINTS).every((id) =>
      spec.cases.some((entry) => entry.fixture === id),
    ),
  );
  const template = JSON.parse(
    await readFile(
      new URL("../../../../evals/templates/css-modules-run-record.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(template.artifacts.patch.files[0].path, "src/Example.module.css");
  assert.match(template.artifacts.patch.files[0].after, /danger/);
  assert.equal(template.artifacts.generatedFiles[0].path, "src/Example.module.css.d.ts");
  assert.match(template.artifacts.generatedFiles[0].content, /export const danger/);
});

test("fixture preparation is deterministic, scoped, and refuses non-empty output", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "css-eval-fixture-test-"));
  try {
    const prepared = await prepareEvalFixtures({
      caseId: "variant",
      output: path.join(output, "variant"),
    });
    assert.deepEqual(prepared.caseIds, ["variant"]);
    assert.deepEqual(prepared.instructions[0].existingFailures, []);
    assert.deepEqual((await readdir(path.join(output, "variant"))).sort(), [
      ".agents",
      "README.md",
      "index.html",
      "node_modules",
      "package.json",
      "src",
      "tsconfig.json",
      "vite.config.mjs",
    ]);
    const profile = await readFile(path.join(output, "variant/.agents/css-modules.json"), "utf8");
    assert.match(profile, /css-modules-compact/);
    await assert.rejects(
      prepareEvalFixtures({ caseId: "variant", output: path.join(output, "variant") }),
      /non-empty/,
    );
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("behavioral grader uses artifacts and checks rather than response keywords", async () => {
  const spec = await readBehavioralCases();
  const variant = spec.cases.find((entry) => entry.id === "variant");
  const controls = await runOfflineGraderControls();
  assert.equal(controls.status, "passed");
  assert.equal(controls.controls.valid, "passed");
  assert.notEqual(controls.controls.keywordOnly, "passed");
  assert.equal(controls.controls.brokenArtifact, "failed");
  assert.equal(controls.controls.brokenCode, "failed");
  assert.equal(controls.controls.wrongClassKey, "failed");
  assert.equal(controls.controls.topologyDrift, "failed");
  assert.equal(controls.controls.forbiddenReport, "failed");
  assert.equal(controls.controls.missingReport, "incomplete");

  const valid = JSON.parse(JSON.stringify(controls.results.valid));
  assert.equal(valid.status, "passed");

  const wordless = {
    schemaVersion: 1,
    runId: "wordless-correct-artifact",
    caseId: "variant",
    skillRevision: { earlier: "a", revised: "b" },
    fixtureRevision: "fixture",
    model: { provider: "manual", id: "recorded-model", version: "recorded-version", settings: {} },
    host: { name: "manual", version: "recorded-version", os: "recorded-os" },
    request: "variant",
    response: "Done.",
    activationTrace: { status: "available", events: [] },
    artifacts: {
      patchStatus: "present",
      patch: {
        format: "file-snapshot",
        diff: null,
        files: [
          {
            path: "src/Button.tsx",
            action: "modified",
            before: "const VARIANT_CLASS = { primary: styles.root };",
            after: "const VARIANT_CLASS = { primary: styles.root, danger: styles.danger };",
          },
          {
            path: "src/Button.module.css",
            action: "modified",
            before: ".root { display: inline-flex; }",
            after: ".root { display: inline-flex; }\n.danger { color: red; }",
          },
        ],
      },
      changedFiles: ["src/Button.tsx", "src/Button.module.css"],
      generatedOutputs: ["src/Button.module.css.d.ts"],
      generatedFiles: [
        {
          path: "src/Button.module.css.d.ts",
          kind: "declaration",
          content: "export const root: string;\nexport const danger: string;\n",
        },
      ],
      domEvidence: [],
      artifactEvidence: [{ id: "generated.class-keys", path: "src/Button.module.css.d.ts" }],
    },
    commands: [{ name: "css:types", command: "tsc --noEmit", status: "passed" }],
    finalReport: {
      status: "passed",
      claims: [],
      reportEvidence: [],
      unverified: [],
      preExistingFailures: [],
      humanReview: {
        semanticSharing: "pass",
        reasonableClarification: "not-applicable",
        integrationException: "not-applicable",
      },
    },
    missingEvidence: [],
  };
  assert.equal(gradeRunRecord(variant, wordless).status, "passed");
  assert.deepEqual(validateRunRecord(wordless), []);
  const missingPatchEvidence = JSON.parse(JSON.stringify(wordless));
  delete missingPatchEvidence.artifacts.patch;
  assert.match(validateRunRecord(missingPatchEvidence).join("\n"), /artifacts\.patch/);
});

test("every prepared case executes its declared deterministic routes", async () => {
  const result = await runEvaluationFixtures({ browser: false });
  assert.equal(result.status, "passed");
  assert.equal(result.results.length, 13);
  assert.ok(result.results.every((entry) => entry.declaredChecksRunnable));
  assert.ok(result.results.every((entry) => entry.canonicalUnchanged));
  assert.ok(
    result.results
      .flatMap((entry) => entry.commands)
      .filter((command) => !command.optional)
      .every((command) => command.status !== "not-run"),
  );
});

test("legacy canned scorer controls retain both known substring failure directions", () => {
  const keywordOnly = evaluateResponses(
    [
      {
        id: "case",
        category: "pressure",
        expectedActivation: true,
        requiredSignals: ["exhaustive", "verification"],
      },
    ],
    [
      {
        id: "case",
        activated: true,
        response:
          "I used exhaustive verification but concatenated a CSS export name and ran no checks.",
      },
    ],
  );
  assert.equal(keywordOnly.status, "passed");

  const negated = evaluateResponses(
    [
      {
        id: "case",
        category: "pressure",
        expectedActivation: true,
        forbiddenSignals: ["computed class key"],
      },
    ],
    [{ id: "case", activated: true, response: "I avoided a computed class key." }],
  );
  assert.equal(negated.status, "failed");
});
