import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkProject } from "../scripts/check.mjs";
import { applySetupPlan, formatPlan, planSetup } from "../scripts/setup.mjs";
import { formatResolvedContract } from "../scripts/contract.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

async function write(root, relativePath, contents) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
}

async function snapshot(root, relativePath = ".") {
  const directory = path.join(root, relativePath);
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === "node_modules") {
      continue;
    }
    const nextRelative = path.join(relativePath, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await snapshot(root, nextRelative)));
    } else {
      result.push([nextRelative, await readFile(path.join(root, nextRelative), "utf8")]);
    }
  }

  return result;
}

function profile() {
  return {
    methodologyVersion: "1.0.0",
    profileSchemaVersion: 1,
    adapter: { name: "vite-react", version: "1.0.0" },
    appRoot: ".",
    stylesRoot: "src/foundation",
    globalStylesheet: "src/foundation/global.css",
    alias: { bare: "#foundation", subpath: "#foundation/*" },
    helpers: { classNames: "mergeClasses", cssVariables: "styleVariables" },
    sharedApi: {
      entryPoint: "src/foundation/index.ts",
      modules: [
        {
          name: "flow",
          export: "flow",
          path: "src/foundation/flow.module.css",
          layer: "primitives",
        },
      ],
      admissionRule: { strategy: "project-review" },
    },
    layers: {
      order: ["ground", "primitives", "widgets"],
      ownership: [
        { glob: "src/foundation/*.module.css", layer: "primitives" },
        { glob: "src/widgets/**/*.module.css", layer: "widgets" },
      ],
      localModules: { strategy: "unlayered" },
    },
    composition: { mode: "markup" },
    colorTokens: { enabled: false },
    commands: {
      "css:generate": "npm run css:generate",
      "css:types": "npm run css:types",
      "css:verify": "npm run css:verify",
    },
    runtimeVerification: {
      entry: "reference fixture",
      themes: [],
      viewports: ["360px", "1280px"],
      preferences: ["reduced-motion", "forced-colors"],
      directions: ["ltr"],
    },
    exceptions: [],
  };
}

