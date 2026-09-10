#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { matchesGlob } from "./lib.mjs";
import { readBehavioralCases } from "./validate-eval-fixtures.mjs";

const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_ROOT, "../../../..");
const CONTROL_PATH = path.join(REPOSITORY_ROOT, "evals/cases/removed-instruction-control.json");

const REQUIRED_RECORD_FIELDS = [
  "schemaVersion",
  "runId",
  "caseId",
  "skillRevision",
  "fixtureRevision",
  "model",
  "host",
  "request",
  "activationTrace",
  "artifacts",
  "commands",
  "finalReport",
  "missingEvidence",
];
const PATCH_ACTIONS = new Set(["created", "modified", "deleted"]);
const PATCH_FORMATS = new Set(["file-snapshot", "unified-diff", "none"]);
const PATCH_STATUSES = new Set(["present", "not-applicable", "missing", "broken"]);
const COMMAND_STATUSES = new Set(["passed", "failed", "unavailable", "not-run"]);
const REPORT_STATUSES = new Set(["passed", "failed", "incomplete"]);

export function validateRunRecord(record) {
  const errors = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return ["run record must be an object"];
  }
  for (const field of REQUIRED_RECORD_FIELDS) {
    if (!(field in record)) errors.push(`missing record field: ${field}`);
  }
  if (record.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (typeof record.runId !== "string" || record.runId.length === 0)
    errors.push("runId must be non-empty");
  if (typeof record.caseId !== "string" || record.caseId.length === 0)
    errors.push("caseId must be non-empty");
  if (
    !record.activationTrace ||
    !["available", "unavailable"].includes(record.activationTrace.status) ||
    !Array.isArray(record.activationTrace.events)
  ) {
    errors.push("activationTrace must have a status and events array");
  }

  const artifacts = record.artifacts;
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) {
    errors.push("artifacts must be an object");
  } else {
    if (!PATCH_STATUSES.has(artifacts.patchStatus)) errors.push("artifacts.patchStatus is invalid");
    const patch = artifacts.patch;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      errors.push("artifacts.patch must be an object");
    } else {
      if (!PATCH_FORMATS.has(patch.format)) errors.push("artifacts.patch.format is invalid");
      if (typeof patch.diff !== "string" && patch.diff !== null)
        errors.push("artifacts.patch.diff must be a string or null");
      if (!Array.isArray(patch.files)) errors.push("artifacts.patch.files must be an array");
      else {
        if (patch.format === "none" && patch.files.length > 0) {
          errors.push("artifacts.patch.format none cannot contain file snapshots");
        }
        if (artifacts.patchStatus === "present" && patch.files.length === 0) {
          errors.push("artifacts.patchStatus present requires file snapshots");
        }
        patch.files.forEach((entry, index) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            errors.push(`artifacts.patch.files[${index}] must be an object`);
            return;
          }
          if (typeof entry.path !== "string" || entry.path.length === 0)
            errors.push(`artifacts.patch.files[${index}].path must be non-empty`);
          if (!PATCH_ACTIONS.has(entry.action))
            errors.push(`artifacts.patch.files[${index}].action is invalid`);
          if (typeof entry.before !== "string" && entry.before !== null)
            errors.push(`artifacts.patch.files[${index}].before must be a string or null`);
          if (typeof entry.after !== "string" && entry.after !== null)
            errors.push(`artifacts.patch.files[${index}].after must be a string or null`);
        });
      }
    }
    for (const field of [
      "changedFiles",
      "generatedOutputs",
      "domEvidence",
      "artifactEvidence",
      "generatedFiles",
    ]) {
      if (!Array.isArray(artifacts[field])) errors.push(`artifacts.${field} must be an array`);
    }
    for (const [index, entry] of (artifacts.generatedFiles ?? []).entries()) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        errors.push(`artifacts.generatedFiles[${index}] must be an object`);
        continue;
      }
      if (typeof entry.path !== "string" || entry.path.length === 0)
        errors.push(`artifacts.generatedFiles[${index}].path must be non-empty`);
      if (!["declaration", "map", "build", "other"].includes(entry.kind))
        errors.push(`artifacts.generatedFiles[${index}].kind is invalid`);
      if (typeof entry.content !== "string" && entry.content !== null)
        errors.push(`artifacts.generatedFiles[${index}].content must be a string or null`);
    }
    for (const [index, entry] of (artifacts.artifactEvidence ?? []).entries()) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        errors.push(`artifacts.artifactEvidence[${index}] must be an object`);
        continue;
      }
      if (typeof entry.id !== "string" || entry.id.length === 0)
        errors.push(`artifacts.artifactEvidence[${index}].id must be non-empty`);
      if (typeof entry.path !== "string" || entry.path.length === 0)
        errors.push(`artifacts.artifactEvidence[${index}].path must be non-empty`);
    }
  }
  if (!Array.isArray(record.commands)) errors.push("commands must be an array");
  for (const [index, entry] of (record.commands ?? []).entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`commands[${index}] must be an object`);
      continue;
    }
    if (typeof entry.name !== "string" || typeof entry.command !== "string")
      errors.push(`commands[${index}] must have name and command strings`);
    if (!COMMAND_STATUSES.has(entry.status)) errors.push(`commands[${index}].status is invalid`);
  }
  if (!record.finalReport || !REPORT_STATUSES.has(record.finalReport.status)) {
    errors.push("finalReport.status is invalid");
  } else {
    for (const field of ["claims", "reportEvidence", "unverified", "preExistingFailures"]) {
      if (!Array.isArray(record.finalReport[field]))
        errors.push(`finalReport.${field} must be an array`);
    }
    for (const [index, entry] of (record.finalReport.reportEvidence ?? []).entries()) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        errors.push(`finalReport.reportEvidence[${index}] must be an object`);
        continue;
      }
      if (typeof entry.id !== "string" || entry.id.length === 0)
        errors.push(`finalReport.reportEvidence[${index}].id must be non-empty`);
      if (!Array.isArray(entry.supportedBy) || entry.supportedBy.length === 0)
        errors.push(`finalReport.reportEvidence[${index}].supportedBy must be non-empty`);
    }
  }
  if (!Array.isArray(record.missingEvidence)) errors.push("missingEvidence must be an array");
  return errors;
}

