import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { evaluateResponses, runEvaluation } from "../scripts/evaluate.mjs";

test("trigger and pressure evaluations pass by category", async () => {
  const result = await runEvaluation();

  assert.equal(result.status, "passed");
  assert.equal(result.lane, "scorer");
  assert.match(result.evidence, /no model activation|not model adherence evidence/);
  assert.deepEqual(
    result.categories.map(({ category, failed }) => [category, failed]),
    [
      ["authorized-override", 0],
      ["pressure", 0],
      ["trigger-negative", 0],
      ["trigger-positive", 0],
    ],
  );
});

test("scorer fixture records its adoption and authorization context without treating it as evidence", async () => {
  const cases = await readFile(
    new URL("../../../../evals/css-modules.json", import.meta.url),
    "utf8",
  );
  const parsed = JSON.parse(cases);
  assert.equal(parsed.lane, "scorer-fixture");
  assert.ok(parsed.cases.every((entry) => entry.adoptionContext));
  assert.ok(parsed.cases.every((entry) => entry.policy));
  assert.ok(parsed.cases.every((entry) => entry.provenance));
  assert.ok(parsed.cases.every((entry) => entry.allowedScope));
  assert.match(parsed.scorerLimitations.join(" "), /not model-adherence evidence|model evidence/i);
});

test("the scorer rejects activation drift, spacing invention, and layer-profile normalization", () => {
  const result = evaluateResponses(
    [
      {
        id: "negative",
        category: "trigger-negative",
        expectedActivation: false,
      },
      {
        id: "spacing",
        category: "pressure",
        expectedActivation: true,
        requiredSignals: ["project decision"],
        forbiddenSignals: ["created a 4px scale"],
      },
      {
        id: "layer-drift",
        category: "pressure",
        expectedActivation: true,
        requiredSignals: ["drift", "migration"],
        forbiddenSignals: ["updated all modules"],
      },
    ],
    [
      { id: "negative", activated: true, response: "Applied the skill." },
      { id: "spacing", activated: true, response: "I created a 4px scale." },
      {
        id: "layer-drift",
        activated: true,
        response: "I updated all modules to match the profile.",
      },
    ],
  );

  assert.equal(result.status, "failed");
  assert.equal(result.categories.find(({ category }) => category === "pressure")?.failed, 2);
  assert.equal(
    result.categories.find(({ category }) => category === "trigger-negative")?.failed,
    1,
  );
});