async function createGreenfieldFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "css-modules-setup-"));
  const selectedProfile = profile();

  await write(
    root,
    "package.json",
    JSON.stringify(
      {
        packageManager: "npm@11.0.0",
        scripts: { prepare: "node existing-prepare.mjs" },
        imports: {
          "#foundation": "./src/foundation/index.ts",
          "#foundation/*": "./src/foundation/*",
        },
      },
      null,
      2,
    ),
  );
  await write(root, "package-lock.json", "{}\n");
  await write(
    root,
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        paths: {
          "#foundation": ["./src/foundation/index.ts"],
          "#foundation/*": ["./src/foundation/*"],
        },
      },
    }),
  );
  await write(
    root,
    "vite.config.ts",
    `import react from "@vitejs/plugin-react";
import { patchCssModules } from "vite-css-modules";
export default {
  css: { modules: { localsConvention: "camelCaseOnly" } },
  plugins: [react(), patchCssModules({ generateSourceTypes: true })],
};
`,
  );
  await write(root, "src/main.tsx", 'import "#foundation/global.css";\n');
  await write(
    root,
    ".github/workflows/css.yml",
    "steps:\n  - run: npm run css:generate\n  - run: npm run css:types\n",
  );
  await write(root, "selected-profile.json", `${JSON.stringify(selectedProfile, null, 2)}\n`);
  await write(
    root,
    "setup-inputs.json",
    `${JSON.stringify(
      {
        sharedModules: {
          flow: {
            className: "cluster",
            declarations: "display: flex;\n    flex-wrap: wrap;",
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  return root;
}

async function runSetupCli(root, args) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(REPOSITORY_ROOT, "skills/frontend/css-modules-setup/scripts/setup.mjs"), ...args],
      { cwd: root },
    );
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

test("audit and verify plans leave the target byte-for-byte unchanged", async () => {
  const root = await createGreenfieldFixture();

  try {
    await write(
      root,
      ".agents/css-modules.json",
      await readFile(path.join(root, "selected-profile.json"), "utf8"),
    );
    const before = await snapshot(root);
    const auditPlan = await planSetup({ root, mode: "audit" });
    const verifyPlan = await planSetup({ root, mode: "verify" });
    const after = await snapshot(root);

    assert.deepEqual(after, before);
    assert.deepEqual(auditPlan.changes, []);
    assert.deepEqual(verifyPlan.changes, []);
    assert.equal(verifyPlan.verification.status, "planned");
    assert.equal(verifyPlan.verification.executed, false);
    assert.match(formatPlan(verifyPlan), /Verification: planned \(not executed\)/);
    assert.match(formatPlan(verifyPlan), /Commands \(planned, not executed\):/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bootstrap plans complete profile-driven files, applies once, and is idempotent", async () => {
  const root = await createGreenfieldFixture();

  try {
    const plan = await planSetup({
      root,
      mode: "bootstrap",
      profileSource: "selected-profile.json",
      inputsPath: "setup-inputs.json",
    });

    assert.equal(plan.status, "ready");
    assert.ok(plan.changes.length > 0);
    assert.ok(plan.changes.every(({ action }) => action === "create"));
    assert.ok(plan.changes.every(({ content }) => !content.includes("{{")));
    const human = formatPlan(plan);
    assert.match(human, /Compatibility:/);
    assert.match(human, /Dependencies:/);
    assert.match(human, /vite-css-modules/);
    assert.match(human, /Commands \(planned, not executed\):/);
    assert.match(human, /css:generate/);

    const result = await applySetupPlan(plan);
    assert.deepEqual(
      result.touched,
      plan.changes.map(({ path: filePath }) => filePath),
    );

    const secondPlan = await planSetup({
      root,
      mode: "bootstrap",
      profileSource: "selected-profile.json",
      inputsPath: "setup-inputs.json",
    });
    assert.equal(secondPlan.status, "aligned");
    assert.deepEqual(secondPlan.changes, []);

    const moduleCss = await readFile(path.join(root, "src/foundation/flow.module.css"), "utf8");
    const entryPoint = await readFile(path.join(root, "src/foundation/index.ts"), "utf8");
    assert.match(moduleCss, /@layer primitives/);
    assert.match(moduleCss, /\.cluster/);
    assert.match(entryPoint, /mergeClasses/);
    assert.match(entryPoint, /styleVariables/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("relocated shared entry points receive relative helper imports and preserve helper names", async () => {
  const root = await createGreenfieldFixture();

  try {
    const selected = JSON.parse(await readFile(path.join(root, "selected-profile.json"), "utf8"));
    selected.sharedApi.entryPoint = "src/api/styles.ts";
    await write(root, "relocated-profile.json", `${JSON.stringify(selected, null, 2)}\n`);
    const plan = await planSetup({
      root,
      mode: "bootstrap",
      profileSource: "relocated-profile.json",
      inputsPath: "setup-inputs.json",
    });

    const entry = plan.changes.find(({ path: filePath }) => filePath === "src/api/styles.ts");
    assert.ok(entry);
    assert.match(entry.content, /from "\.\.\/foundation\/lib\/cx"/);
    assert.match(entry.content, /from "\.\.\/foundation\/lib\/css-vars"/);
    assert.match(entry.content, /export \{ mergeClasses/);
    assert.match(entry.content, /export \{ styleVariables/);
    await applySetupPlan(plan);
    assert.equal(await readFile(path.join(root, "src/api/styles.ts"), "utf8"), entry.content);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bootstrap preserves existing package scripts, plugins, and production components", async () => {
  const root = await createGreenfieldFixture();

  try {
    await write(
      root,
      "src/widgets/button.tsx",
      "export function Button() { return <button />; }\n",
    );
    const packageBefore = await readFile(path.join(root, "package.json"), "utf8");
    const viteBefore = await readFile(path.join(root, "vite.config.ts"), "utf8");
    const componentBefore = await readFile(path.join(root, "src/widgets/button.tsx"), "utf8");

    const plan = await planSetup({
      root,
      mode: "bootstrap",
      profileSource: "selected-profile.json",
      inputsPath: "setup-inputs.json",
    });
    await applySetupPlan(plan);

    assert.equal(await readFile(path.join(root, "package.json"), "utf8"), packageBefore);
    assert.equal(await readFile(path.join(root, "vite.config.ts"), "utf8"), viteBefore);
    assert.equal(
      await readFile(path.join(root, "src/widgets/button.tsx"), "utf8"),
      componentBefore,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bootstrap stops on a different existing file instead of overwriting it", async () => {
  const root = await createGreenfieldFixture();

  try {
    await write(root, "src/foundation/flow.module.css", ".project-owned { display: grid; }\n");
    const before = await snapshot(root);
    const plan = await planSetup({
      root,
      mode: "bootstrap",
      profileSource: "selected-profile.json",
      inputsPath: "setup-inputs.json",
    });

    assert.equal(plan.status, "conflict");
    assert.deepEqual(
      plan.conflicts.map(({ path: filePath }) => filePath),
      ["src/foundation/flow.module.css"],
    );
    await assert.rejects(() => applySetupPlan(plan), /conflicts/);
    assert.deepEqual(await snapshot(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preflights normalized output collisions and identifies both producing sources", async () => {
  const root = await createGreenfieldFixture();

  try {
    const selected = JSON.parse(await readFile(path.join(root, "selected-profile.json"), "utf8"));
    selected.sharedApi.modules[0].path = selected.globalStylesheet;
    await write(root, "collision-profile.json", `${JSON.stringify(selected, null, 2)}\n`);
    const plan = await planSetup({
      root,
      mode: "bootstrap",
      profileSource: "collision-profile.json",
      inputsPath: "setup-inputs.json",
    });

    assert.equal(plan.status, "conflict");
    const collision = plan.conflicts.find(({ reason }) => /multiple sources/.test(reason));
    assert.ok(collision);
    assert.equal(collision.sources.length, 2);
    assert.deepEqual(plan.changes, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects escaping symlink parents and allows symlinks contained by the target root", async () => {
  const escapingRoot = await createGreenfieldFixture();
  const containedRoot = await createGreenfieldFixture();
  let outside;

  try {
    outside = await mkdtemp(path.join(os.tmpdir(), "css-modules-outside-"));
    await rm(path.join(escapingRoot, "src"), { recursive: true, force: true });
    await symlink(outside, path.join(escapingRoot, "src"), "dir");
    const escaped = await planSetup({
      root: escapingRoot,
      mode: "bootstrap",
      profileSource: "selected-profile.json",
      inputsPath: "setup-inputs.json",
    });
    assert.equal(escaped.status, "conflict");
    assert.ok(
      escaped.conflicts.some(({ reason }) => /escapes the canonical target root/.test(reason)),
    );
    assert.deepEqual(escaped.changes, []);

    await mkdir(path.join(containedRoot, "contained", "foundation"), { recursive: true });
    await mkdir(path.join(containedRoot, "src"), { recursive: true });
    await symlink(
      path.join(containedRoot, "contained", "foundation"),
      path.join(containedRoot, "src", "foundation"),
      "dir",
    );
    const contained = await planSetup({
      root: containedRoot,
      mode: "bootstrap",
      profileSource: "selected-profile.json",
      inputsPath: "setup-inputs.json",
    });
    assert.equal(contained.status, "ready");
    await applySetupPlan(contained);
    assert.match(
      await readFile(path.join(containedRoot, "contained/foundation/global.css"), "utf8"),
      /@layer ground/,
    );
  } finally {
    await rm(escapingRoot, { recursive: true, force: true });
    await rm(containedRoot, { recursive: true, force: true });
    if (outside) await rm(outside, { recursive: true, force: true });
  }
});

test("greenfield setup requires declarations instead of creating empty placeholder classes", async () => {
  const root = await createGreenfieldFixture();

  try {
    await write(root, "setup-inputs.json", "{}\n");
    const plan = await planSetup({
      root,
      mode: "bootstrap",
      profileSource: "selected-profile.json",
      inputsPath: "setup-inputs.json",
    });

    assert.equal(plan.status, "needs-input");
    assert.deepEqual(plan.requiredInputs, ["sharedModules.flow"]);
    assert.deepEqual(plan.changes, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported installed profiles block align without writing", async () => {
  const root = await createGreenfieldFixture();

  try {
    const selected = JSON.parse(await readFile(path.join(root, "selected-profile.json"), "utf8"));
    selected.methodologyVersion = "99.0.0";
    await write(root, ".agents/css-modules.json", JSON.stringify(selected, null, 2) + "\n");
    const before = await snapshot(root);

    const plan = await planSetup({ root, mode: "align" });

    assert.equal(plan.status, "blocked");
    assert.equal(plan.mutationStatus, "blocked");
    assert.deepEqual(plan.changes, []);
    assert.ok(
      plan.compatibility.blockingFindings.some(
        ({ id, actual }) => id === "profile.methodology-version" && actual === 99,
      ),
    );
    await assert.rejects(() => applySetupPlan(plan), /blocking compatibility/);
    assert.deepEqual(await snapshot(root), before);

    selected.methodologyVersion = "1.0.0";
    selected.adapter.version = "99.0.0";
    await write(root, ".agents/css-modules.json", JSON.stringify(selected, null, 2) + "\n");
    const adapterPlan = await planSetup({ root, mode: "align" });
    assert.equal(adapterPlan.status, "blocked");
    assert.ok(
      adapterPlan.compatibility.blockingFindings.some(
        ({ id, actual }) => id === "profile.adapter-version" && actual === 99,
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI exposes actionable compatibility and invalid-input exit codes", async () => {
  const root = await createGreenfieldFixture();

  try {
    const selected = JSON.parse(await readFile(path.join(root, "selected-profile.json"), "utf8"));
    selected.methodologyVersion = "99.0.0";
    await write(root, ".agents/css-modules.json", JSON.stringify(selected, null, 2) + "\n");
    const unsupported = await runSetupCli(root, ["align", "--format", "json", "--check"]);
    assert.equal(unsupported.code, 1, unsupported.stderr);
    assert.match(
      JSON.parse(unsupported.stdout).compatibility.blockingFindings[0].id,
      /methodology/,
    );

    await write(root, ".agents/css-modules.json", "{}\n");
    const invalid = await runSetupCli(root, ["align", "--format", "json", "--check"]);
    assert.equal(invalid.code, 2, invalid.stderr);
    assert.equal(JSON.parse(invalid.stdout).compatibility.status, "ambiguous");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported selected bootstrap profiles block before collecting template inputs", async () => {
  const root = await createGreenfieldFixture();

  try {
    const selected = JSON.parse(await readFile(path.join(root, "selected-profile.json"), "utf8"));
    selected.methodologyVersion = "99.0.0";
    await write(root, "candidate.json", JSON.stringify(selected, null, 2) + "\n");
    await write(root, "setup-inputs.json", "{}\n");

    const plan = await planSetup({
      root,
      mode: "bootstrap",
      profileSource: "candidate.json",
      inputsPath: "setup-inputs.json",
    });

    assert.equal(plan.status, "blocked");
    assert.deepEqual(plan.changes, []);
    assert.ok(
      plan.compatibility.blockingFindings.some(
        ({ id, actual }) => id === "selected-profile.methodology-version" && actual === 99,
      ),
    );

    selected.methodologyVersion = "1.0.0";
    selected.adapter.version = "99.0.0";
    await write(root, "candidate.json", JSON.stringify(selected, null, 2) + "\n");
    const adapterPlan = await planSetup({
      root,
      mode: "bootstrap",
      profileSource: "candidate.json",
      inputsPath: "setup-inputs.json",
    });
    assert.equal(adapterPlan.status, "blocked");
    assert.ok(
      adapterPlan.compatibility.blockingFindings.some(
        ({ id, actual }) => id === "selected-profile.adapter-version" && actual === 99,
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a zero-change plan reports missing infrastructure separately from mutation alignment", async () => {
  const root = await createGreenfieldFixture();

  try {
    const selected = await readFile(path.join(root, "selected-profile.json"), "utf8");
    await write(root, ".agents/css-modules.json", selected);
    await write(
      root,
      ".agents/css-modules.schema.json",
      await readFile(
        path.join(
          REPOSITORY_ROOT,
          "skills/frontend/css-modules-setup/assets/css-modules.schema.json",
        ),
        "utf8",
      ),
    );
    await rm(path.join(root, "vite.config.ts"));
    await rm(path.join(root, "src"), { recursive: true });

    const plan = await planSetup({ root, mode: "align" });
    const human = formatPlan(plan);

    assert.equal(plan.status, "aligned");
    assert.equal(plan.mutationStatus, "aligned");
    assert.equal(plan.compatibility.status, "missing");
    assert.equal(plan.compatibility.blockingFindings.length, 0);
    assert.match(human, /Compatibility: missing/);
    assert.doesNotMatch(human, /verified alignment/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("align mode records an existing design without inventing baseline files", async () => {
  const root = await createGreenfieldFixture();

  try {
    await mkdir(path.join(root, ".agents"), { recursive: true });
    await write(
      root,
      ".agents/css-modules.json",
      await readFile(path.join(root, "selected-profile.json"), "utf8"),
    );
    const plan = await planSetup({ root, mode: "align" });

    assert.notEqual(plan.status, "conflict");
    assert.equal(plan.compatibility.blockingFindings.length, 0);
    assert.ok(plan.changes.length > 0);
    assert.ok(!plan.changes.some(({ path: filePath }) => filePath.includes("palette")));
    assert.ok(!plan.changes.some(({ path: filePath }) => filePath.includes("colors")));
    assert.ok(!plan.changes.some(({ path: filePath }) => filePath.endsWith(".module.css")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("alignment bundles the selected mechanical checker without overwriting project lint config", async () => {
  const root = await createGreenfieldFixture();

  try {
    const profilePath = path.join(root, "selected-profile.json");
    const selected = JSON.parse(await readFile(profilePath, "utf8"));
    selected.enforcement = {
      severity: "warning",
      privateBooleanAttributes: ["data-loading"],
    };
    selected.sharedApi.modules[0].publicClasses = ["cluster"];
    await write(root, ".agents/css-modules.json", `${JSON.stringify(selected, null, 2)}\n`);
    await write(root, "eslint.config.mjs", "export default [];\n");
    await write(root, "stylelint.config.mjs", "export default {};\n");

    const plan = await planSetup({ root, mode: "align" });

    assert.ok(plan.changes.some(({ path: filePath }) => filePath.endsWith("scripts/check.mjs")));
    assert.ok(
      plan.changes.some(({ path: filePath }) => filePath.endsWith("harness/eslint-plugin.mjs")),
    );
    assert.ok(
      plan.changes.some(({ path: filePath }) => filePath.endsWith("scripts/layer-analysis.mjs")),
    );
    assert.ok(
      plan.changes.some(({ path: filePath }) => filePath.endsWith("scripts/color-analysis.mjs")),
    );
    assert.ok(plan.dependencies.includes("eslint"));
    assert.ok(!plan.dependencies.includes("oxlint"));
    assert.ok(plan.dependencies.includes("stylelint"));
    await applySetupPlan(plan);
    assert.equal(
      await readFile(path.join(root, "eslint.config.mjs"), "utf8"),
      "export default [];\n",
    );
    assert.equal(
      await readFile(path.join(root, "stylelint.config.mjs"), "utf8"),
      "export default {};\n",
    );
    const copiedAudit = await realpath(
      path.join(root, ".agents/css-modules-harness/scripts/audit.mjs"),
    );
    const auditRun = await new Promise((resolve) => {
      const child = spawn(process.execPath, [copiedAudit, "--root", root, "--format", "json"]);
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.on("close", (code) => resolve({ code, output }));
    });
    assert.equal(auditRun.code, 0, auditRun.output);
    assert.match(auditRun.output, /"findings"/);

    assert.ok(
      await readFile(
        path.join(root, ".agents/css-modules-harness/scripts/color-analysis.mjs"),
        "utf8",
      ),
    );
    await write(root, "src/foundation/global.css", "@layer ground, primitives, widgets;\n");
    await write(root, "src/foundation/flow.module.css", "@layer primitives { .cluster {} }\n");
    await write(
      root,
      "src/foundation/index.ts",
      'export { default as flow } from "./flow.module.css";\n',
    );
    await symlink(path.join(REPOSITORY_ROOT, "node_modules"), path.join(root, "node_modules"));
    const copiedCheck = await realpath(
      path.join(root, ".agents/css-modules-harness/scripts/check.mjs"),
    );
    const checkRun = await new Promise((resolve) => {
      const child = spawn(process.execPath, [copiedCheck, "--root", root, "--format", "json"]);
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.on("close", (code) => resolve({ code, output }));
    });
    assert.equal(checkRun.code, 0, checkRun.output);
    assert.match(checkRun.output, /"status": "passed"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migrate mode requires explicit authorization", async () => {
  const root = await createGreenfieldFixture();

  try {
    await assert.rejects(
      () => planSetup({ root, mode: "migrate", profileSource: "selected-profile.json" }),
      /explicit migration authorization/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("authorized migration replaces only the selected profile and preserves project choices", async () => {
  const root = await createGreenfieldFixture();

  try {
    const current = profile();
    current.methodologyVersion = "0.9.0";
    await write(root, ".agents/css-modules.json", `${JSON.stringify(current, null, 2)}\n`);

    const plan = await planSetup({
      root,
      mode: "migrate",
      profileSource: "selected-profile.json",
      authorizeMigrate: true,
    });
    assert.equal(plan.status, "ready");
    assert.equal(plan.compatibility.migration, "supported");
    const human = formatPlan(plan);
    assert.match(human, /BEFORE \.agents\/css-modules\.json/);
    assert.match(human, /AFTER  \.agents\/css-modules\.json/);
    assert.deepEqual(
      plan.changes
        .filter(({ action }) => action === "replace")
        .map(({ path: filePath }) => filePath),
      [".agents/css-modules.json"],
    );

    await applySetupPlan(plan);
    const migrated = JSON.parse(
      await readFile(path.join(root, ".agents/css-modules.json"), "utf8"),
    );
    assert.equal(migrated.methodologyVersion, "1.0.0");
    assert.equal(migrated.alias.bare, "#foundation");
    assert.deepEqual(migrated.layers.order, ["ground", "primitives", "widgets"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported migrations are reported and cannot be applied", async () => {
  const root = await createGreenfieldFixture();

  try {
    const current = profile();
    current.methodologyVersion = "2.0.0";
    await write(root, ".agents/css-modules.json", JSON.stringify(current, null, 2) + "\n");
    const before = await snapshot(root);
    const plan = await planSetup({
      root,
      mode: "migrate",
      profileSource: "selected-profile.json",
      authorizeMigrate: true,
    });

    assert.equal(plan.status, "blocked");
    assert.equal(plan.compatibility.migration, "unsupported");
    assert.match(formatPlan(plan), /Migration: unsupported/);
    await assert.rejects(() => applySetupPlan(plan), /blocking compatibility/);
    assert.deepEqual(await snapshot(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a partial apply failure reports completed files and leaves unrelated files intact", async () => {
  const root = await createGreenfieldFixture();

  try {
    const plan = await planSetup({
      root,
      mode: "bootstrap",
      profileSource: "selected-profile.json",
      inputsPath: "setup-inputs.json",
    });
    const [first, second] = plan.changes;
    await write(root, second.path, "created after planning\n");

    await assert.rejects(async () => {
      try {
        await applySetupPlan(plan);
      } catch (error) {
        assert.deepEqual(error.touched, []);
        throw error;
      }
    }, /Refusing to overwrite/);
    assert.equal(await readFile(path.join(root, second.path), "utf8"), "created after planning\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the color contract renders through its templates and never invents a palette", async () => {
  const root = await createGreenfieldFixture();
  const colorProfile = JSON.parse(await readFile(path.join(root, "selected-profile.json"), "utf8"));
  colorProfile.colorTokens = {
    enabled: true,
    paletteFiles: ["src/foundation/palette.css"],
    semanticFiles: ["src/foundation/colors.css"],
    themeOwner: "src/foundation/theme.ts",
    themeAttribute: "data-theme",
    modes: ["system", "light", "dark"],
  };
  await write(root, "selected-profile.json", `${JSON.stringify(colorProfile, null, 2)}\n`);

  try {
    const inputs = JSON.parse(await readFile(path.join(root, "setup-inputs.json"), "utf8"));
    const withoutColors = await planSetup({
      root,
      mode: "bootstrap",
      profileSource: "selected-profile.json",
      inputsPath: "setup-inputs.json",
    });

    assert.equal(withoutColors.status, "needs-input");
    assert.deepEqual(withoutColors.requiredInputs, [
      "colorLayer",
      "paletteFiles.src/foundation/palette.css",
      "semanticFiles.src/foundation/colors.css",
    ]);
    assert.deepEqual(withoutColors.changes, []);

    await write(
      root,
      "color-inputs.json",
      `${JSON.stringify(
        {
          ...inputs,
          colorLayer: "ground",
          paletteFiles: { "src/foundation/palette.css": "--palette-ink: rgb(20 20 20);" },
          semanticFiles: {
            "src/foundation/colors.css": "--color-text: light-dark(var(--palette-ink), Canvas);",
          },
        },
        null,
        2,
      )}\n`,
    );
    const plan = await planSetup({
      root,
      mode: "bootstrap",
      profileSource: "selected-profile.json",
      inputsPath: "color-inputs.json",
    });

    assert.equal(plan.status, "ready");
    assert.ok(plan.changes.every(({ content }) => !content.includes("{{")));

    const palette = plan.changes.find(({ path: file }) => file.endsWith("palette.css"));
    const colors = plan.changes.find(({ path: file }) => file.endsWith("colors.css"));
    const global = plan.changes.find(({ path: file }) => file.endsWith("global.css"));

    assert.match(palette.content, /Do not invent brand colors/);
    assert.match(palette.content, /--palette-ink: rgb\(20 20 20\);/);
    assert.match(colors.content, /Map project palette values to semantic roles/);
    assert.match(colors.content, /--color-text: light-dark/);
    assert.match(global.content, /@import ".\/palette\.css" layer\(ground\);/);
    assert.match(global.content, /html\[data-theme="dark"\]/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("template input and theme validation happens before writes", async () => {
  const root = await createGreenfieldFixture();
  try {
    const selected = JSON.parse(await readFile(path.join(root, "selected-profile.json"), "utf8"));
    selected.colorTokens = {
      enabled: true,
      paletteFiles: ["src/foundation/palette.css"],
      semanticFiles: ["src/foundation/colors.css"],
      themeOwner: "src/foundation/theme.ts",
      themeAttribute: "data-theme",
      modes: ["light"],
    };
    await write(root, "light-only-profile.json", `${JSON.stringify(selected, null, 2)}\n`);
    await write(
      root,
      "light-only-inputs.json",
      JSON.stringify(
        {
          sharedModules: { flow: { className: "cluster", declarations: "color: red;" } },
          colorLayer: "ground",
          paletteFiles: { "src/foundation/palette.css": "--palette-ink: black;" },
          semanticFiles: { "src/foundation/colors.css": "--color-text: var(--palette-ink);" },
        },
        null,
        2,
      ) + "\n",
    );
    const lightOnly = await planSetup({
      root,
      mode: "bootstrap",
      profileSource: "light-only-profile.json",
      inputsPath: "light-only-inputs.json",
    });
    assert.equal(lightOnly.status, "ready");
    assert.match(
      lightOnly.changes.find(({ path: filePath }) => filePath.endsWith("global.css")).content,
      /color-scheme: light;/,
    );
    assert.equal(
      lightOnly.changes.some(({ path: filePath }) => /palette|colors/.test(filePath)),
      true,
    );

    await write(
      root,
      "invalid-inputs.json",
      JSON.stringify({
        sharedModules: { flow: { className: "not valid", declarations: "color: ;" } },
      }) + "\n",
    );
    const invalid = await planSetup({
      root,
      mode: "bootstrap",
      profileSource: "selected-profile.json",
      inputsPath: "invalid-inputs.json",
    });
    assert.equal(invalid.status, "blocked");
    assert.deepEqual(invalid.changes, []);
    assert.ok(invalid.templateErrors.some((error) => /className/.test(error)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported custom color modes require an explicit supported mapping", async () => {
  const root = await createGreenfieldFixture();
  try {
    const selected = JSON.parse(await readFile(path.join(root, "selected-profile.json"), "utf8"));
    selected.colorTokens = {
      enabled: true,
      paletteFiles: ["src/foundation/palette.css"],
      semanticFiles: ["src/foundation/colors.css"],
      themeOwner: "src/foundation/theme.ts",
      themeAttribute: "data-theme",
      modes: ["sepia"],
    };
    await write(root, "custom-mode-profile.json", `${JSON.stringify(selected, null, 2)}\n`);
    await write(
      root,
      "custom-mode-inputs.json",
      JSON.stringify({
        ...JSON.parse(await readFile(path.join(root, "setup-inputs.json"), "utf8")),
        colorLayer: "ground",
        paletteFiles: { "src/foundation/palette.css": "--palette-ink: black;" },
        semanticFiles: { "src/foundation/colors.css": "--color-text: black;" },
      }) + "\n",
    );
    const unsupported = await planSetup({
      root,
      mode: "bootstrap",
      profileSource: "custom-mode-profile.json",
      inputsPath: "custom-mode-inputs.json",
    });
    assert.equal(unsupported.status, "blocked");
    assert.match(
      unsupported.compatibility.findings.find(({ id }) => id === "selected-profile.schema")
        ?.detail ?? "",
      /modeMapping/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("focused helper-template compile uses a permissive CSS stub; generated declarations are verified separately", async () => {
  const root = await createGreenfieldFixture();

  try {
    const plan = await planSetup({
      root,
      mode: "bootstrap",
      profileSource: "selected-profile.json",
      inputsPath: "setup-inputs.json",
    });
    await applySetupPlan(plan);

    // The rendered helpers ship into real projects, so they must typecheck with
    // no dependency the setup plan did not print.
    await symlink(
      path.join(REPOSITORY_ROOT, "node_modules"),
      path.join(root, "node_modules"),
      "dir",
    );
    await write(
      root,
      "src/foundation/css-modules.d.ts",
      'declare module "*.module.css" {\n  const classes: Record<string, string>;\n  export default classes;\n}\n',
    );
    await write(
      root,
      "tsconfig.templates.json",
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
          },
          include: ["src/foundation"],
        },
        null,
        2,
      )}\n`,
    );

    const typecheck = await new Promise((resolve) => {
      const child = spawn(
        path.join(REPOSITORY_ROOT, "node_modules", ".bin", "tsc"),
        ["--project", path.join(root, "tsconfig.templates.json")],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.on("close", (code) => resolve({ code, output }));
    });

    assert.equal(typecheck.code, 0, typecheck.output);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compact bootstrap admits zero shared modules without placeholder CSS", async () => {
  const root = await createGreenfieldFixture();

  try {
    await write(
      root,
      "compact-profile.json",
      `${JSON.stringify(
        {
          $schema: "./css-modules.compact.schema.json",
          format: "css-modules-compact",
          version: 1,
          preset: "vite-react@1",
          styles: { root: "src/foundation", alias: "#foundation" },
          composition: "markup",
          colors: false,
          checks: "warn",
        },
        null,
        2,
      )}\n`,
    );
    const plan = await planSetup({
      root,
      mode: "bootstrap",
      profileSource: "compact-profile.json",
    });

    assert.equal(plan.status, "ready");
    assert.deepEqual(plan.requiredInputs, []);
    assert.ok(plan.changes.some(({ path: filePath }) => filePath.endsWith("index.ts")));
    assert.ok(
      plan.changes.some(({ path: filePath }) =>
        filePath.endsWith("css-modules.compact.schema.json"),
      ),
    );
    assert.ok(!plan.changes.some(({ path: filePath }) => filePath.endsWith(".module.css")));
    assert.ok(!plan.dependencies.includes("oxlint"));
    const entry = plan.changes.find(({ path: filePath }) => filePath.endsWith("index.ts"));
    assert.match(entry.content, /export \{ cx, type ClassValue \}/);
    assert.doesNotMatch(entry.content, /SHARED_EXPORTS|undefined/);
    await applySetupPlan(plan);

    const beforeShow = await snapshot(root);
    const show = await planSetup({ root, mode: "show-config" });
    assert.equal(show.resolved.format, "compact");
    assert.match(formatResolvedContract(show.resolved), /Provenance:/);
    assert.deepEqual(await snapshot(root), beforeShow);

    const second = await planSetup({
      root,
      mode: "align",
    });
    assert.equal(second.status, "aligned");
    assert.ok(["missing", "not-verifiable"].includes(second.compatibility.status));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compact shared API admits a first module and enforces optional frozen public classes", async () => {
  const root = await createGreenfieldFixture();

  try {
    await write(
      root,
      "compact-profile.json",
      `${JSON.stringify(
        {
          format: "css-modules-compact",
          version: 1,
          preset: "vite-react@1",
          styles: { root: "src/foundation", alias: "#foundation" },
          sharedApi: {
            modules: [],
            admissionRule: { strategy: "project-review" },
          },
          composition: "markup",
          colors: false,
          checks: "error",
        },
        null,
        2,
      )}\n`,
    );
    const bootstrap = await planSetup({
      root,
      mode: "bootstrap",
      profileSource: "compact-profile.json",
    });
    assert.equal(bootstrap.status, "ready");
    assert.deepEqual(bootstrap.requiredInputs, []);
    await applySetupPlan(bootstrap);

    // project-review is intentionally agent-owned: the admission edits the
    // profile, real CSS module, existing barrel, and one consumer together.
    const profilePath = path.join(root, ".agents/css-modules.json");
    const admitted = JSON.parse(await readFile(profilePath, "utf8"));
    admitted.sharedApi.modules = [
      {
        name: "card",
        export: "card",
        path: "src/foundation/card.module.css",
        layer: "atoms",
      },
    ];
    await write(root, ".agents/css-modules.json", `${JSON.stringify(admitted, null, 2)}\n`);
    await write(
      root,
      "src/foundation/card.module.css",
      "@layer atoms {\n  .card { display: flex; }\n}\n",
    );
    const entryPath = path.join(root, "src/foundation/index.ts");
    await write(
      root,
      "src/foundation/index.ts",
      `${await readFile(entryPath, "utf8")}export { default as card } from "./card.module.css";\n`,
    );
    await write(
      root,
      "src/main.tsx",
      `${await readFile(path.join(root, "src/main.tsx"), "utf8")}import { card } from "#foundation";\nexport const admittedClassName = card.card;\n`,
    );

    const admissionPlan = await planSetup({ root, mode: "align" });
    assert.equal(admissionPlan.status, "aligned", JSON.stringify(admissionPlan, null, 2));
    assert.deepEqual(admissionPlan.changes, []);
    const inferred = await checkProject({ root, severity: "error" });
    assert.equal(inferred.status, "passed");
    assert.equal(admitted.sharedApi.modules[0].publicClasses, undefined);

    admitted.sharedApi.modules[0].publicClasses = ["card"];
    await write(root, ".agents/css-modules.json", `${JSON.stringify(admitted, null, 2)}\n`);
    assert.equal((await checkProject({ root, severity: "error" })).status, "passed");

    await write(
      root,
      "src/foundation/card.module.css",
      "@layer atoms {\n  .card { display: flex; }\n  .extra { display: flex; }\n}\n",
    );
    const added = await checkProject({ root, severity: "error" });
    assert.equal(added.status, "failed");
    assert.ok(
      added.findings.some(
        ({ ruleId, message }) =>
          ruleId === "css-modules/shared-public-class" && message.includes(".extra"),
      ),
    );

    await write(
      root,
      "src/foundation/card.module.css",
      "@layer atoms {\n  .replacement { display: flex; }\n}\n",
    );
    const removed = await checkProject({ root, severity: "error" });
    assert.equal(removed.status, "failed");
    assert.ok(
      removed.findings.some(
        ({ ruleId, message }) =>
          ruleId === "css-modules/shared-public-class" &&
          message.includes(".card") &&
          message.includes("absent"),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit legacy-to-compact migration compares and preserves the resolved contract", async () => {
  const root = await createGreenfieldFixture();

  try {
    const current = JSON.parse(await readFile(path.join(root, "selected-profile.json"), "utf8"));
    current.colorTokens = {
      enabled: true,
      paletteFiles: ["src/foundation/palette.css", "src/foundation/brand.css"],
      semanticFiles: ["src/foundation/colors.css", "src/foundation/roles.css"],
      themeOwner: "src/foundation/theme.ts",
      themeAttribute: "data-theme",
      modes: ["system", "light", "dark", "dim"],
      modeMapping: { dim: "dark" },
    };
    current.composition = { mode: "mixed-with-rule", rule: "@layer" };
    current.sharedApi.modules[0].publicClasses = ["cluster"];
    current.layers.localModules = { strategy: "custom", document: "docs/layers.md" };
    current.exceptions = [
      { kind: "rule", scope: "src/widgets/**", rule: "rule-id", reason: "library" },
    ];
    await write(root, ".agents/css-modules.json", `${JSON.stringify(current, null, 2)}\n`);

    const plan = await planSetup({
      root,
      mode: "migrate",
      authorizeMigrate: true,
      targetFormat: "compact",
    });
    assert.equal(plan.status, "ready");
    assert.equal(plan.migration.status, "supported");
    assert.deepEqual(plan.migration.differences, []);
    assert.deepEqual(
      plan.changes
        .filter(({ action }) => action === "replace")
        .map(({ path: filePath }) => filePath),
      [".agents/css-modules.json"],
    );
    const migrated = plan.changes.find(
      ({ path: filePath }) => filePath === ".agents/css-modules.json",
    );
    assert.match(migrated.content, /css-modules-compact/);
    assert.match(migrated.content, /modeMapping/);
    assert.match(migrated.content, /roles\.css/);
    await applySetupPlan(plan);

    const second = await planSetup({
      root,
      mode: "migrate",
      authorizeMigrate: true,
      targetFormat: "compact",
    });
    assert.equal(second.status, "aligned");
    assert.equal(second.migration?.status, "already-compact");
    assert.deepEqual(second.changes, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Oxlint packaging is explicit and does not replace the shared CSS contract checker", async () => {
  const root = await createGreenfieldFixture();

  try {
    await write(
      root,
      "oxlint-profile.json",
      `${JSON.stringify(
        {
          format: "css-modules-compact",
          version: 1,
          preset: "vite-react@1",
          styles: { root: "src/foundation", alias: "#foundation" },
          composition: "markup",
          colors: false,
          checks: "warn",
          lintEngine: "oxlint",
        },
        null,
        2,
      )}\n`,
    );
    const plan = await planSetup({ root, mode: "bootstrap", profileSource: "oxlint-profile.json" });
    assert.equal(plan.status, "ready");
    assert.ok(plan.dependencies.includes("oxlint"));
    assert.ok(
      plan.changes.some(({ path: filePath }) => filePath.endsWith("scripts/check-oxlint.mjs")),
    );
    assert.ok(
      plan.changes.some(({ path: filePath }) => filePath.endsWith("harness/oxlint-plugin.mjs")),
    );
    assert.ok(plan.changes.some(({ path: filePath }) => filePath.endsWith("scripts/check.mjs")));
    assert.ok(
      plan.changes.some(({ path: filePath }) => filePath.endsWith("harness/eslint-plugin.mjs")),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