export function gradeRunRecord(caseSpec, record) {
  const failures = [];
  const incomplete = [];
  const warnings = [];
  const validationErrors = validateRunRecord(record);
  if (validationErrors.length > 0) return result("invalid-record", validationErrors, [], []);

  const expectations = caseSpec.expectations ?? {};
  const patchFiles = record.artifacts.patch.files.map((entry) => ({
    ...entry,
    path: normalizePath(entry.path),
  }));
  const changedFiles = record.artifacts.changedFiles.map(normalizePath);
  const patchPaths = patchFiles.map(({ path: filePath }) => filePath);
  if (!sameValues(changedFiles, patchPaths)) {
    failures.push("changedFiles does not match the captured patch file paths");
  }

  for (const [label, value] of [
    ["skillRevision.earlier", record.skillRevision?.earlier],
    ["skillRevision.revised", record.skillRevision?.revised],
    ["fixtureRevision", record.fixtureRevision],
    ["model.provider", record.model?.provider],
    ["model.id", record.model?.id],
    ["model.version", record.model?.version],
    ["host.name", record.host?.name],
    ["host.version", record.host?.version],
  ]) {
    if (value === null || value === undefined || value === "")
      incomplete.push(`missing provenance: ${label}`);
  }

  const requiredPatterns = expectations.requiredChangedGlobs ?? [];
  for (const pattern of requiredPatterns) {
    if (!patchPaths.some((filePath) => matchesGlob(filePath, pattern))) {
      incomplete.push(`missing required changed artifact: ${pattern}`);
    }
  }
  for (const pattern of expectations.forbiddenChangedGlobs ?? []) {
    const offending = patchPaths.find((filePath) => matchesGlob(filePath, pattern));
    if (offending) failures.push(`out-of-scope changed file: ${offending}`);
  }

  if (record.artifacts.patchStatus === "broken") failures.push("artifact patch is marked broken");
  if (record.artifacts.patchStatus === "present" && patchFiles.length === 0)
    incomplete.push("patch is marked present but contains no file snapshots");
  if (record.artifacts.patchStatus !== "present" && patchFiles.length > 0)
    failures.push("captured patch files require patchStatus present");
  if (requiredPatterns.length > 0 && record.artifacts.patchStatus !== "present") {
    incomplete.push("required patch artifact is not present");
  }

  const commandResults = new Map(record.commands.map((entry) => [entry.name, entry]));
  for (const required of expectations.requiredPassingChecks ?? []) {
    const command = findCommand(commandResults, required, record.commands);
    if (!command) incomplete.push(`missing command result: ${required}`);
    else if (command.status === "failed") failures.push(`failed required check: ${required}`);
    else if (command.status !== "passed") incomplete.push(`incomplete required check: ${required}`);
  }

  for (const required of expectations.requiredDomEvidence ?? []) {
    const observed = record.artifacts.domEvidence.some(
      (entry) =>
        (entry.assertion === required || entry.name === required) && entry.observed === true,
    );
    if (!observed) incomplete.push(`missing observed DOM evidence: ${required}`);
  }

  for (const required of expectations.requiredArtifactEvidence ?? []) {
    const requirement = normalizeArtifactRequirement(required);
    if (!requirement) {
      incomplete.push(`invalid artifact evidence requirement: ${JSON.stringify(required)}`);
      continue;
    }
    const source = requirement.source ?? "generated";
    if (source === "patch") {
      const patch = patchFiles.find((entry) =>
        requirement.path
          ? entry.path === normalizePath(requirement.path)
          : matchesGlob(entry.path, requirement.pathPattern),
      );
      if (!patch) {
        incomplete.push(`missing patched artifact: ${requirement.id}`);
        continue;
      }
      const indexed = record.artifacts.artifactEvidence.some(
        (entry) =>
          entry.id === requirement.id && normalizePath(entry.path) === normalizePath(patch.path),
      );
      if (!indexed)
        incomplete.push(`patched artifact is not indexed as evidence: ${requirement.id}`);
      if (patch.after === null) {
        incomplete.push(`patched artifact content unavailable: ${requirement.id}`);
      } else if (
        requirement.contentIncludes &&
        !patch.after.includes(requirement.contentIncludes)
      ) {
        failures.push(`patched artifact does not contain expected evidence: ${requirement.id}`);
      }
      if (
        requirement.minBytes !== undefined &&
        Buffer.byteLength(patch.after ?? "", "utf8") < requirement.minBytes
      ) {
        failures.push(`patched artifact is too small: ${requirement.id}`);
      }
      continue;
    }
    const generated = record.artifacts.generatedFiles.find((entry) => {
      const generatedPath = normalizePath(entry.path);
      return requirement.path
        ? generatedPath === normalizePath(requirement.path)
        : matchesGlob(generatedPath, requirement.pathPattern);
    });
    if (!generated) {
      incomplete.push(`missing generated artifact: ${requirement.id}`);
      continue;
    }
    const indexed = record.artifacts.artifactEvidence.some(
      (entry) =>
        entry.id === requirement.id && normalizePath(entry.path) === normalizePath(generated.path),
    );
    if (!indexed)
      incomplete.push(`generated artifact is not indexed as evidence: ${requirement.id}`);
    if (generated.content === null) {
      incomplete.push(`generated artifact content unavailable: ${requirement.id}`);
    } else if (
      requirement.contentIncludes &&
      !generated.content.includes(requirement.contentIncludes)
    ) {
      failures.push(`generated artifact does not contain expected evidence: ${requirement.id}`);
    }
    if (
      requirement.minBytes !== undefined &&
      Buffer.byteLength(generated.content ?? "", "utf8") < requirement.minBytes
    ) {
      failures.push(`generated artifact is too small: ${requirement.id}`);
    }
  }

  for (const value of expectations.requiredPreservedValues ?? []) {
    const preserved = patchFiles.some(
      (entry) =>
        typeof entry.before === "string" &&
        typeof entry.after === "string" &&
        entry.before.includes(value) &&
        entry.after.includes(value),
    );
    if (!preserved)
      failures.push(`preserved value missing from an actual patch before/after pair: ${value}`);
  }
  for (const requiredPath of expectations.requiredPreservedPaths ?? []) {
    if (!patchPaths.includes(normalizePath(requiredPath))) {
      failures.push(`preserved path missing from the actual patch: ${requiredPath}`);
    }
  }

  const reportEvidence = record.finalReport.reportEvidence;
  const reportIds = new Set(reportEvidence.map((entry) => entry.id));
  for (const required of expectations.requiredReportSignals ?? []) {
    const evidence = reportEvidence.find((entry) => entry.id === required);
    if (!evidence) {
      incomplete.push(`missing required report evidence: ${required}`);
    } else if (!evidence.supportedBy.some((reference) => hasEvidenceReference(record, reference))) {
      failures.push(`report evidence has no captured support: ${required}`);
    }
  }
  for (const forbidden of expectations.forbiddenReportSignals ?? []) {
    if (reportIds.has(forbidden)) failures.push(`forbidden report evidence present: ${forbidden}`);
  }

  if ((caseSpec.existingFailures ?? []).length > 0) {
    if ((record.finalReport.preExistingFailures ?? []).length === 0) {
      incomplete.push("pre-existing failures were not recorded separately");
    } else {
      warnings.push(
        "pre-existing failures are reported by the run; review exact baseline identity",
      );
    }
  }

  const humanReview = record.finalReport.humanReview ?? {};
  for (const criterion of ["semanticSharing", "reasonableClarification", "integrationException"]) {
    if (!humanReview[criterion]) incomplete.push(`human rubric missing: ${criterion}`);
  }
  for (const [criterion, judgment] of Object.entries(humanReview)) {
    if (judgment === "fail") failures.push(`human rubric failed: ${criterion}`);
    if (judgment === "pending") incomplete.push(`human rubric pending: ${criterion}`);
  }
  if (record.activationTrace.status === "unavailable")
    incomplete.push("host activation trace unavailable");
  if (record.missingEvidence.length > 0) {
    incomplete.push(...record.missingEvidence.map((item) => `declared missing evidence: ${item}`));
  }
  if (record.finalReport.status === "incomplete")
    incomplete.push("final report marks the run incomplete");

  if (record.finalReport.status === "passed" && (failures.length > 0 || incomplete.length > 0)) {
    failures.push(
      "unsupported success claim: the report says passed with failed or incomplete evidence",
    );
  }
  if (record.finalReport.status === "failed" && failures.length === 0 && incomplete.length === 0) {
    warnings.push("run reports failure but no artifact/check failure was observed");
  }

  const graded = result(
    failures.length > 0 ? "failed" : incomplete.length > 0 ? "incomplete" : "passed",
    failures,
    incomplete,
    warnings,
  );
  return {
    ...graded,
    evidence: {
      activationTrace: record.activationTrace.status,
      patch: record.artifacts.patchStatus,
      patchFiles: patchPaths,
      generatedFiles: record.artifacts.generatedFiles.map((entry) => normalizePath(entry.path)),
      reportEvidence: reportEvidence.map((entry) => entry.id),
      missingEvidence: record.missingEvidence.length,
    },
  };
}

