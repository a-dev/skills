import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  COMPACT_FORMAT,
  COMPACT_SCHEMA_VERSION,
  compactFromLegacy,
  readResolvedContract,
  resolveContract,
} from "../scripts/contract.mjs";
import { readProfile } from "../scripts/lib.mjs";

const legacy = {
  methodologyVersion: "1.0.0",
  profileSchemaVersion: 1,
  adapter: { name: "vite-react", version: "1.0.0" },
  appRoot: ".",
  stylesRoot: "src/shared/styles",
  globalStylesheet: "src/shared/styles/global.css",
  alias: { bare: "#styles", subpath: "#styles/*" },
  helpers: { classNames: "cx", cssVariables: "cssVars" },
  sharedApi: {
    entryPoint: "src/shared/styles/index.ts",
    modules: [],
    admissionRule: { strategy: "project-review" },
  },
  layers: {
    order: ["reset", "base", "atoms", "ui"],
    ownership: [{ glob: "src/shared/styles/*.module.css", layer: "atoms" }],
    localModules: { strategy: "unlayered" },
  },
  composition: { mode: "markup" },
  colorTokens: { enabled: false },
  commands: {
    "css:generate": "bun run css:generate",
    "css:types": "bun run css:types",
  },
  enforcement: { severity: "warning", privateBooleanAttributes: ["data-loading"] },
  exceptions: [],
};

test("compact input resolves derived paths, helpers, topology, and actual commands", () => {
  const compact = {
    format: COMPACT_FORMAT,
    version: COMPACT_SCHEMA_VERSION,
    preset: "vite-react@1",
    styles: { root: "src/shared/styles", alias: "#styles" },
    composition: "markup",
    colors: false,
    checks: "warn",
  };
  const result = resolveContract(compact, {
    discoveredFacts: {
      appRoot: ".",
      packageManager: "bun",
      packageScripts: { "css:generate": "vite-css-modules", "css:types": "tsc --noEmit" },
    },
  });

  assert.equal(result.format, "compact");
  assert.equal(result.profile.globalStylesheet, "src/shared/styles/global.css");
  assert.equal(result.profile.sharedApi.entryPoint, "src/shared/styles/index.ts");
  assert.deepEqual(result.profile.alias, { bare: "#styles", subpath: "#styles/*" });
  assert.deepEqual(result.profile.helpers, { classNames: "cx", cssVariables: "cssVars" });
  assert.deepEqual(result.profile.sharedApi.modules, []);
  assert.deepEqual(result.profile.commands, {
    "css:generate": "bun run css:generate",
    "css:types": "bun run css:types",
  });
  assert.equal(result.provenance["styles.globalStylesheet"], "preset");
  assert.equal(result.provenance["commands.css:generate"], "discovered");
});

test("compact resolution does not invent absent commands and preserves explicit overrides", () => {
  const compact = {
    format: COMPACT_FORMAT,
    version: COMPACT_SCHEMA_VERSION,
    preset: "vite-react@1",
    styles: { root: "src/styles", alias: "#shared" },
    composition: "markup",
    colors: false,
    checks: "error",
    commands: { "css:types": "pnpm run typecheck" },
  };
  const result = resolveContract(compact, {
    discoveredFacts: { appRoot: ".", packageManager: "npm", packageScripts: {} },
  });

  assert.deepEqual(result.profile.commands, { "css:types": "pnpm run typecheck" });
  assert.equal(result.provenance["commands.css:types"], "explicit");
  assert.equal(result.profile.commands["css:generate"], undefined);
});

test("explicit compact choices remain visible when discovered facts disagree", () => {
  const compact = {
    format: COMPACT_FORMAT,
    version: COMPACT_SCHEMA_VERSION,
    preset: "vite-react@1",
    styles: { root: "src/styles", alias: "#shared" },
    composition: "markup",
    colors: false,
    checks: "warn",
  };
  const result = resolveContract(compact, {
    discoveredFacts: {
      appRoot: ".",
      stylesRoot: "src/other-styles",
      alias: { bare: "#other", subpath: "#other/*" },
    },
  });

  assert.deepEqual(
    result.drift.map(({ field }) => field),
    ["styles.root", "styles.alias"],
  );
  assert.equal(result.profile.stylesRoot, "src/styles");
  assert.equal(result.profile.alias.bare, "#shared");
});

test("legacy profiles map losslessly to compact input including colors, policy, and exceptions", () => {
  const compact = compactFromLegacy(legacy);
  const before = resolveContract(legacy).profile;
  const after = resolveContract(compact, {
    discoveredFacts: { appRoot: ".", packageManager: "bun", packageScripts: {} },
  }).profile;

  assert.equal(compact.format, COMPACT_FORMAT);
  assert.equal(compact.version, COMPACT_SCHEMA_VERSION);
  assert.equal(compact.styles.alias, "#styles");
  assert.deepEqual(after, before);
  assert.deepEqual(compact.enforcement, legacy.enforcement);
  assert.deepEqual(compact.exceptions, []);
});

test("a schema file beside the profile never changes validation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "css-modules-contract-schema-"));
  const discoveredFacts = { appRoot: ".", packageManager: "npm", packageScripts: {} };
  const compact = {
    format: COMPACT_FORMAT,
    version: COMPACT_SCHEMA_VERSION,
    preset: "vite-react@1",
    styles: { root: "src/styles", alias: "#styles" },
    composition: "markup",
    colors: false,
    checks: "warn",
  };

  try {
    await mkdir(path.join(root, ".agents"));
    const writeAgents = (name, value) =>
      writeFile(path.join(root, ".agents", name), `${JSON.stringify(value, null, 2)}\n`);

    // A stricter edited copy does not reject a valid compact profile.
    await writeAgents("css-modules.json", compact);
    await writeAgents("css-modules.compact.schema.json", {
      type: "object",
      required: ["unknownField"],
    });
    const resolved = await readResolvedContract(root, ".agents/css-modules.json", {
      discoveredFacts,
    });
    assert.equal(resolved.format, "compact");

    // A permissive edited copy does not admit an invalid one.
    await writeAgents("css-modules.json", { ...compact, checks: "sometimes" });
    await writeAgents("css-modules.compact.schema.json", {});
    await assert.rejects(
      readResolvedContract(root, ".agents/css-modules.json", { discoveredFacts }),
      /Invalid CSS Modules configuration/,
    );

    // The same holds for legacy profiles and their schema copy.
    const legacyProfile = {
      ...legacy,
      sharedApi: {
        ...legacy.sharedApi,
        modules: [
          {
            name: "atoms",
            export: "atoms",
            path: "src/shared/styles/atoms.module.css",
            layer: "atoms",
            publicClasses: ["stack"],
          },
        ],
      },
    };
    await writeAgents("css-modules.json", { ...legacyProfile, appRoot: 42 });
    await writeAgents("css-modules.schema.json", {});
    await assert.rejects(readProfile(root, ".agents/css-modules.json"), /Invalid CSS Modules/);
    await writeAgents("css-modules.json", legacyProfile);
    await writeAgents("css-modules.schema.json", { type: "object", required: ["unknownField"] });
    assert.deepEqual(await readProfile(root, ".agents/css-modules.json"), legacyProfile);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
