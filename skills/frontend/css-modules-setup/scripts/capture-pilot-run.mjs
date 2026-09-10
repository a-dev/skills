#!/usr/bin/env node

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runDeclaredCheck } from "./run-eval-fixtures.mjs";
import { readBehavioralCases } from "./validate-eval-fixtures.mjs";

const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_ROOT, "../../../..");
const SKILL_PATH = "skills/frontend/css-modules/SKILL.md";
const REPORT_STATUSES = new Set(["passed", "failed", "incomplete"]);

export async function capturePilotRun({ run, caseId, model, revision, repeat }) {
  const runRoot = path.resolve(run);
  const workspace = path.join(runRoot, "workspace");
  const baseline = path.join(runRoot, "baseline");
  const spec = await readBehavioralCases();
  const caseSpec = spec.cases.find((entry) => entry.id === caseId);
  if (!caseSpec) throw new Error(`Unknown behavioral case: ${caseId}`);

  const patchFiles = await capturePatch(baseline, workspace);
  const generatedFiles = await captureGeneratedFiles(baseline, workspace);
  const commands = await runDeclaredCommands(caseSpec, workspace);
  const modelReport = await readOptionalJson(path.join(runRoot, "model-report.json"));
  const activationTrace = await readOptionalJson(path.join(runRoot, "activation-trace.json"));
  const normalizedReport = normalizeFinalReport(modelReport?.finalReport);
  const finalReport = normalizedReport.report;
  const missingEvidence = [
    ...normalizedReport.missingEvidence,
    ...(modelReport ? [] : ["model-report.json"]),
    ...(activationTrace ? [] : ["activation-trace.json"]),
    ...(patchFiles.length > 0 || generatedFiles.length > 0
      ? []
      : ["actual patch or generated artifact"]),
  ];
  const record = {
    schemaVersion: 1,
    runId: path.basename(runRoot),
    caseId,
    skillRevision: {
      earlier: revision === "earlier" ? `git:${await gitHead()}:${SKILL_PATH}` : "not-applicable",
      revised:
        revision === "revised"
          ? `worktree:${await sha256(path.join(REPOSITORY_ROOT, SKILL_PATH))}`
          : "not-applicable",
    },
    fixtureRevision: `behavioral-case-v1:${caseSpec.fixture}`,
    model: {
      provider: "openai",
      id: model,
      version: `selected-route:${model}; backend build not exposed by host`,
      settings: { reasoningEffort: "medium", serviceTier: "priority", repeat },
    },
    host: {
      name: "Codex local",
      version: "desktop host build not exposed by host",
      os: process.platform,
    },
    request: caseSpec.request,
    response: modelReport?.response ?? null,
    activationTrace: activationTrace ?? { status: "unavailable", events: [] },
    artifacts: {
      patchStatus: patchFiles.length > 0 ? "present" : "missing",
      patch: { format: "file-snapshot", diff: null, files: patchFiles },
      changedFiles: patchFiles.map((entry) => entry.path),
      generatedOutputs: generatedFiles.map((entry) => entry.path),
      generatedFiles,
      domEvidence: modelReport?.domEvidence ?? [],
      artifactEvidence: modelReport?.artifactEvidence ?? [],
    },
    commands,
    finalReport,
    missingEvidence: [...new Set([...(finalReport.unverified ?? []), ...missingEvidence])],
  };
  await writeFile(
    path.join(runRoot, "run-record.json"),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
  return record;
}

async function capturePatch(baselineRoot, workspaceRoot) {
  const before = await textFiles(baselineRoot);
  const after = await textFiles(workspaceRoot);
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  return paths
    .filter((filePath) => !isGenerated(filePath) && !isOperationalArtifact(filePath))
    .flatMap((filePath) => {
      const oldContent = before.get(filePath);
      const newContent = after.get(filePath);
      if (oldContent === newContent) return [];
      return [
        {
          path: filePath,
          action:
            oldContent === undefined
              ? "created"
              : newContent === undefined
                ? "deleted"
                : "modified",
          before: oldContent ?? null,
          after: newContent ?? null,
        },
      ];
    });
}

function isOperationalArtifact(filePath) {
  return (
    filePath.startsWith("command-output/") ||
    filePath.startsWith(".npm-logs/") ||
    filePath.endsWith(".log")
  );
}

function normalizeFinalReport(rawReport) {
  if (!rawReport || typeof rawReport !== "object" || Array.isArray(rawReport)) {
    return {
      report: incompleteReport("finalReport was missing or not an object"),
      missingEvidence: ["finalReport was missing or not an object"],
    };
  }

  const report = { ...rawReport };
  const missingEvidence = [];
  if (!REPORT_STATUSES.has(report.status)) {
    missingEvidence.push(`finalReport.status was non-canonical: ${String(report.status)}`);
    report.status = "incomplete";
  }

  for (const field of ["claims", "unverified", "preExistingFailures"]) {
    if (!Array.isArray(report[field])) {
      missingEvidence.push(`finalReport.${field} was not an array`);
      report[field] = [];
    }
  }

  if (!Array.isArray(report.reportEvidence)) {
    missingEvidence.push("finalReport.reportEvidence was not an array");
    report.reportEvidence = [];
  } else {
    report.reportEvidence = report.reportEvidence.map((entry, index) => {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const id =
          typeof entry.id === "string" && entry.id.length > 0
            ? entry.id
            : `raw-report-evidence-${index}`;
        const supportedBy =
          Array.isArray(entry.supportedBy) && entry.supportedBy.length > 0
            ? entry.supportedBy
            : ["raw:model-report"];
        if (id !== entry.id || supportedBy[0] === "raw:model-report") {
          missingEvidence.push(`finalReport.reportEvidence[${index}] lacked canonical support`);
        }
        return { ...entry, id, supportedBy };
      }
      missingEvidence.push(`finalReport.reportEvidence[${index}] was an unstructured value`);
      return {
        id: typeof entry === "string" && entry.length > 0 ? entry : `raw-report-evidence-${index}`,
        supportedBy: ["raw:model-report"],
      };
    });
  }
  return { report, missingEvidence };
}

