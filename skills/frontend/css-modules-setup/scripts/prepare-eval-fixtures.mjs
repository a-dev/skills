#!/usr/bin/env node

import { access, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { MODEL_TASK_BLUEPRINTS } from "../../../../evals/fixtures/model-task-blueprints.mjs";
import { readBehavioralCases, validateBehavioralCases } from "./validate-eval-fixtures.mjs";

const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_ROOT, "../../../..");

export async function prepareEvalFixtures({ caseId, output }) {
  const spec = await readBehavioralCases();
  const errors = validateBehavioralCases(spec);
  if (errors.length > 0) throw new Error(`Invalid behavioral fixtures:\n${errors.join("\n")}`);
  const selected =
    caseId === "all" ? spec.cases : spec.cases.filter((entry) => entry.id === caseId);
  if (selected.length === 0) throw new Error(`Unknown behavioral case: ${caseId}`);
  if (!output) throw new Error("--output is required");

  await ensureEmptyDestination(output);
  for (const entry of selected) {
    const destination = selected.length === 1 ? output : path.join(output, entry.id);
    await mkdir(destination, { recursive: true });
    for (const [relativePath, content] of Object.entries(MODEL_TASK_BLUEPRINTS[entry.fixture])) {
      const filePath = path.join(destination, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf8");
    }
    await scaffoldRunnableFixture(destination, entry);
  }
  return {
    status: "prepared",
    caseIds: selected.map((entry) => entry.id),
    output: path.resolve(output),
    instructions: selected.map(
      ({ id, allowedEdits, existingFailures, checks, judgmentQuestions }) => ({
        id,
        allowedEdits,
        existingFailures,
        checks,
        judgmentQuestions,
      }),
    ),
  };
}

async function scaffoldRunnableFixture(destination, entry) {
  const packagePath = path.join(destination, "package.json");
  let packageJson = {};
  try {
    packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  packageJson.private ??= true;
  packageJson.type ??= "module";
  packageJson.scripts = {
    ...(packageJson.scripts ?? {}),
    "css:generate": "vite-css-modules",
    "css:types": "tsc --noEmit",
    build: "vite build --config vite.config.mjs",
  };
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");

  await writeTextIfAbsent(
    path.join(destination, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["ES2022", "DOM"],
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "react-jsx",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          paths: {
            "#styles": ["./src/shared/styles/index.ts"],
            "#styles/*": ["./src/shared/styles/*"],
            "#design": ["./src/design/index.ts"],
            "#design/*": ["./src/design/*"],
          },
        },
        include: ["src"],
      },
      null,
      2,
    ) + "\n",
  );
  await writeTextIfAbsent(
    path.join(destination, "vite.config.mjs"),
    'import { defineConfig } from "vite";\nimport { patchCssModules } from "vite-css-modules";\nimport path from "node:path";\nimport { fileURLToPath } from "node:url";\n\nconst root = path.dirname(fileURLToPath(import.meta.url));\nexport default defineConfig({\n  plugins: [patchCssModules()],\n  resolve: {\n    alias: {\n      "#styles": path.join(root, "src/shared/styles"),\n      "#design": path.join(root, "src/design"),\n    },\n  },\n});\n',
  );
  await writeTextIfAbsent(
    path.join(destination, "index.html"),
    '<!doctype html>\n<html><head><meta charset="UTF-8"><title>Evaluation fixture</title></head><body><script type="module" src="/src/eval-main.ts"></script></body></html>\n',
  );
  await writeTextIfAbsent(
    path.join(destination, "src/eval-main.ts"),
    `import styles from "./eval.module.css";\n\ndocument.body.dataset.evalCase = ${JSON.stringify(entry.id)};\ndocument.body.className = styles.root;\n`,
  );
  await writeTextIfAbsent(
    path.join(destination, "src/eval.module.css"),
    ".root { min-height: 1px; }\n",
  );
  await writeTextIfAbsent(
    path.join(destination, "src/css-modules.d.ts"),
    'declare module "*.module.css" {\n  const classes: Record<string, string>;\n  export default classes;\n}\ndeclare module "#styles/*";\ndeclare module "#styles";\ndeclare module "#design/*";\ndeclare module "#design";\n',
  );
  if (entry.id !== "fresh-setup") {
    await writeTextIfAbsent(path.join(destination, "src/shared/styles/global.css"), ":root {}\n");
    await writeTextIfAbsent(path.join(destination, "src/shared/styles/index.ts"), "export {};\n");
  }

  const repositoryNodeModules = path.resolve(REPOSITORY_ROOT, "node_modules");
  const fixtureNodeModules = path.join(destination, "node_modules");
  try {
    await access(repositoryNodeModules);
    await symlink(repositoryNodeModules, fixtureNodeModules, "dir");
  } catch (error) {
    if (error.code !== "EEXIST" && error.code !== "ENOENT") throw error;
  }
}

async function writeTextIfAbsent(filePath, content) {
  try {
    await access(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
  }
}

async function ensureEmptyDestination(destination) {
  const absolute = path.resolve(destination);
  try {
    const entries = await readdir(absolute);
    if (entries.length > 0)
      throw new Error(`Refusing to overwrite non-empty evaluation output: ${absolute}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(absolute, { recursive: true });
  }
}

function parseArgs(argv) {
  const caseIndex = argv.indexOf("--case");
  const outputIndex = argv.indexOf("--output");
  return {
    caseId: caseIndex >= 0 ? argv[caseIndex + 1] : undefined,
    output: outputIndex >= 0 ? argv[outputIndex + 1] : undefined,
  };
}

async function main() {
  try {
    const result = await prepareEvalFixtures(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
