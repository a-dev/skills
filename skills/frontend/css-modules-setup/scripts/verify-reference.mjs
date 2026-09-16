#!/usr/bin/env node

import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { checkProject } from "./check.mjs";
import { readResolvedContract } from "./contract.mjs";
import { applySetupPlan, planSetup } from "./setup.mjs";

const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.dirname(SCRIPT_ROOT);
const REPOSITORY_ROOT = path.resolve(SKILL_ROOT, "../../..");
const FIXTURE_ROOT = path.join(SKILL_ROOT, "fixtures", "vite-react");

async function writeProjectFile(root, relativePath, content) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

function generatedProfile(custom) {
  const alias = custom ? "#design" : "#styles";
  const stylesRoot = custom ? "src/design/styles" : "src/shared/styles";
  const entryPoint = custom ? "src/design/index.ts" : `${stylesRoot}/index.ts`;
  return {
    methodologyVersion: "1.0.0",
    profileSchemaVersion: 1,
    adapter: { name: "vite-react", version: "1.0.0" },
    appRoot: ".",
    stylesRoot,
    globalStylesheet: `${stylesRoot}/global.css`,
    alias: { bare: alias, subpath: `${alias}/*` },
    helpers: custom
      ? { classNames: "mergeClasses", cssVariables: "styleVariables" }
      : { classNames: "cx", cssVariables: "cssVars" },
    sharedApi: {
      entryPoint,
      modules: [
        {
          name: "layout",
          export: "layout",
          path: `${stylesRoot}/layout.module.css`,
          layer: "primitives",
        },
      ],
      admissionRule: { strategy: "project-review" },
    },
    layers: {
      order: ["reset", "primitives", "ui"],
      ownership: [{ glob: `${stylesRoot}/*.module.css`, layer: "primitives" }],
      localModules: { strategy: "unlayered" },
    },
    composition: { mode: "markup" },
    colorTokens: { enabled: false },
    commands: {
      "css:generate": "vite-css-modules",
      "css:types": "tsc --noEmit",
    },
    exceptions: [],
  };
}

function viteConfig(custom) {
  const alias = custom ? "#design" : "#styles";
  const entryPoint = custom ? "src/design/index.ts" : "src/shared/styles/index.ts";
  const stylesRoot = custom ? "src/design/styles" : "src/shared/styles";
  return `import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import { patchCssModules } from "vite-css-modules";

const root = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig({
  resolve: {
    alias: [
      { find: /^${alias}$/, replacement: fileURLToPath(new URL("./${entryPoint}", import.meta.url)) },
      { find: /^${alias}\\//, replacement: fileURLToPath(new URL("./${stylesRoot}/", import.meta.url)) },
    ],
  },
  css: { modules: { localsConvention: "camelCaseOnly" } },
  plugins: [react(), patchCssModules({ generateSourceTypes: true, declarationMap: true })],
  root,
});
`;
}

