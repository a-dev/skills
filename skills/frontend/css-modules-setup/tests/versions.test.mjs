import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateInput } from "../scripts/contract.mjs";

async function json(relativeUrl) {
  return JSON.parse(await readFile(new URL(relativeUrl, import.meta.url), "utf8"));
}

function numeric(version) {
  return version.split(".").map((part) => Number.parseInt(part, 10));
}

function atLeast(actual, minimum) {
  const left = numeric(actual);
  const right = numeric(minimum);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) > (right[index] ?? 0);
  }
  return true;
}

test("package, methodology, schema, adapter, and minimum versions share one contract", async () => {
  const versions = await json("../versions.json");
  const profile = await json("../assets/css-modules.example.json");
  const packageJson = await json("../../../../package.json");
  const scorer = await json("../../../../evals/css-modules.json");
  const behavioral = await json("../../../../evals/cases/css-modules.behavioral.json");
  const runRecord = await json("../../../../evals/schemas/css-modules-run-record.schema.json");

  assert.equal(versions.skillPackageVersion, packageJson.version);
  assert.equal(versions.methodologyVersion, profile.methodologyVersion);
  assert.equal(versions.profileSchemaVersion, profile.profileSchemaVersion);
  assert.equal(versions.compactSchemaVersion, 1);
  assert.equal(versions.compactPreset, "vite-react@1");
  assert.deepEqual(versions.evaluation, {
    scorerVersion: 2,
    behavioralCaseVersion: 1,
    runRecordVersion: 1,
  });
  assert.equal(scorer.version, versions.evaluation.scorerVersion);
  assert.equal(behavioral.version, versions.evaluation.behavioralCaseVersion);
  assert.equal(runRecord.properties.schemaVersion.const, versions.evaluation.runRecordVersion);
  assert.equal(versions.adapters[profile.adapter.name].version, profile.adapter.version);
  assert.equal(packageJson.devDependencies.oxlint, versions.enforcement.oxlint);

  for (const [dependency, minimum] of Object.entries(
    versions.adapters[profile.adapter.name].minimums,
  )) {
    assert.ok(packageJson.devDependencies[dependency], `missing pinned ${dependency}`);
    assert.ok(
      atLeast(packageJson.devDependencies[dependency], minimum),
      `${dependency} is below ${minimum}`,
    );
  }
});

test("the compact example validates against its pinned schema and preset", async () => {
  const compact = await json("../assets/css-modules.compact.example.json");
  assert.deepEqual(validateInput(compact), []);
  const presets = await json("../assets/css-modules.presets.json");
  assert.ok(presets[compact.preset]);
  assert.equal(compact.version, 1);
});

test("the published schema requires every conditional field the validator enforces", async () => {
  const schema = await json("../assets/css-modules.schema.json");
  const conditionals = schema.allOf ?? [];

  // validateProfile rejects enforcement without publicClasses. The schema ships
  // beside the profile so an editor catches that before a script does, so the
  // two must agree on it.
  const enforcementRule = conditionals.find((entry) => entry.if?.required?.includes("enforcement"));
  assert.ok(enforcementRule, "schema must condition on the enforcement field");
  assert.deepEqual(enforcementRule.then.properties.sharedApi.properties.modules.items.required, [
    "name",
    "path",
    "layer",
    "publicClasses",
  ]);

  const modules = schema.properties.sharedApi.properties.modules.items;
  assert.ok(
    !modules.required.includes("publicClasses"),
    "publicClasses stays optional without enforcement",
  );
});
