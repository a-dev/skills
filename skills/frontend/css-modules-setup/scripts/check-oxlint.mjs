#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { oxlintRuleIds } from "../harness/oxlint-plugin.mjs";
import { validateProfile } from "./audit.mjs";

const CATEGORY_NAMES = [
  "correctness",
  "nursery",
  "pedantic",
  "perf",
  "restriction",
  "style",
  "suspicious",
];

function resolveInside(root, relativePath) {
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Oxlint path escapes the project root: ${relativePath}`);
  }
  return resolved;
}

async function readProfile(root, profilePath) {
  const profile = JSON.parse(await readFile(resolveInside(root, profilePath), "utf8"));
  const errors = validateProfile(profile);
  if (errors.length > 0) throw new Error(`Invalid CSS Modules profile: ${errors.join("; ")}`);
  return profile;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(glob) {
  let pattern = "^";
  const normalized = glob.split(path.sep).join("/");
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*" && normalized[index + 1] === "*") {
      if (normalized[index + 2] === "/") {
        pattern += "(?:.*/)?";
        index += 2;
      } else {
        pattern += ".*";
        index += 1;
      }
    } else if (character === "*") pattern += "[^/]*";
    else if (character === "?") pattern += "[^/]";
    else pattern += escapeRegExp(character);
  }
  return new RegExp(`${pattern}$`);
}

function matchesException(item, exception) {
  return (
    exception.kind === "rule" &&
    exception.rule === item.ruleId &&
    globToRegExp(exception.scope).test(item.file) &&
    (!exception.match || item.message.includes(exception.match))
  );
}

function oxlintBinary(root) {
  const resolvers = [
    createRequire(path.join(root, "package.json")),
    createRequire(import.meta.url),
  ];
  for (const resolveFrom of resolvers) {
    try {
      const packageJsonPath = resolveFrom.resolve("oxlint/package.json");
      return path.join(path.dirname(packageJsonPath), "bin", "oxlint");
    } catch {
      // Try the harness installation when a disposable test project has no dependencies.
    }
  }
  throw new Error(
    "Oxlint is not installed. Add the pinned oxlint dependency printed by the setup plan.",
  );
}

function runProcess(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function ruleIdOf(diagnostic) {
  const value = diagnostic.ruleId ?? diagnostic.code ?? "oxlint/parse-error";
  const match = String(value).match(/^([^()]+)\(([^()]+)\)$/);
  return match ? `${match[1]}/${match[2]}` : String(value);
}

function diagnosticLocation(diagnostic) {
  const label = diagnostic.labels?.find(({ primary }) => primary) ?? diagnostic.labels?.[0];
  const span = label?.span ?? diagnostic.span;
  return {
    line: diagnostic.line ?? span?.line ?? 1,
    column: diagnostic.column ?? span?.column ?? 1,
  };
}

function normalizeDiagnostics(payload, root, severity) {
  const parsed = JSON.parse(payload || "[]");
  if (Array.isArray(parsed) && parsed.some((item) => Array.isArray(item.messages))) {
    return parsed.flatMap((result) =>
      (result.messages ?? []).map((message) => ({
        engine: "oxlint",
        ruleId: ruleIdOf(message),
        file: path.relative(root, result.filePath).split(path.sep).join("/"),
        line: message.line ?? 1,
        column: message.column ?? 1,
        message: message.message,
        severity,
      })),
    );
  }
  const diagnostics = Array.isArray(parsed) ? parsed : (parsed.diagnostics ?? []);
  return diagnostics.map((diagnostic) => ({
    engine: "oxlint",
    ruleId: ruleIdOf(diagnostic),
    file: path
      .relative(root, diagnostic.filename ?? diagnostic.filePath ?? root)
      .split(path.sep)
      .join("/"),
    ...diagnosticLocation(diagnostic),
    message: diagnostic.message,
    severity,
  }));
}

export async function checkWithOxlint({
  root = process.cwd(),
  profilePath = ".agents/css-modules.json",
  severity,
} = {}) {
  const resolvedRoot = path.resolve(root);
  const profile = await readProfile(resolvedRoot, profilePath);
  const selectedSeverity = severity ?? profile.enforcement?.severity ?? "error";
  if (!["warning", "error"].includes(selectedSeverity))
    throw new Error("severity must be warning or error");

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "css-modules-oxlint-config-"));
  const configPath = path.join(temporaryRoot, ".oxlintrc.json");
  const pluginPath = fileURLToPath(new URL("../harness/oxlint-plugin.mjs", import.meta.url));
  const config = {
    categories: Object.fromEntries(CATEGORY_NAMES.map((name) => [name, "off"])),
    plugins: [],
    jsPlugins: [{ name: "css-modules", specifier: pathToFileURL(pluginPath).href }],
    rules: Object.fromEntries(
      oxlintRuleIds.map((id) => [
        `css-modules/${id}`,
        selectedSeverity === "error" ? "error" : "warn",
      ]),
    ),
    settings: {
      cssModules: {
        classNamesHelper: profile.helpers.classNames,
        cssVariablesHelper: profile.helpers.cssVariables,
        privateBooleanAttributes: profile.enforcement?.privateBooleanAttributes ?? ["data-loading"],
      },
    },
  };

  try {
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const target = resolveInside(resolvedRoot, profile.appRoot);
    const execution = await runProcess(
      process.execPath,
      [oxlintBinary(resolvedRoot), "--config", configPath, "--format", "json", target],
      resolvedRoot,
    );
    if (execution.signal || ![0, 1].includes(execution.code)) {
      throw new Error(
        execution.stderr.trim() ||
          execution.stdout.trim() ||
          `Oxlint exited with ${execution.signal ?? execution.code}`,
      );
    }
    const rawFindings = normalizeDiagnostics(execution.stdout, resolvedRoot, selectedSeverity).sort(
      (left, right) =>
        left.file.localeCompare(right.file) ||
        left.line - right.line ||
        left.column - right.column ||
        left.ruleId.localeCompare(right.ruleId),
    );
    const findings = [];
    const suppressed = [];
    for (const item of rawFindings) {
      const exception = (profile.exceptions ?? []).find((candidate) =>
        matchesException(item, candidate),
      );
      if (exception) suppressed.push({ finding: item, exception });
      else findings.push(item);
    }
    const status = findings.some(({ severity: itemSeverity }) => itemSeverity === "error")
      ? "failed"
      : findings.length > 0
        ? "warnings"
        : "passed";
    return {
      root: resolvedRoot,
      profilePath,
      severity: selectedSeverity,
      status,
      findings,
      suppressed,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export function exitCodeForOxlint(result) {
  return result.status === "failed" ? 1 : 0;
}

export function formatOxlint(result) {
  const lines = [`CSS Modules Oxlint checks: ${result.root}`, ""];
  for (const item of result.findings) {
    lines.push(
      `${item.severity.toUpperCase()} ${item.file}:${item.line}:${item.column} ${item.ruleId} ${item.message}`,
    );
  }
  if (result.findings.length === 0) lines.push("No violations.");
  if (result.suppressed.length > 0)
    lines.push("", `Suppressed by documented exceptions: ${result.suppressed.length}`);
  lines.push("", `Result: ${result.status}`);
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = { root: process.cwd(), profilePath: ".agents/css-modules.json", format: "human" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") options.root = argv[++index];
    else if (argument === "--profile") options.profilePath = argv[++index];
    else if (argument === "--format") options.format = argv[++index];
    else if (argument === "--severity") options.severity = argv[++index];
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!["human", "json"].includes(options.format)) throw new Error("format must be human or json");
  return options;
}

function usage() {
  return [
    "Usage: node check-oxlint.mjs [options]",
    "",
    "--root <path>          project root; defaults to cwd",
    "--profile <path>       profile path relative to root",
    "--severity <level>     warning or error; overrides the profile migration level",
    "--format <human|json>  output format",
  ].join("\n");
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    const result = await checkWithOxlint(options);
    process.stdout.write(
      options.format === "json"
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${formatOxlint(result)}\n`,
    );
    process.exitCode = exitCodeForOxlint(result);
  } catch (error) {
    process.stderr.write(`CSS Modules Oxlint checks failed: ${error.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
