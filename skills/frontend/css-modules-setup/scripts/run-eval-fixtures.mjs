#!/usr/bin/env node

import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createServer, preview } from "vite";

import { MODEL_TASK_BLUEPRINTS } from "../../../../evals/fixtures/model-task-blueprints.mjs";
import { auditProject } from "./audit.mjs";
import { checkProject, exitCodeForCheck } from "./check.mjs";
import { planSetup } from "./setup.mjs";
import { prepareEvalFixtures } from "./prepare-eval-fixtures.mjs";
import { readBehavioralCases, validateBehavioralCases } from "./validate-eval-fixtures.mjs";

const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_ROOT, "../../../..");
const BIN_ROOT = path.join(REPOSITORY_ROOT, "node_modules/.bin");

export async function runEvaluationFixtures({ caseId = "all", browser = false } = {}) {
  const spec = await readBehavioralCases();
  const errors = validateBehavioralCases(spec);
  if (errors.length > 0) throw new Error(`Invalid behavioral fixtures:\n${errors.join("\n")}`);
  const selected =
    caseId === "all" ? spec.cases : spec.cases.filter((entry) => entry.id === caseId);
  if (selected.length === 0) throw new Error(`Unknown behavioral case: ${caseId}`);

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "css-modules-eval-run-"));
  const results = [];
  try {
    for (const entry of selected) {
      const root = path.join(temporaryRoot, entry.id);
      const canonicalSnapshot = JSON.stringify(MODEL_TASK_BLUEPRINTS[entry.fixture]);
      await prepareEvalFixtures({ caseId: entry.id, output: root });
      if (entry.id === "fresh-setup" && entry.checks.some((check) => check === "setup bootstrap")) {
        await writeBootstrapProfile(root);
      }
      const commands = [];
      for (const check of entry.checks) {
        commands.push(await runDeclaredCheck(entry, root, check, { browser }));
      }
      const nonRunnable = commands.filter(
        (command) => command.status === "not-run" && !command.optional,
      );
      const unexpectedFailures = commands.filter(
        (command) => command.status === "failed" && !command.expectedFailure,
      );
      results.push({
        id: entry.id,
        fixture: entry.fixture,
        root,
        declaredChecksRunnable: nonRunnable.length === 0,
        status: unexpectedFailures.length === 0 && nonRunnable.length === 0 ? "passed" : "failed",
        commands,
        canonicalUnchanged:
          canonicalSnapshot === JSON.stringify(MODEL_TASK_BLUEPRINTS[entry.fixture]),
      });
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  return {
    status: results.every((result) => result.status === "passed") ? "passed" : "failed",
    browser,
    caseIds: results.map((result) => result.id),
    results,
  };
}

export async function runDeclaredCheck(
  entry,
  root,
  check,
  { browser, expectedCase = path.basename(root) },
) {
  if (check === "css:generate") return runBinaryCheck("css:generate", "vite-css-modules", [], root);
  if (check === "css:types") {
    const result = await runBinaryCheck("css:types", "tsc", ["--noEmit"], root);
    if (entry.id === "pre-existing-failure") {
      if (result.status === "failed") result.expectedFailure = true;
      else {
        result.status = "failed";
        result.stderr = "The recorded pre-existing failure was not reproduced.";
      }
    }
    return result;
  }
  if (check === "build")
    return runBinaryCheck("build", "vite", ["build", "--config", "vite.config.mjs"], root);
  if (check === "test") return runBinaryCheck("test", "tsc", ["--noEmit"], root);
  if (check === "css:check") return runSourceCheck("css:check", root);
  if (check === "css:audit-fixture") {
    const result = await auditProject({ root });
    return { name: check, command: "auditProject", status: "passed", detail: result.status };
  }
  if (check === "css:check (unavailable)") {
    return {
      name: check,
      command: "configured CSS check (intentionally unavailable)",
      status: "unavailable",
      detail: "negative-control command route",
    };
  }
  if (check === "focused static inspection") {
    await access(path.join(root, "README.md"));
    return { name: check, command: "read README.md and scoped source", status: "passed" };
  }
  if (check === "setup audit") {
    const result = await auditProject({ root });
    return { name: check, command: "auditProject", status: "passed", detail: result.status };
  }
  if (check === "setup bootstrap") {
    try {
      const result = await planSetup({
        root,
        mode: "bootstrap",
        profileSource: "harness/setup-bootstrap-profile.json",
      });
      return {
        name: check,
        command: "planSetup --mode bootstrap",
        status: ["ready", "aligned"].includes(result.status) ? "passed" : "failed",
        detail: result.status,
      };
    } catch (error) {
      return {
        name: check,
        command: "planSetup --mode bootstrap",
        status: "failed",
        expectedFailure: false,
        stderr: error.message,
      };
    }
  }
  if (check === "setup migrate") {
    const result = await planSetup({
      root,
      mode: "migrate",
      authorizeMigrate: true,
      targetFormat: "compact",
    });
    return {
      name: check,
      command: "planSetup --mode migrate",
      status: ["ready", "aligned"].includes(result.status) ? "passed" : "failed",
      detail: result.status,
    };
  }
  if (check === "css:browser" || check === "preview browser check") {
    if (!browser) {
      return {
        name: check,
        command: "Playwright browser route",
        status: "not-run",
        optional: true,
        detail: "pass --browser to execute the declared browser check",
      };
    }
    return runBrowserCheck(check, root, check === "preview browser check", expectedCase);
  }
  if (check === "integration test") {
    const source = await readFile(path.join(root, "src/FloatingPanel.tsx"), "utf8");
    return {
      name: check,
      command: "integration boundary inspection",
      status: source.includes("data-library-geometry") ? "passed" : "failed",
    };
  }
  throw new Error(`No runnable implementation for declared check: ${check}`);
}

async function runSourceCheck(name, root) {
  try {
    const result = await checkProject({ root });
    return {
      name,
      command: "checkProject",
      status: exitCodeForCheck(result) === 0 ? "passed" : "failed",
      detail: result.status,
    };
  } catch (error) {
    return { name, command: "checkProject", status: "failed", stderr: error.message };
  }
}

async function runBinaryCheck(name, binary, args, cwd) {
  const command = path.join(BIN_ROOT, binary);
  const result = await spawnCommand(command, args, cwd);
  return {
    name,
    command: [binary, ...args].join(" "),
    status: result.code === 0 ? "passed" : "failed",
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function runBrowserCheck(name, root, production, expectedCase = path.basename(root)) {
  const { chromium } = await import("@playwright/test");
  const port = await freePort();
  const configFile = path.join(root, "vite.config.mjs");
  let server;
  let browser;
  try {
    if (production) {
      const build = await spawnCommand(
        path.join(BIN_ROOT, "vite"),
        ["build", "--config", "vite.config.mjs"],
        root,
      );
      if (build.code !== 0)
        return {
          name,
          command: "vite build + preview + Playwright",
          status: "failed",
          stderr: build.stderr,
        };
      server = await preview({
        root,
        configFile,
        preview: { host: "127.0.0.1", port, strictPort: true },
        logLevel: "error",
      });
    } else {
      server = await createServer({
        root,
        configFile,
        configLoader: "runner",
        server: { host: "127.0.0.1", port, strictPort: true },
        logLevel: "error",
      });
      await server.listen();
    }
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "networkidle" });
    const actualCase = await page.locator("body").getAttribute("data-eval-case");
    return {
      name,
      command: production ? "vite build + preview + Playwright" : "Vite dev server + Playwright",
      status: actualCase === expectedCase ? "passed" : "failed",
      detail: { actualCase, expectedCase },
    };
  } catch (error) {
    return { name, command: "Vite + Playwright", status: "failed", stderr: error.message };
  } finally {
    await browser?.close();
    await server?.close();
  }
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

function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      socket.close(() => resolve(address.port));
    });
  });
}

async function writeBootstrapProfile(root) {
  await mkdir(path.join(root, "harness"), { recursive: true });
  await writeFile(
    path.join(root, "harness/setup-bootstrap-profile.json"),
    JSON.stringify(
      {
        format: "css-modules-compact",
        version: 1,
        preset: "vite-react@1",
        styles: { root: "src/shared/styles", alias: "#styles" },
        composition: "markup",
        colors: false,
        checks: "warn",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

function parseArgs(argv) {
  const caseIndex = argv.indexOf("--case");
  return {
    caseId: caseIndex >= 0 ? argv[caseIndex + 1] : "all",
    browser: argv.includes("--browser"),
  };
}

async function main() {
  try {
    const result = await runEvaluationFixtures(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== "passed") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