async function captureGeneratedFiles(baselineRoot, workspaceRoot) {
  const before = await textFiles(baselineRoot);
  const after = await textFiles(workspaceRoot);
  return [...after.entries()]
    .filter(([filePath, content]) => isGenerated(filePath) && before.get(filePath) !== content)
    .map(([filePath, content]) => ({
      path: filePath,
      kind: filePath.endsWith(".d.ts")
        ? "declaration"
        : filePath.endsWith(".map")
          ? "map"
          : "other",
      content,
    }));
}

function isGenerated(filePath) {
  return (
    filePath.endsWith(".d.ts") || filePath.endsWith(".d.ts.map") || filePath.endsWith(".css.map")
  );
}

async function textFiles(root, output = new Map(), relative = "") {
  if (!(await exists(root))) return output;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (["node_modules", "dist", "test-results"].includes(entry.name)) continue;
    const filePath = path.join(root, entry.name);
    const relativePath = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) await textFiles(filePath, output, relativePath);
    else if (entry.isFile()) output.set(relativePath, await readFile(filePath, "utf8"));
  }
  return output;
}

async function runDeclaredCommands(caseSpec, workspace) {
  const results = [];
  for (const check of caseSpec.checks) {
    if (check === "setup bootstrap") {
      results.push(await runSetupBootstrap(workspace));
    } else {
      results.push(
        await runDeclaredCheck(caseSpec, workspace, check, {
          browser: true,
          expectedCase: caseSpec.id,
        }),
      );
    }
  }
  return results;
}

async function runSetupBootstrap(workspace) {
  const executable = path.join(
    REPOSITORY_ROOT,
    "skills/frontend/css-modules-setup/scripts/setup.mjs",
  );
  const result = await spawnCommand(
    process.execPath,
    [executable, "bootstrap", "--root", workspace, "--format", "json"],
    workspace,
  );
  return {
    name: "setup bootstrap",
    command: "setup.mjs bootstrap --root <workspace> --format json",
    status: result.code === 0 ? "passed" : "failed",
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function spawnCommand(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function incompleteReport(reason) {
  return {
    status: "incomplete",
    claims: [],
    reportEvidence: [],
    unverified: [reason],
    preExistingFailures: [],
    humanReview: {
      semanticSharing: "pending",
      reasonableClarification: "pending",
      integrationException: "pending",
    },
  };
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function gitHead() {
  const result = await spawnCommand("git", ["rev-parse", "HEAD"], REPOSITORY_ROOT);
  if (result.code !== 0) throw new Error(result.stderr || "Unable to resolve git HEAD");
  return result.stdout.trim();
}

async function sha256(filePath) {
  const result = await spawnCommand("shasum", ["-a", "256", filePath], REPOSITORY_ROOT);
  if (result.code !== 0) throw new Error(result.stderr || "Unable to hash skill revision");
  return result.stdout.trim().split(/\s+/)[0];
}

function parseArgs(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    if (index < 0 || !argv[index + 1]) throw new Error(`${name} is required`);
    return argv[index + 1];
  };
  return {
    run: value("--run"),
    caseId: value("--case"),
    model: value("--model"),
    revision: value("--revision"),
    repeat: Number(value("--repeat")),
  };
}

async function main() {
  try {
    const result = await capturePilotRun(parseArgs(process.argv.slice(2)));
    process.stdout.write(
      `${JSON.stringify({ runId: result.runId, status: result.finalReport.status }, null, 2)}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