async function writeAgentIntegration(root, profile, custom) {
  const alias = custom ? "#design" : "#styles";
  const stylesRoot = custom ? "src/design/styles" : "src/shared/styles";
  const entryPoint = custom ? "src/design/index.ts" : "src/shared/styles/index.ts";
  await writeProjectFile(
    root,
    "package.json",
    `${JSON.stringify(
      {
        private: true,
        type: "module",
        packageManager: "npm@11.0.0",
        imports: {
          [alias]: `./${entryPoint}`,
          [`${alias}/*`]: `./${stylesRoot}/*`,
        },
        scripts: {
          "css:generate": profile.commands["css:generate"],
          "css:types": profile.commands["css:types"],
          build: "vite build --config vite.config.ts --configLoader runner --logLevel warn",
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeProjectFile(root, "package-lock.json", "{}\n");
  await writeProjectFile(
    root,
    "tsconfig.json",
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["ES2022", "DOM"],
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          noEmit: true,
          jsx: "react-jsx",
          paths: {
            [alias]: [`./${entryPoint}`],
            [`${alias}/*`]: [`./${stylesRoot}/*`],
          },
        },
        include: ["src"],
      },
      null,
      2,
    )}\n`,
  );
  await writeProjectFile(root, "vite.config.ts", viteConfig(custom));
  await writeProjectFile(
    root,
    "index.html",
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n',
  );
  await writeProjectFile(root, "src/vite-env.d.ts", '/// <reference types="vite/client" />\n');
  await writeProjectFile(
    root,
    "src/main.tsx",
    `import "${alias}/global.css";
import { layout } from "${alias}";
import localStyles from "./local.module.css";

export const generatedClassName = [layout.cluster, localStyles.button].join(" ");
`,
  );
  await writeProjectFile(
    root,
    "src/local.module.css",
    `.button {
  composes: cluster from "${alias}/layout.module.css";
  color: red;
}
`,
  );
}

async function runGeneratedScenario(custom, { migrate = false } = {}) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "css-modules-generated-"));
  const profile = generatedProfile(custom);
  const profileSource = "selected-profile.json";
  const inputsPath = "setup-inputs.json";
  const alias = custom ? "#design" : "#styles";
  try {
    await writeProjectFile(temporaryRoot, profileSource, `${JSON.stringify(profile, null, 2)}\n`);
    await writeProjectFile(
      temporaryRoot,
      inputsPath,
      JSON.stringify(
        {
          sharedModules: {
            layout: { className: "cluster", declarations: "display: flex;" },
          },
        },
        null,
        2,
      ) + "\n",
    );
    await writeAgentIntegration(temporaryRoot, profile, custom);
    await symlink(
      path.join(REPOSITORY_ROOT, "node_modules"),
      path.join(temporaryRoot, "node_modules"),
      "dir",
    );

    const plan = await planSetup({
      root: temporaryRoot,
      mode: "bootstrap",
      profileSource,
      inputsPath,
    });
    if (plan.status !== "ready") {
      throw new Error(
        `Generated ${custom ? "custom" : "default"} plan was ${plan.status}: ${JSON.stringify(plan)}`,
      );
    }
    const applied = await applySetupPlan(plan);

    const generatedCli = path.join(temporaryRoot, "node_modules", ".bin", "vite-css-modules");
    const tsc = path.join(temporaryRoot, "node_modules", ".bin", "tsc");
    const vite = path.join(temporaryRoot, "node_modules", ".bin", "vite");
    const declarationResult = await run(generatedCli, [], { cwd: temporaryRoot });
    if (declarationResult.code !== 0) {
      throw new Error(
        `Generated declaration CLI failed:\n${declarationResult.stdout}${declarationResult.stderr}`,
      );
    }
    const declarations = await findGeneratedDeclarations(temporaryRoot);
    if (declarations.length === 0)
      throw new Error("Generated declaration CLI produced no declarations");

    const typecheckResult = await run(
      tsc,
      ["--project", path.join(temporaryRoot, "tsconfig.json"), "--noEmit"],
      {
        cwd: temporaryRoot,
      },
    );
    if (typecheckResult.code !== 0) {
      throw new Error(
        `Generated project typecheck failed:\n${typecheckResult.stdout}${typecheckResult.stderr}`,
      );
    }
    const buildResult = await run(
      vite,
      ["build", "--config", "vite.config.ts", "--configLoader", "runner", "--logLevel", "warn"],
      { cwd: temporaryRoot },
    );
    if (buildResult.code !== 0) {
      throw new Error(
        `Generated project build failed:\n${buildResult.stdout}${buildResult.stderr}`,
      );
    }

    const sourcePath = path.join(temporaryRoot, "src/main.tsx");
    const source = await readFile(sourcePath, "utf8");
    await writeFile(
      sourcePath,
      `${source}\nexport const invalidClassProbe = localStyles.missingClass;\n`,
    );
    const invalidTypecheck = await run(
      tsc,
      ["--project", path.join(temporaryRoot, "tsconfig.json"), "--noEmit"],
      {
        cwd: temporaryRoot,
      },
    );
    const invalidOutput = `${invalidTypecheck.stdout}${invalidTypecheck.stderr}`;
    if (
      invalidTypecheck.code === 0 ||
      !/Property 'missingClass' does not exist/.test(invalidOutput)
    ) {
      throw new Error(
        `Missing-class probe did not produce the expected declaration diagnostic:\n${invalidOutput}`,
      );
    }
    await writeFile(sourcePath, source);

    let migration;
    if (migrate) {
      const migrationPlan = await planSetup({
        root: temporaryRoot,
        mode: "migrate",
        authorizeMigrate: true,
        targetFormat: "compact",
      });
      if (migrationPlan.status !== "ready" || migrationPlan.migration?.status !== "supported") {
        throw new Error(`Generated migration plan was not ready: ${JSON.stringify(migrationPlan)}`);
      }
      if (migrationPlan.migration.differences.length !== 0) {
        throw new Error(
          `Generated migration changed resolved choices: ${JSON.stringify(migrationPlan.migration.differences)}`,
        );
      }
      const before = migrationPlan.migration.before.profile;
      const after = migrationPlan.migration.after.profile;
      for (const field of [
        "alias",
        "helpers",
        "stylesRoot",
        "globalStylesheet",
        "sharedApi",
        "layers",
      ]) {
        if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
          throw new Error(`Generated migration changed custom resolved field ${field}`);
        }
      }
      await applySetupPlan(migrationPlan);
      migration = {
        status: migrationPlan.migration.status,
        differences: migrationPlan.migration.differences,
        profileFormat: (await readResolvedContract(temporaryRoot)).format,
      };
    }

    const repeat = migrate
      ? await planSetup({ root: temporaryRoot, mode: "align" })
      : await planSetup({
          root: temporaryRoot,
          mode: "bootstrap",
          profileSource,
          inputsPath,
        });
    const auditBefore = await snapshotDirectory(temporaryRoot);
    const audit = await (await import("./audit.mjs")).auditProject({ root: temporaryRoot });
    const auditAfter = await snapshotDirectory(temporaryRoot);
    if (JSON.stringify(auditBefore) !== JSON.stringify(auditAfter))
      throw new Error("Audit modified generated target");
    if (repeat.changes.length !== 0 || repeat.status !== "aligned") {
      throw new Error(`Repeat generated setup was not aligned: ${JSON.stringify(repeat)}`);
    }
    return {
      mode: custom ? "custom" : "default",
      ...(migrate ? { migration } : {}),
      alias,
      applied: applied.touched,
      declarations: declarations.map((file) =>
        path.relative(temporaryRoot, file).split(path.sep).join("/"),
      ),
      typecheck: "passed",
      build: "passed",
      missingClass: "rejected with the expected TypeScript diagnostic",
      repeat: { status: repeat.status, changes: repeat.changes.length },
      audit: {
        status: audit.status,
        readOnly: true,
        unresolved: audit.findings
          .filter(({ status }) => status !== "aligned")
          .map(({ id, status, detail }) => ({ id, status, detail })),
      },
      generatedOutputPreserved: declarations.length > 0,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function runCompactEmptyScenario() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "css-modules-compact-empty-"));
  const profileSource = "compact-profile.json";
  try {
    const profile = {
      $schema: "./css-modules-harness/assets/css-modules.compact.schema.json",
      format: "css-modules-compact",
      version: 1,
      preset: "vite-react@1",
      styles: { root: "src/shared/styles", alias: "#styles" },
      sharedApi: {
        modules: [],
        admissionRule: { strategy: "project-review" },
      },
      composition: "markup",
      colors: false,
      checks: "warn",
    };
    await writeProjectFile(temporaryRoot, profileSource, `${JSON.stringify(profile, null, 2)}\n`);
    await writeProjectFile(
      temporaryRoot,
      "package.json",
      `${JSON.stringify(
        {
          private: true,
          type: "module",
          packageManager: "npm@11.0.0",
          imports: {
            "#styles": "./src/shared/styles/index.ts",
            "#styles/*": "./src/shared/styles/*",
          },
          scripts: {
            "css:generate": "vite-css-modules",
            "css:types": "tsc --noEmit",
            build: "vite build --config vite.config.ts --configLoader runner --logLevel warn",
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeProjectFile(temporaryRoot, "package-lock.json", "{}\n");
    await writeProjectFile(
      temporaryRoot,
      "tsconfig.json",
      `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            lib: ["ES2022", "DOM"],
            module: "ESNext",
            moduleResolution: "Bundler",
            strict: true,
            noEmit: true,
            jsx: "react-jsx",
            paths: {
              "#styles": ["./src/shared/styles/index.ts"],
              "#styles/*": ["./src/shared/styles/*"],
            },
          },
          include: ["src"],
        },
        null,
        2,
      )}\n`,
    );
    await writeProjectFile(temporaryRoot, "vite.config.ts", viteConfig(false));
    await writeProjectFile(
      temporaryRoot,
      "index.html",
      '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n',
    );
    await writeProjectFile(
      temporaryRoot,
      "src/vite-env.d.ts",
      '/// <reference types="vite/client" />\n',
    );
    await writeProjectFile(
      temporaryRoot,
      "src/main.tsx",
      `import "#styles/global.css";
import { cx } from "#styles";

export const generatedClassName = cx("empty-shared-api");
`,
    );
    await symlink(
      path.join(REPOSITORY_ROOT, "node_modules"),
      path.join(temporaryRoot, "node_modules"),
      "dir",
    );

    const plan = await planSetup({ root: temporaryRoot, mode: "bootstrap", profileSource });
    if (plan.status !== "ready" || plan.requiredInputs.length !== 0) {
      throw new Error(`Compact empty plan was not ready: ${JSON.stringify(plan)}`);
    }
    if (plan.changes.some(({ path: filePath }) => filePath.endsWith(".module.css"))) {
      throw new Error("Compact empty bootstrap created a placeholder CSS module");
    }
    await applySetupPlan(plan);
    const generatedCli = path.join(temporaryRoot, "node_modules", ".bin", "vite-css-modules");
    const tsc = path.join(temporaryRoot, "node_modules", ".bin", "tsc");
    const vite = path.join(temporaryRoot, "node_modules", ".bin", "vite");
    const declarationResult = await run(generatedCli, [], { cwd: temporaryRoot });
    if (declarationResult.code !== 0)
      throw new Error(
        `Compact declaration CLI failed: ${declarationResult.stdout}${declarationResult.stderr}`,
      );
    const typecheck = await run(
      tsc,
      ["--project", path.join(temporaryRoot, "tsconfig.json"), "--noEmit"],
      { cwd: temporaryRoot },
    );
    if (typecheck.code !== 0)
      throw new Error(`Compact empty typecheck failed: ${typecheck.stdout}${typecheck.stderr}`);
    const build = await run(
      vite,
      ["build", "--config", "vite.config.ts", "--configLoader", "runner", "--logLevel", "warn"],
      { cwd: temporaryRoot },
    );
    if (build.code !== 0)
      throw new Error(`Compact empty build failed: ${build.stdout}${build.stderr}`);
    const checks = await checkProject({ root: temporaryRoot });
    if (checks.status !== "passed")
      throw new Error(`Compact empty checks failed: ${JSON.stringify(checks)}`);

    // The compact empty profile is intentionally a real starting point. The
    // first shared module is a reviewed, agent-owned admission: update the
    // profile, author its CSS, publish it through the existing barrel, and
    // validate the resulting project with the normal alignment/check path.
    const admittedProfilePath = path.join(temporaryRoot, ".agents", "css-modules.json");
    const admittedProfile = JSON.parse(await readFile(admittedProfilePath, "utf8"));
    admittedProfile.sharedApi = {
      admissionRule: { strategy: "project-review" },
      modules: [
        {
          name: "button",
          export: "button",
          path: "src/shared/styles/button.module.css",
          layer: "atoms",
        },
      ],
    };
    await writeFile(admittedProfilePath, `${JSON.stringify(admittedProfile, null, 2)}\n`);
    await writeProjectFile(
      temporaryRoot,
      "src/shared/styles/button.module.css",
      `@layer atoms {
  .button {
    display: inline-flex;
  }
}
`,
    );
    const sharedEntryPath = path.join(temporaryRoot, "src/shared/styles/index.ts");
    await writeFile(
      sharedEntryPath,
      `${await readFile(sharedEntryPath, "utf8")}export { default as button } from "./button.module.css";\n`,
    );
    const mainPath = path.join(temporaryRoot, "src/main.tsx");
    const mainSource = await readFile(mainPath, "utf8");
    await writeFile(
      mainPath,
      `${mainSource}\nimport { button } from "#styles";\nexport const admittedClassName = button.button;\n`,
    );
    const admissionPlan = await planSetup({ root: temporaryRoot, mode: "align" });
    if (admissionPlan.status !== "aligned" || admissionPlan.changes.length !== 0) {
      throw new Error(
        `First shared-module admission was not aligned: ${JSON.stringify(admissionPlan)}`,
      );
    }

    const admittedDeclarationResult = await run(generatedCli, [], { cwd: temporaryRoot });
    if (admittedDeclarationResult.code !== 0)
      throw new Error(
        `Admitted declaration CLI failed: ${admittedDeclarationResult.stdout}${admittedDeclarationResult.stderr}`,
      );
    const admittedDeclaration = await readFile(
      path.join(temporaryRoot, "src/shared/styles/button.module.css.d.ts"),
      "utf8",
    );
    if (!/button/.test(admittedDeclaration)) {
      throw new Error("Generated declaration did not infer the authored .button class");
    }
    const admittedTypecheck = await run(
      tsc,
      ["--project", path.join(temporaryRoot, "tsconfig.json"), "--noEmit"],
      { cwd: temporaryRoot },
    );
    if (admittedTypecheck.code !== 0)
      throw new Error(
        `Admitted module typecheck failed: ${admittedTypecheck.stdout}${admittedTypecheck.stderr}`,
      );
    const admittedBuild = await run(
      vite,
      ["build", "--config", "vite.config.ts", "--configLoader", "runner", "--logLevel", "warn"],
      { cwd: temporaryRoot },
    );
    if (admittedBuild.code !== 0)
      throw new Error(
        `Admitted module build failed: ${admittedBuild.stdout}${admittedBuild.stderr}`,
      );
    const inferredChecks = await checkProject({ root: temporaryRoot });
    if (inferredChecks.status !== "passed")
      throw new Error(
        `Inferred public classes were not accepted: ${JSON.stringify(inferredChecks)}`,
      );

    // A reviewed publicClasses list is a different, deliberately strict
    // contract. Exercise both sides of that contract with an error severity
    // override so these are actual rejected checker results in the report.
    admittedProfile.sharedApi.modules[0].publicClasses = ["button"];
    await writeFile(admittedProfilePath, `${JSON.stringify(admittedProfile, null, 2)}\n`);
    const frozenReady = await checkProject({ root: temporaryRoot, severity: "error" });
    if (frozenReady.status !== "passed")
      throw new Error(`Frozen public class baseline did not pass: ${JSON.stringify(frozenReady)}`);
    await writeProjectFile(
      temporaryRoot,
      "src/shared/styles/button.module.css",
      `@layer atoms {
  .button {
    display: inline-flex;
  }
  .extra {
    display: inline-flex;
  }
}
`,
    );
    const unlistedClass = await checkProject({ root: temporaryRoot, severity: "error" });
    if (
      unlistedClass.status !== "failed" ||
      !unlistedClass.findings.some(
        ({ ruleId, message }) =>
          ruleId === "css-modules/shared-public-class" && message.includes(".extra"),
      )
    ) {
      throw new Error(
        `Frozen public class addition was not rejected: ${JSON.stringify(unlistedClass)}`,
      );
    }
    await writeProjectFile(
      temporaryRoot,
      "src/shared/styles/button.module.css",
      `@layer atoms {
  .replacement {
    display: inline-flex;
  }
}
`,
    );
    const removedClass = await checkProject({ root: temporaryRoot, severity: "error" });
    if (
      removedClass.status !== "failed" ||
      !removedClass.findings.some(
        ({ ruleId, message }) =>
          ruleId === "css-modules/shared-public-class" &&
          message.includes(".button") &&
          message.includes("absent"),
      )
    ) {
      throw new Error(
        `Frozen public class removal was not rejected: ${JSON.stringify(removedClass)}`,
      );
    }
    await writeProjectFile(
      temporaryRoot,
      "src/shared/styles/button.module.css",
      `@layer atoms {
  .button {
    display: inline-flex;
  }
}
`,
    );
    const restoredChecks = await checkProject({ root: temporaryRoot, severity: "error" });
    if (restoredChecks.status !== "passed")
      throw new Error(
        `Restored frozen public class contract failed: ${JSON.stringify(restoredChecks)}`,
      );
    const beforeAudit = await snapshotDirectory(temporaryRoot);
    const audit = await (await import("./audit.mjs")).auditProject({ root: temporaryRoot });
    const afterAudit = await snapshotDirectory(temporaryRoot);
    if (JSON.stringify(beforeAudit) !== JSON.stringify(afterAudit))
      throw new Error("Compact audit modified generated target");
    const repeat = await planSetup({ root: temporaryRoot, mode: "align" });
    if (repeat.changes.length !== 0 || repeat.status !== "aligned")
      throw new Error(`Compact empty repeat was not aligned: ${JSON.stringify(repeat)}`);
    return {
      mode: "compact-empty",
      sharedModules: 0,
      placeholderCss: false,
      commands: {
        "css:generate": "npm run css:generate",
        "css:types": "npm run css:types",
      },
      admission: {
        policy: "project-review",
        agentOwnedEdits: [
          ".agents/css-modules.json",
          "src/shared/styles/button.module.css",
          "src/shared/styles/index.ts",
          "src/main.tsx",
        ],
        alignment: { status: admissionPlan.status, changes: admissionPlan.changes.length },
        inferredPublicClasses: ["button"],
        frozenPublicClasses: ["button"],
        unlistedClass: "rejected by css-modules/shared-public-class",
        removedClass: "rejected by css-modules/shared-public-class",
      },
      postAdmission: {
        declarations: "passed",
        typecheck: "passed",
        build: "passed",
        sourceChecks: "passed",
      },
      declarations: "passed",
      typecheck: "passed",
      build: "passed",
      sourceChecks: "passed",
      repeat: { status: repeat.status, changes: repeat.changes.length },
      audit: { status: audit.status, readOnly: true },
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function verifyGeneratedProject() {
  return {
    scenarios: [
      await runGeneratedScenario(false),
      await runGeneratedScenario(true),
      await runGeneratedScenario(true, { migrate: true }),
      await runCompactEmptyScenario(),
    ],
  };
}

async function snapshotDirectory(directory) {
  const output = [];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else output.push([path.relative(directory, target), await readFile(target, "utf8")]);
    }
  }
  await visit(directory);
  return output;
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function findGeneratedDeclarations(directory, output = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "dist") {
        await findGeneratedDeclarations(entryPath, output);
      }
    } else if (entry.name.endsWith(".module.css.d.ts")) {
      output.push(entryPath);
    }
  }
  return output;
}

export async function verifyReferenceFixture() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "css-modules-reference-"));
  const fixture = path.join(temporaryRoot, "fixture");

  try {
    await cp(FIXTURE_ROOT, fixture, { recursive: true });
    await symlink(
      path.join(REPOSITORY_ROOT, "node_modules"),
      path.join(fixture, "node_modules"),
      "dir",
    );

    const vite = path.join(REPOSITORY_ROOT, "node_modules", ".bin", "vite");
    const buildResult = await run(
      vite,
      ["build", "--config", "vite.config.ts", "--configLoader", "runner", "--logLevel", "warn"],
      { cwd: fixture },
    );
    if (buildResult.code !== 0) {
      throw new Error(
        `Reference fixture build failed:\n${buildResult.stdout}${buildResult.stderr}`,
      );
    }
    const declarations = await findGeneratedDeclarations(fixture);
    const relativeDeclarations = declarations
      .map((filePath) => path.relative(fixture, filePath).split(path.sep).join("/"))
      .sort();
    if (relativeDeclarations.length < 3) {
      throw new Error(
        `Expected generated declarations for the fixture modules; found ${relativeDeclarations.length}`,
      );
    }
    for (const declaration of declarations) {
      if (!(await readFile(declaration, "utf8")).includes("sourceMappingURL=")) {
        throw new Error(
          `Generated declaration is missing its declaration map: ${path.relative(fixture, declaration)}`,
        );
      }
    }

    const tsc = path.join(REPOSITORY_ROOT, "node_modules", ".bin", "tsc");
    const typecheck = await run(tsc, [
      "--project",
      path.join(fixture, "tsconfig.json"),
      "--noEmit",
    ]);
    if (typecheck.code !== 0) {
      throw new Error(
        `Reference fixture typecheck failed:\n${typecheck.stdout}${typecheck.stderr}`,
      );
    }

    const sourceChecks = await checkProject({ root: fixture });
    if (sourceChecks.status !== "passed") {
      throw new Error(
        `Reference fixture source checks failed:\n${JSON.stringify(sourceChecks.findings, null, 2)}`,
      );
    }

    const componentPath = path.join(fixture, "src", "reference-button.tsx");
    const component = await readFile(componentPath, "utf8");
    await writeFile(
      componentPath,
      `${component}\nexport const invalidClassProbe = styles.missingClass;\n`,
    );
    const invalidTypecheck = await run(tsc, [
      "--project",
      path.join(fixture, "tsconfig.json"),
      "--noEmit",
    ]);
    if (invalidTypecheck.code === 0) {
      throw new Error("Generated declarations did not reject an invalid CSS Module class key");
    }

    return {
      declarations: "passed",
      declarationMaps: "passed",
      typecheck: "passed",
      build: "passed",
      sourceChecks: "passed",
      invalidClassKey: "rejected",
      generatedDeclarations: relativeDeclarations,
      generatedProject: await verifyGeneratedProject(),
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function main() {
  try {
    const result = await verifyReferenceFixture();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Reference fixture failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
