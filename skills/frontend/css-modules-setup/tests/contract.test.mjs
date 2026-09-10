import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPACT_FORMAT,
  COMPACT_SCHEMA_VERSION,
  compactFromLegacy,
  resolveContract,
} from "../scripts/contract.mjs";

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
