import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createServer, preview } from "vite";

const BROWSER_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.dirname(BROWSER_ROOT);
const REPOSITORY_ROOT = path.resolve(SKILL_ROOT, "../../..");
const FIXTURE_ROOT = path.join(SKILL_ROOT, "fixtures", "vite-react");
const activeTemporaryRoots = new Set();

process.on("exit", () => {
  for (const root of activeTemporaryRoots) rmSync(root, { recursive: true, force: true });
});

export async function startReferenceServer({
  mode = "development",
  port,
  removeForcedColors = false,
  removeReducedMotion = false,
  reverseImportOrder = false,
}) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "css-modules-browser-case-"));
  const fixture = path.join(temporaryRoot, "fixture");
  activeTemporaryRoots.add(temporaryRoot);
  let server;
  let closed = false;

  try {
    await cp(FIXTURE_ROOT, fixture, { recursive: true });
    await symlink(
      path.join(REPOSITORY_ROOT, "node_modules"),
      path.join(fixture, "node_modules"),
      "dir",
    );

    const cssPath = path.join(fixture, "src/reference-button.module.css");
    let css = await readFile(cssPath, "utf8");
    if (removeForcedColors) css = removeMediaBlock(css, "forced-colors: active");
    if (removeReducedMotion) css = removeMediaBlock(css, "prefers-reduced-motion: reduce");
    await writeFile(cssPath, css);

    if (reverseImportOrder) {
      const mainPath = path.join(fixture, "src/main.tsx");
      const source = await readFile(mainPath, "utf8");
      await writeFile(mainPath, reverseFixtureImports(source));
    }

    const configFile = path.join(fixture, "vite.config.ts");
    if (mode === "production") {
      const buildResult = await run(
        path.join(REPOSITORY_ROOT, "node_modules/.bin/vite"),
        ["build", "--config", configFile, "--configLoader", "runner", "--logLevel", "error"],
        fixture,
      );
      if (buildResult.code !== 0) {
        throw new Error(
          `Reference production build failed:\n${buildResult.stdout}${buildResult.stderr}`,
        );
      }
      server = await preview({
        root: fixture,
        configFile,
        server: { host: "127.0.0.1", port, strictPort: true },
        preview: { host: "127.0.0.1", port, strictPort: true },
        logLevel: "error",
      });
    } else {
      server = await createServer({
        root: fixture,
        configFile,
        configLoader: "runner",
        logLevel: "error",
        server: { host: "127.0.0.1", port, strictPort: true },
      });
      await server.listen();
    }

    return {
      url: `http://127.0.0.1:${port}`,
      temporaryRoot,
      async close() {
        if (closed) return;
        closed = true;
        activeTemporaryRoots.delete(temporaryRoot);
        rmSync(temporaryRoot, { recursive: true, force: true });
        await server?.close();
        await rm(temporaryRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    activeTemporaryRoots.delete(temporaryRoot);
    rmSync(temporaryRoot, { recursive: true, force: true });
    if (server) await server.close().catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

function run(command, args, cwd) {
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
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function removeMediaBlock(source, condition) {
  const pattern = new RegExp(
    `\\n  @media \\(${condition.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\) \\{[\\s\\S]*?\\n  \\}\\n`,
  );
  const next = source.replace(pattern, "\n");
  if (next === source) throw new Error(`Could not remove the ${condition} fixture rule`);
  return next;
}

function reverseFixtureImports(source) {
  const lines = source.split("\n");
  const globalIndex = lines.findIndex((line) => line === 'import "#styles/global.css";');
  const probeIndex = lines.findIndex((line) =>
    line.startsWith('import probeStyles from "./unlayered-probe.module.css"'),
  );
  if (globalIndex < 0 || probeIndex < 0)
    throw new Error("Fixture import-order markers are missing");
  [lines[globalIndex], lines[probeIndex]] = [lines[probeIndex], lines[globalIndex]];
  return lines.join("\n");
}
