#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { MODEL_TASK_BLUEPRINTS } from "../../../../evals/fixtures/model-task-blueprints.mjs";

const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_ROOT, "../../../..");
const CASES_PATH = path.join(REPOSITORY_ROOT, "evals/cases/css-modules.behavioral.json");
const RUNNABLE_CHECKS = new Set([
  "css:generate",
  "css:types",
  "css:check",
  "css:check (unavailable)",
  "css:audit-fixture",
  "test",
  "build",
  "setup audit",
  "setup bootstrap",
  "setup migrate",
  "focused static inspection",
  "css:browser",
  "preview browser check",
  "integration test",
]);

export async function readBehavioralCases(casesPath = CASES_PATH) {
  return JSON.parse(await readFile(casesPath, "utf8"));
}

export function validateBehavioralCases(spec, blueprints = MODEL_TASK_BLUEPRINTS) {
  const errors = [];
  if (spec?.version !== 1) errors.push("behavioral case spec version must be 1");
  if (spec?.lane !== "behavioral") errors.push("behavioral case spec lane must be behavioral");
  if (!Array.isArray(spec?.cases) || spec.cases.length === 0) {
    errors.push("behavioral case spec must contain cases");
    return errors;
  }

  const ids = new Set();
  for (const entry of spec.cases) {
    if (!entry || typeof entry !== "object") {
      errors.push("case entries must be objects");
      continue;
    }
    if (!entry.id || ids.has(entry.id))
      errors.push(`case id is missing or duplicated: ${entry.id ?? "<missing>"}`);
    ids.add(entry.id);
    for (const field of ["fixture", "request", "adoptionContext", "policy", "provenance"]) {
      if (typeof entry[field] !== "string" || entry[field].length === 0) {
        errors.push(`${entry.id}: ${field} must be a non-empty string`);
      }
    }
    for (const field of ["allowedEdits", "existingFailures", "checks", "judgmentQuestions"]) {
      if (!Array.isArray(entry[field])) errors.push(`${entry.id}: ${field} must be an array`);
    }
    if (Array.isArray(entry.checks)) {
      if (entry.checks.length === 0) errors.push(`${entry.id}: checks must not be empty`);
      for (const check of entry.checks) {
        if (typeof check !== "string" || !RUNNABLE_CHECKS.has(check)) {
          errors.push(`${entry.id}: no shared runner route for check ${check}`);
        }
      }
    }
    if (!entry.expectations || typeof entry.expectations !== "object") {
      errors.push(`${entry.id}: expectations must be an object`);
    } else {
      for (const field of [
        "requiredChangedGlobs",
        "forbiddenChangedGlobs",
        "requiredPassingChecks",
        "requiredDomEvidence",
        "requiredPreservedValues",
        "requiredPreservedPaths",
        "requiredReportSignals",
        "forbiddenReportSignals",
      ]) {
        if (field in entry.expectations && !Array.isArray(entry.expectations[field])) {
          errors.push(`${entry.id}: expectations.${field} must be an array`);
        }
      }
      for (const [index, evidence] of (
        entry.expectations.requiredArtifactEvidence ?? []
      ).entries()) {
        if (typeof evidence === "string") continue;
        if (!evidence || typeof evidence !== "object") {
          errors.push(
            `${entry.id}: requiredArtifactEvidence[${index}] must be an object or string`,
          );
          continue;
        }
        if (!evidence.id || (!evidence.path && !evidence.pathPattern)) {
          errors.push(
            `${entry.id}: requiredArtifactEvidence[${index}] needs id and path or pathPattern`,
          );
        }
        if (evidence.source && !["generated", "patch"].includes(evidence.source)) {
          errors.push(`${entry.id}: requiredArtifactEvidence[${index}].source is invalid`);
        }
      }
      for (const field of [
        "requiredPreservedValues",
        "requiredPreservedPaths",
        "requiredReportSignals",
        "forbiddenReportSignals",
      ]) {
        for (const value of entry.expectations[field] ?? []) {
          if (typeof value !== "string" || value.length === 0) {
            errors.push(`${entry.id}: expectations.${field} values must be non-empty strings`);
          }
        }
      }
    }
    const files = blueprints[entry.fixture];
    if (!files) {
      errors.push(`${entry.id}: missing immutable fixture blueprint ${entry.fixture}`);
      continue;
    }
    for (const [relativePath, content] of Object.entries(files)) {
      if (
        !relativePath ||
        path.posix.isAbsolute(relativePath) ||
        relativePath.split("/").includes("..")
      ) {
        errors.push(`${entry.id}: fixture path escapes its workspace: ${relativePath}`);
      }
      if (typeof content !== "string")
        errors.push(`${entry.id}: fixture content is not text: ${relativePath}`);
    }
  }
  return errors;
}

export async function validateEvalFixtures() {
  const spec = await readBehavioralCases();
  const errors = validateBehavioralCases(spec);
  return {
    status: errors.length === 0 ? "passed" : "failed",
    cases: spec.cases?.length ?? 0,
    errors,
  };
}

async function main() {
  const result = await validateEvalFixtures();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== "passed") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