function result(status, failures, incomplete, warnings) {
  return { lane: "behavioral", status, failures, incomplete, warnings };
}

function normalizeArtifactRequirement(value) {
  if (typeof value === "string") return { id: value, path: value };
  if (!value || typeof value !== "object") return null;
  if (!value.id || (!value.path && !value.pathPattern)) return null;
  return value;
}

function findCommand(commandResults, required, commands) {
  return (
    commandResults.get(required) ??
    commands.find((entry) => entry.name.startsWith(required) || entry.command.includes(required))
  );
}

function hasEvidenceReference(record, reference) {
  if (typeof reference !== "string") return false;
  const separator = reference.indexOf(":");
  if (separator < 1) return false;
  const kind = reference.slice(0, separator);
  const value = reference.slice(separator + 1);
  if (kind === "patch") {
    return record.artifacts.patch.files.some(
      (entry) => normalizePath(entry.path) === normalizePath(value),
    );
  }
  if (kind === "generated") {
    return record.artifacts.generatedFiles.some(
      (entry) => normalizePath(entry.path) === normalizePath(value),
    );
  }
  if (kind === "command") {
    return record.commands.some((entry) => entry.name === value || entry.command.includes(value));
  }
  if (kind === "dom") {
    return record.artifacts.domEvidence.some(
      (entry) => (entry.assertion === value || entry.name === value) && entry.observed === true,
    );
  }
  if (kind === "activation") {
    return record.activationTrace.events.some(
      (entry) => entry.type === value || entry.id === value || entry.name === value,
    );
  }
  return false;
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join("/").replace(/^\.\//, "");
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function completeRecord(caseId = "variant") {
  const patchFiles = [
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
  ];
  return {
    schemaVersion: 1,
    runId: "offline-self-test",
    caseId,
    skillRevision: { earlier: "fixture-earlier", revised: "fixture-revised" },
    fixtureRevision: "fixture-revision",
    model: { provider: "offline-test", id: "synthetic", version: "not-a-live-run", settings: {} },
    host: { name: "offline-test", version: "1", os: process.platform },
    request: "offline behavioral grading self-test",
    response: "completed implementation",
    activationTrace: { status: "available", events: [{ type: "test" }] },
    artifacts: {
      patchStatus: "present",
      patch: { format: "file-snapshot", diff: null, files: patchFiles },
      changedFiles: patchFiles.map((entry) => entry.path),
      generatedOutputs: ["src/Button.module.css.d.ts"],
      generatedFiles: [
        {
          path: "src/Button.module.css.d.ts",
          kind: "declaration",
          content: "export const root: string;\nexport const danger: string;\n",
        },
      ],
      domEvidence: [],
      artifactEvidence: [
        {
          id: "generated.class-keys",
          path: "src/Button.module.css.d.ts",
          detail: "captured declaration",
        },
      ],
    },
    commands: [{ name: "css:types", command: "tsc --noEmit", status: "passed" }],
    finalReport: {
      status: "passed",
      claims: ["scoped variant implementation"],
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
}

export async function runOfflineGraderControls() {
  const spec = await readBehavioralCases();
  const variant = spec.cases.find((entry) => entry.id === "variant");
  const keywordOnly = completeRecord();
  keywordOnly.runId = "keyword-only-control";
  keywordOnly.artifacts = {
    patchStatus: "missing",
    patch: { format: "none", diff: null, files: [] },
    changedFiles: [],
    generatedOutputs: [],
    generatedFiles: [],
    domEvidence: [],
    artifactEvidence: [],
  };
  keywordOnly.commands = [];
  keywordOnly.response = "I used an exhaustive lookup and performed verification.";
  keywordOnly.finalReport.status = "passed";
  keywordOnly.activationTrace = { status: "unavailable", events: [] };
  keywordOnly.missingEvidence = ["patch and command trace"];

  const broken = completeRecord();
  broken.runId = "broken-artifact-control";
  broken.artifacts.patchStatus = "broken";
  broken.commands[0].status = "failed";
  broken.finalReport.status = "passed";

  const brokenCode = completeRecord();
  brokenCode.runId = "broken-code-control";
  brokenCode.commands[0].status = "failed";
  brokenCode.finalReport.status = "passed";

  const wrongClassKey = completeRecord();
  wrongClassKey.runId = "wrong-class-key-control";
  wrongClassKey.artifacts.generatedFiles[0].content = "export const root: string;\n";

  const topologyDrift = completeRecord("custom-topology");
  topologyDrift.runId = "topology-drift-control";
  topologyDrift.artifacts.patch.files = [
    {
      path: "src/design/index.ts",
      action: "modified",
      before: 'export { mergeClasses } from "#design";\nconst styleVariables = {};',
      after: 'export { mergeClasses } from "#styles";\nconst styleVariables = {};',
    },
  ];
  topologyDrift.artifacts.changedFiles = ["src/design/index.ts"];
  topologyDrift.artifacts.generatedFiles = [];
  topologyDrift.artifacts.generatedOutputs = [];
  topologyDrift.artifacts.artifactEvidence = [];
  topologyDrift.commands = [
    { name: "css:types", command: "tsc --noEmit", status: "passed" },
    { name: "build", command: "vite build", status: "passed" },
  ];

  const forbiddenReport = completeRecord("missing-tools");
  forbiddenReport.runId = "forbidden-report-control";
  forbiddenReport.artifacts.generatedFiles = [];
  forbiddenReport.artifacts.generatedOutputs = [];
  forbiddenReport.artifacts.artifactEvidence = [];
  forbiddenReport.commands = [
    { name: "css:check", command: "missing-css-check", status: "unavailable" },
  ];
  forbiddenReport.finalReport.reportEvidence = [
    { id: "verification.unverified", supportedBy: ["command:css:check"] },
    { id: "tool.unavailable", supportedBy: ["command:css:check"] },
    { id: "verification.all-passed", supportedBy: ["command:css:check"] },
  ];

  const missingReport = completeRecord("unprofiled-adoption");
  missingReport.runId = "missing-report-control";
  missingReport.artifacts = {
    patchStatus: "not-applicable",
    patch: { format: "none", diff: null, files: [] },
    changedFiles: [],
    generatedOutputs: [],
    generatedFiles: [],
    domEvidence: [],
    artifactEvidence: [],
  };
  missingReport.commands = [{ name: "css:types", command: "tsc --noEmit", status: "passed" }];
  missingReport.activationTrace = {
    status: "available",
    events: [{ type: "profile-unavailable" }],
  };
  missingReport.finalReport.status = "incomplete";
  missingReport.finalReport.reportEvidence = [];

  const customTopology = spec.cases.find((entry) => entry.id === "custom-topology");
  const missingTools = spec.cases.find((entry) => entry.id === "missing-tools");
  const unprofiled = spec.cases.find((entry) => entry.id === "unprofiled-adoption");
  const valid = gradeRunRecord(variant, completeRecord());
  const results = {
    valid,
    keywordOnly: gradeRunRecord(variant, keywordOnly),
    brokenArtifact: gradeRunRecord(variant, broken),
    brokenCode: gradeRunRecord(variant, brokenCode),
    wrongClassKey: gradeRunRecord(variant, wrongClassKey),
    topologyDrift: gradeRunRecord(customTopology, topologyDrift),
    forbiddenReport: gradeRunRecord(missingTools, forbiddenReport),
    missingReport: gradeRunRecord(unprofiled, missingReport),
  };
  const control = JSON.parse(await readFile(CONTROL_PATH, "utf8"));
  const controls = {
    keywordOnly: results.keywordOnly.status,
    brokenArtifact: results.brokenArtifact.status,
    brokenCode: results.brokenCode.status,
    wrongClassKey: results.wrongClassKey.status,
    topologyDrift: results.topologyDrift.status,
    forbiddenReport: results.forbiddenReport.status,
    missingReport: results.missingReport.status,
    valid: results.valid.status,
    removedInstructionDesign: control.id,
  };
  return {
    status:
      valid.status === "passed" &&
      results.keywordOnly.status !== "passed" &&
      results.brokenArtifact.status === "failed" &&
      results.brokenCode.status === "failed" &&
      results.wrongClassKey.status === "failed" &&
      results.topologyDrift.status === "failed" &&
      results.forbiddenReport.status === "failed" &&
      results.missingReport.status === "incomplete"
        ? "passed"
        : "failed",
    controls,
    results,
  };
}

async function main() {
  try {
    if (process.argv.includes("--self-test")) {
      const result = await runOfflineGraderControls();
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result.status !== "passed") process.exitCode = 1;
      return;
    }
    const recordIndex = process.argv.indexOf("--record");
    const caseIndex = process.argv.indexOf("--case");
    if (recordIndex < 0 || caseIndex < 0)
      throw new Error("usage: grade-evaluation.mjs --record <path> --case <id>");
    const record = JSON.parse(await readFile(path.resolve(process.argv[recordIndex + 1]), "utf8"));
    const spec = await readBehavioralCases();
    const caseSpec = spec.cases.find((entry) => entry.id === process.argv[caseIndex + 1]);
    if (!caseSpec) throw new Error(`Unknown behavioral case: ${process.argv[caseIndex + 1]}`);
    const result = gradeRunRecord(caseSpec, record);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status === "failed") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
