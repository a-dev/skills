#!/usr/bin/env node

// The contract module is the single interpretation seam for authored CSS
// Modules configuration. It has no project writes and its resolver is pure:
// filesystem discovery and schema validation happen at the edges.

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { exists, matchesGlob, readJson, resolveInside, validateProfile, walk } from "./lib.mjs";

export const COMPACT_FORMAT = "css-modules-compact";
export const COMPACT_SCHEMA_VERSION = 1;
export const LEGACY_FORMAT = "legacy";
export const COMMAND_KEYS = ["css:generate", "css:types", "css:check", "css:verify"];

const MODULE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = path.dirname(MODULE_ROOT);

async function readAsset(name) {
  const candidates = [
    path.join(SOURCE_ROOT, "assets", name),
    path.join(MODULE_ROOT, "../assets", name),
    path.join(MODULE_ROOT, "../../assets", name),
  ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(await readFile(candidate, "utf8"));
    } catch {
      // The installed harness keeps copied assets beside its scripts.
    }
  }
  throw new Error(`Unable to locate CSS Modules contract asset ${name}`);
}

const PRESETS = await readAsset("css-modules.presets.json");
const COMPACT_SCHEMA = await readAsset("css-modules.compact.schema.json");

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function posixPath(value) {
  return value
    .split(/[\\/]+/)
    .filter(Boolean)
    .join("/");
}

function relativeJoin(...parts) {
  return path.posix.join(...parts.map(posixPath));
}

function sourceFormat(input) {
  return input?.format === COMPACT_FORMAT ? "compact" : "legacy";
}

export function isCompactInput(input) {
  return sourceFormat(input) === "compact";
}

export function compactSchema() {
  return clone(COMPACT_SCHEMA);
}

function compactSemanticErrors(input) {
  const errors = [];
  if (input.colors === true) {
    errors.push("$.colors must be an object when colors are enabled");
  }
  if (input.colors && typeof input.colors === "object" && !Array.isArray(input.colors)) {
    for (const field of [
      "paletteFiles",
      "semanticFiles",
      "themeOwner",
      "themeAttribute",
      "modes",
    ]) {
      if (!(field in input.colors))
        errors.push(`$.colors.${field} is required when colors are enabled`);
    }
  }
  if (input.composition === "mixed-with-rule" && typeof input.compositionRule !== "string") {
    errors.push("$.compositionRule is required when composition is mixed-with-rule");
  }
  if (input.composition !== "mixed-with-rule" && input.compositionRule !== undefined) {
    errors.push("$.compositionRule is only supported for mixed-with-rule composition");
  }
  if (input.enforcement && input.checks === "off") {
    errors.push("$.enforcement cannot be combined with checks=off");
  }
  if (
    input.sharedApi?.admissionRule?.strategy === "explicit" &&
    !input.sharedApi.admissionRule.document
  ) {
    errors.push("$.sharedApi.admissionRule.document is required for explicit admission");
  }
  if (input.layers?.localModules?.strategy === "profiled" && !input.layers.localModules.layer) {
    errors.push("$.layers.localModules.layer is required for profiled local modules");
  }
  if (input.layers?.localModules?.strategy === "custom" && !input.layers.localModules.document) {
    errors.push("$.layers.localModules.document is required for custom local modules");
  }
  return errors;
}

export function validateInput(input, { schema, ignoreVersion = false } = {}) {
  if (isCompactInput(input)) {
    const errors = validateProfile(input, {
      schema: schema ?? COMPACT_SCHEMA,
      ignoreVersion,
    });
    return [...errors, ...compactSemanticErrors(input)];
  }
  return validateProfile(input, { schema, ignoreVersion });
}

export async function readInputSchema(root, profilePath, input) {
  const profileFile = resolveInside(root, profilePath);
  const fileName = isCompactInput(input)
    ? "css-modules.compact.schema.json"
    : "css-modules.schema.json";
  const besideProfile = path.join(path.dirname(profileFile), fileName);
  try {
    return JSON.parse(await readFile(besideProfile, "utf8"));
  } catch {
    return isCompactInput(input) ? COMPACT_SCHEMA : undefined;
  }
}

function presetFor(input) {
  const preset = PRESETS[input.preset];
  if (!preset) throw new Error(`Unknown CSS Modules preset ${input.preset}`);
  return preset;
}

function setProvenance(provenance, field, value) {
  if (value !== undefined) provenance[field] = value;
}

function commandFor(manager, name) {
  if (!manager) return undefined;
  if (manager === "npm") return `npm run ${name}`;
  if (manager === "pnpm") return `pnpm run ${name}`;
  if (manager === "yarn") return `yarn ${name}`;
  if (manager === "bun") return `bun run ${name}`;
  return undefined;
}

function resolveCommands(input, discoveredFacts, provenance) {
  const commands = {};
  const scripts = discoveredFacts.packageScripts ?? {};
  for (const key of COMMAND_KEYS) {
    if (typeof input.commands?.[key] === "string") {
      commands[key] = input.commands[key];
      setProvenance(provenance, `commands.${key}`, "explicit");
    } else if (typeof scripts[key] === "string") {
      const command = commandFor(discoveredFacts.packageManager, key);
      if (command) {
        commands[key] = command;
        setProvenance(provenance, `commands.${key}`, "discovered");
      }
    }
  }
  return commands;
}

function deriveOwnership(stylesRoot) {
  const parent = path.posix.dirname(posixPath(stylesRoot));
  const uiRoot = parent === "." ? "ui" : `${parent}/ui`;
  return [
    { glob: `${posixPath(stylesRoot)}/*.module.css`, layer: "atoms" },
    { glob: `${uiRoot}/**/*.module.css`, layer: "ui" },
  ];
}

function normalizeColors(input, provenance) {
  if (input.colors === false) {
    setProvenance(provenance, "colorTokens", "explicit");
    return { enabled: false };
  }
  const colors = input.colors ?? {};
  setProvenance(provenance, "colorTokens", "explicit");
  return {
    enabled: true,
    paletteFiles: clone(colors.paletteFiles),
    semanticFiles: clone(colors.semanticFiles),
    themeOwner: colors.themeOwner,
    themeAttribute: colors.themeAttribute,
    modes: clone(colors.modes),
    ...(colors.modeMapping ? { modeMapping: clone(colors.modeMapping) } : {}),
  };
}

function normalizeEnforcement(input, provenance) {
  if (input.checks === "off") return undefined;
  if (input.enforcement) {
    setProvenance(provenance, "enforcement", "explicit");
    return clone(input.enforcement);
  }
  setProvenance(provenance, "enforcement", "explicit");
  return { severity: input.checks === "warn" ? "warning" : "error" };
}

function explicitDrift(input, discoveredFacts, profile) {
  const drift = [];
  const compare = (
    field,
    explicit,
    discovered,
    normalizedExplicit = explicit,
    normalizedDiscovered = discovered,
  ) => {
    if (
      explicit !== undefined &&
      discovered !== undefined &&
      JSON.stringify(normalizedExplicit) !== JSON.stringify(normalizedDiscovered)
    ) {
      drift.push({
        field,
        explicit,
        discovered,
        detail: `${field} is explicitly ${JSON.stringify(explicit)} but executable discovery reports ${JSON.stringify(discovered)}`,
      });
    }
  };

  if (isCompactInput(input)) {
    compare(
      "appRoot",
      input.appRoot,
      discoveredFacts.appRoot,
      profile.appRoot,
      discoveredFacts.appRoot,
    );
    compare(
      "styles.root",
      input.styles?.root,
      discoveredFacts.stylesRoot,
      profile.stylesRoot,
      discoveredFacts.stylesRoot,
    );
    compare(
      "styles.alias",
      input.styles?.alias,
      discoveredFacts.alias?.bare,
      profile.alias.bare,
      discoveredFacts.alias?.bare,
    );
    compare(
      "helpers",
      input.helpers,
      discoveredFacts.helpers,
      profile.helpers,
      discoveredFacts.helpers,
    );
    compare(
      "layers.order",
      input.layers?.order,
      discoveredFacts.layers?.order,
      profile.layers.order,
      discoveredFacts.layers?.order,
    );
  } else {
    compare("appRoot", input.appRoot, discoveredFacts.appRoot);
    compare("stylesRoot", input.stylesRoot, discoveredFacts.stylesRoot);
    compare("alias", input.alias, discoveredFacts.alias);
    compare("helpers", input.helpers, discoveredFacts.helpers);
    compare("layers.order", input.layers?.order, discoveredFacts.layers?.order);
  }
  return drift;
}

function ambiguityFacts(input, discoveredFacts) {
  const ambiguities = [];
  if (!input.appRoot && discoveredFacts.appRoot && typeof discoveredFacts.appRoot === "object") {
    ambiguities.push({ field: "appRoot", values: discoveredFacts.appRoot.values ?? [] });
  }
  return ambiguities;
}

// An explicit choice wins; otherwise the harness follows the linter the project
// already runs, so an Oxlint project never gains ESLint just for CSS checks.
function resolveLintEngine(input, discoveredFacts, provenance) {
  const discovered = discoveredFacts.lintEngine;
  setProvenance(
    provenance,
    "lintEngine",
    input.lintEngine ? "explicit" : discovered ? "discovered" : "preset",
  );
  return input.lintEngine ?? discovered ?? "eslint";
}

function resolveLegacy(input, discoveredFacts, provenance) {
  const profile = clone(input);
  // The schema pointer describes the authored file, not the project contract.
  // Keep it out of the normalized comparison so format migration is lossless.
  delete profile.$schema;
  profile.lintEngine = resolveLintEngine(input, discoveredFacts, provenance);
  for (const field of [
    "methodologyVersion",
    "profileSchemaVersion",
    "adapter",
    "appRoot",
    "stylesRoot",
    "globalStylesheet",
    "alias",
    "helpers",
    "sharedApi",
    "layers",
    "composition",
    "colorTokens",
    "commands",
    "runtimeVerification",
    "enforcement",
    "exceptions",
    "extensions",
  ]) {
    if (profile[field] !== undefined) setProvenance(provenance, field, "explicit");
  }
  return profile;
}

function resolveCompact(input, discoveredFacts, provenance) {
  const preset = presetFor(input);
  const presetName = input.preset;
  setProvenance(provenance, "preset", "explicit");
  const discoveredAppRoot =
    typeof discoveredFacts.appRoot === "string" ? discoveredFacts.appRoot : undefined;
  const appRoot = input.appRoot ?? discoveredAppRoot ?? ".";
  setProvenance(
    provenance,
    "appRoot",
    input.appRoot ? "explicit" : discoveredAppRoot ? "discovered" : "preset",
  );
  const stylesRoot = input.styles.root;
  setProvenance(provenance, "styles.root", "explicit");
  const globalStylesheet = input.styles.globalStylesheet ?? relativeJoin(stylesRoot, "global.css");
  const entryPoint =
    input.styles.entryPoint ?? input.sharedApi?.entryPoint ?? relativeJoin(stylesRoot, "index.ts");
  setProvenance(
    provenance,
    "styles.globalStylesheet",
    input.styles.globalStylesheet ? "explicit" : "preset",
  );
  setProvenance(
    provenance,
    "styles.entryPoint",
    input.styles.entryPoint || input.sharedApi?.entryPoint ? "explicit" : "preset",
  );
  const aliasBare = input.styles.alias;
  const aliasSubpath = input.styles.subpath ?? `${aliasBare}/*`;
  setProvenance(provenance, "styles.alias", "explicit");
  setProvenance(provenance, "styles.subpath", input.styles.subpath ? "explicit" : "preset");

  const helpers = {
    ...clone(preset.helpers),
    ...clone(input.helpers ?? {}),
  };
  setProvenance(
    provenance,
    "helpers.classNames",
    input.helpers?.classNames ? "explicit" : "preset",
  );
  setProvenance(
    provenance,
    "helpers.cssVariables",
    input.helpers?.cssVariables ? "explicit" : "preset",
  );

  const layerInput = input.layers ?? {};
  const layers = {
    order: clone(layerInput.order ?? preset.layers.order),
    ownership: clone(layerInput.ownership ?? deriveOwnership(stylesRoot)),
    localModules: {
      ...clone(preset.layers.localModules),
      ...clone(layerInput.localModules ?? {}),
    },
    ...(layerInput.importantPolicy !== undefined
      ? { importantPolicy: layerInput.importantPolicy }
      : {}),
  };
  setProvenance(provenance, "layers.order", layerInput.order ? "explicit" : "preset");
  setProvenance(provenance, "layers.ownership", layerInput.ownership ? "explicit" : "preset");
  setProvenance(provenance, "layers.localModules", layerInput.localModules ? "explicit" : "preset");

  const sharedInput = input.sharedApi ?? {};
  const sharedApi = {
    entryPoint,
    modules: clone(sharedInput.modules ?? []),
    admissionRule: clone(sharedInput.admissionRule ?? { strategy: "project-review" }),
  };
  setProvenance(provenance, "sharedApi.modules", sharedInput.modules ? "explicit" : "preset");
  setProvenance(
    provenance,
    "sharedApi.admissionRule",
    sharedInput.admissionRule ? "explicit" : "preset",
  );

  const composition = {
    mode: input.composition,
    ...(input.compositionRule !== undefined ? { rule: input.compositionRule } : {}),
  };
  setProvenance(provenance, "composition", "explicit");
  const commands = resolveCommands(input, discoveredFacts, provenance);
  const enforcement = normalizeEnforcement(input, provenance);
  const profile = {
    methodologyVersion: preset.methodologyVersion,
    profileSchemaVersion: preset.profileSchemaVersion,
    adapter: clone(preset.adapter),
    appRoot,
    stylesRoot,
    globalStylesheet,
    alias: { bare: aliasBare, subpath: aliasSubpath },
    helpers,
    sharedApi,
    layers,
    composition,
    colorTokens: normalizeColors(input, provenance),
    commands,
    ...(input.runtimeVerification ? { runtimeVerification: clone(input.runtimeVerification) } : {}),
    ...(enforcement ? { enforcement } : {}),
    exceptions: clone(input.exceptions ?? []),
    ...(input.extensions ? { extensions: clone(input.extensions) } : {}),
    lintEngine: resolveLintEngine(input, discoveredFacts, provenance),
  };
  setProvenance(provenance, "methodologyVersion", "preset");
  setProvenance(provenance, "profileSchemaVersion", "preset");
  setProvenance(provenance, "adapter", "preset");
  setProvenance(provenance, "exceptions", input.exceptions ? "explicit" : "preset");
  return { profile, preset: presetName };
}

function ownerResult(profile, relativeFile) {
  const owners = profile.layers.ownership.filter(({ glob }) => matchesGlob(relativeFile, glob));
  if (owners.length > 1) return { status: "ambiguous", matches: owners };
  if (owners.length === 1) return { status: "resolved", layer: owners[0].layer, matches: owners };
  if (!relativeFile.endsWith(".module.css"))
    return { status: "undecided", layer: undefined, matches: [] };
  if (profile.layers.localModules.strategy === "unlayered") {
    return { status: "resolved", layer: null, matches: [] };
  }
  if (profile.layers.localModules.strategy === "profiled") {
    return { status: "resolved", layer: profile.layers.localModules.layer, matches: [] };
  }
  return { status: "undecided", layer: undefined, matches: [] };
}

export function resolveLayerOwner(contractOrProfile, relativeFile) {
  return ownerResult(contractOrProfile.profile ?? contractOrProfile, relativeFile);
}

export function sharedApiInterpretation(contractOrProfile) {
  const profile = contractOrProfile.profile ?? contractOrProfile;
  return {
    classNamesHelper: profile.helpers.classNames,
    cssVariablesHelper: profile.helpers.cssVariables,
    sharedApiSources: [profile.alias.bare, profile.sharedApi.entryPoint],
    sharedCssModuleExports: profile.sharedApi.modules
      .map(({ export: exportName }) => exportName)
      .filter(Boolean),
    entryPoint: profile.sharedApi.entryPoint,
    modules: profile.sharedApi.modules,
  };
}

// Settings for the css-modules/* TSX rules; both lint engines receive the same object.
export function tsxRuleSettings(contractOrProfile) {
  const profile = contractOrProfile.profile ?? contractOrProfile;
  return {
    ...sharedApiInterpretation(profile),
    privateBooleanAttributes: profile.enforcement?.privateBooleanAttributes ?? ["data-loading"],
  };
}

export function resolveContract(input, { discoveredFacts = {} } = {}) {
  const format = sourceFormat(input);
  const provenance = {};
  const resolved =
    format === "compact"
      ? resolveCompact(input, discoveredFacts, provenance)
      : { profile: resolveLegacy(input, discoveredFacts, provenance), preset: undefined };
  const profile = resolved.profile;
  const drift = explicitDrift(input, discoveredFacts, profile);
  const ambiguities = ambiguityFacts(input, discoveredFacts);
  const unverified = [];
  if (ambiguities.length) unverified.push("appRoot selection");
  for (const key of ["css:generate", "css:types"]) {
    if (!profile.commands?.[key]) unverified.push(`commands.${key}`);
  }
  return {
    format,
    version: format === "compact" ? input.version : profile.profileSchemaVersion,
    preset: resolved.preset,
    profile,
    input: clone(input),
    provenance,
    owners: {
      exactOneLayerOwner: true,
      ownership: clone(profile.layers.ownership),
      fallback: clone(profile.layers.localModules),
      sharedApi: sharedApiInterpretation(profile),
    },
    commands: clone(profile.commands ?? {}),
    drift,
    ambiguities,
    unverified,
  };
}

const LINT_CONFIG_FILES = {
  oxlint: [
    ".oxlintrc.json",
    ".oxlintrc.jsonc",
    "oxlint.config.ts",
    "oxlint.config.mts",
    "oxlint.config.js",
    "oxlint.config.mjs",
  ],
  eslint: [
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    "eslint.config.ts",
    "eslint.config.mts",
    "eslint.config.cts",
    ".eslintrc",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.json",
    ".eslintrc.yaml",
    ".eslintrc.yml",
  ],
};

function singleEngine(engines) {
  return engines.length === 1 ? engines[0] : undefined;
}

// Config files and scripts show which linter the project itself runs. A bare
// dependency is weaker evidence: earlier harness versions installed ESLint
// into Oxlint projects, so dependencies only decide when nothing else does.
// Projects running both linters keep the ESLint default.
async function discoverLintEngine(root, packageJson) {
  const scripts = Object.values(packageJson?.scripts ?? {}).filter(
    (command) => typeof command === "string" && !command.includes("css-modules-harness"),
  );
  const configured = [];
  for (const [engine, files] of Object.entries(LINT_CONFIG_FILES)) {
    const hasConfig = (await Promise.all(files.map((file) => exists(path.join(root, file))))).some(
      Boolean,
    );
    const runsEngine = scripts.some((command) => new RegExp(`\\b${engine}\\b`).test(command));
    if (hasConfig || runsEngine) configured.push(engine);
  }
  if (configured.length > 0) return singleEngine(configured);
  const dependencies = {
    ...packageJson?.dependencies,
    ...packageJson?.devDependencies,
  };
  return singleEngine(Object.keys(LINT_CONFIG_FILES).filter((engine) => engine in dependencies));
}

export async function discoverProjectFacts(root) {
  const resolvedRoot = path.resolve(root);
  const packagePath = path.join(resolvedRoot, "package.json");
  let packageManager;
  let packageScripts = {};
  let packageImports;
  let packageJson;
  if (await exists(packagePath)) {
    packageJson = await readJson(packagePath);
    packageManager = packageJson.packageManager?.split("@")[0];
    packageScripts = packageJson.scripts ?? {};
    packageImports = packageJson.imports;
  }
  const lintEngine = await discoverLintEngine(resolvedRoot, packageJson);
  if (!packageManager) {
    const markers = [
      ["pnpm", "pnpm-lock.yaml"],
      ["yarn", "yarn.lock"],
      ["bun", "bun.lock"],
      ["bun", "bun.lockb"],
      ["npm", "package-lock.json"],
    ];
    const resolvedManagers = [];
    for (const [manager, marker] of markers) {
      if (await exists(path.join(resolvedRoot, marker))) resolvedManagers.push({ manager, marker });
    }
    if (new Set(resolvedManagers.map(({ manager }) => manager)).size === 1) {
      packageManager = resolvedManagers[0].manager;
    }
  }
  const viteNames = new Set([
    "vite.config.ts",
    "vite.config.mts",
    "vite.config.js",
    "vite.config.mjs",
    "vite.config.cjs",
    "vite.config.cts",
  ]);
  const configs = await walk(resolvedRoot, (filePath) => viteNames.has(path.basename(filePath)));
  const appRoots = [
    ...new Set(
      configs.map((filePath) => path.relative(resolvedRoot, path.dirname(filePath)) || "."),
    ),
  ].sort();
  const aliases = Object.keys(packageImports ?? {}).filter((key) => key.startsWith("#"));
  const bareAlias = aliases.find((key) => !key.endsWith("/*"));
  const subpathAlias = aliases.find((key) => key.endsWith("/*"));
  return {
    packageManager,
    packageScripts,
    ...(lintEngine ? { lintEngine } : {}),
    ...(bareAlias
      ? { alias: { bare: bareAlias, ...(subpathAlias ? { subpath: subpathAlias } : {}) } }
      : {}),
    appRoot:
      appRoots.length === 1
        ? appRoots[0]
        : appRoots.length > 1
          ? { status: "ambiguous", values: appRoots }
          : undefined,
    appRoots,
  };
}

export async function readResolvedContract(
  root,
  profilePath = ".agents/css-modules.json",
  options = {},
) {
  const resolvedRoot = path.resolve(root);
  const input = await readJson(resolveInside(resolvedRoot, profilePath));
  const schema = await readInputSchema(resolvedRoot, profilePath, input);
  const errors = validateInput(input, { schema });
  if (errors.length) throw new Error(`Invalid CSS Modules configuration: ${errors.join("; ")}`);
  const discoveredFacts = options.discoveredFacts ?? (await discoverProjectFacts(resolvedRoot));
  const contract = resolveContract(input, { discoveredFacts });
  if (contract.ambiguities.length) {
    throw new Error(
      `Ambiguous CSS Modules configuration: ${contract.ambiguities.map(({ field, values }) => `${field}: ${values.join(", ")}`).join("; ")}`,
    );
  }
  return contract;
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function differsFrom(value, expected) {
  return value !== undefined && !same(value, expected);
}

export function compactFromLegacy(legacy, { preset = "vite-react@1" } = {}) {
  const presetData = PRESETS[preset];
  if (!presetData) throw new Error(`Unknown CSS Modules preset ${preset}`);
  if (legacy.methodologyVersion !== presetData.methodologyVersion) {
    throw new Error(
      `methodologyVersion cannot be represented by ${preset}: ${legacy.methodologyVersion}`,
    );
  }
  if (legacy.profileSchemaVersion !== presetData.profileSchemaVersion) {
    throw new Error(
      `profileSchemaVersion cannot be represented by ${preset}: ${legacy.profileSchemaVersion}`,
    );
  }
  if (!same(legacy.adapter, presetData.adapter)) {
    throw new Error(
      `adapter cannot be represented by ${preset}: ${legacy.adapter.name}@${legacy.adapter.version}`,
    );
  }
  const defaultLayers = {
    order: presetData.layers.order,
    ownership: deriveOwnership(legacy.stylesRoot),
    localModules: presetData.layers.localModules,
  };
  const candidate = {
    $schema: "./css-modules.compact.schema.json",
    format: COMPACT_FORMAT,
    version: COMPACT_SCHEMA_VERSION,
    preset,
    styles: {
      root: legacy.stylesRoot,
      alias: legacy.alias.bare,
      ...(legacy.alias.subpath !== `${legacy.alias.bare}/*`
        ? { subpath: legacy.alias.subpath }
        : {}),
      ...(legacy.globalStylesheet !== relativeJoin(legacy.stylesRoot, "global.css")
        ? { globalStylesheet: legacy.globalStylesheet }
        : {}),
      ...(legacy.sharedApi.entryPoint !== relativeJoin(legacy.stylesRoot, "index.ts")
        ? { entryPoint: legacy.sharedApi.entryPoint }
        : {}),
    },
    composition: legacy.composition.mode,
    ...(legacy.composition.rule !== undefined ? { compositionRule: legacy.composition.rule } : {}),
    colors: legacy.colorTokens.enabled
      ? clone({
          paletteFiles: legacy.colorTokens.paletteFiles,
          semanticFiles: legacy.colorTokens.semanticFiles,
          themeOwner: legacy.colorTokens.themeOwner,
          themeAttribute: legacy.colorTokens.themeAttribute,
          modes: legacy.colorTokens.modes,
          ...(legacy.colorTokens.modeMapping
            ? { modeMapping: legacy.colorTokens.modeMapping }
            : {}),
        })
      : false,
    checks:
      legacy.enforcement?.severity === "warning"
        ? "warn"
        : legacy.enforcement?.severity === "error"
          ? "error"
          : "off",
  };
  if (legacy.appRoot !== ".") candidate.appRoot = legacy.appRoot;
  if (differsFrom(legacy.helpers, presetData.helpers)) candidate.helpers = clone(legacy.helpers);
  if (
    legacy.sharedApi.modules.length ||
    !same(legacy.sharedApi.admissionRule, { strategy: "project-review" })
  ) {
    candidate.sharedApi = {
      modules: clone(legacy.sharedApi.modules),
      admissionRule: clone(legacy.sharedApi.admissionRule),
    };
  }
  if (
    !same(legacy.layers.order, defaultLayers.order) ||
    !same(legacy.layers.ownership, defaultLayers.ownership) ||
    !same(legacy.layers.localModules, defaultLayers.localModules) ||
    legacy.layers.importantPolicy !== undefined
  ) {
    candidate.layers = clone(legacy.layers);
  }
  if (legacy.runtimeVerification !== undefined)
    candidate.runtimeVerification = clone(legacy.runtimeVerification);
  if (legacy.enforcement?.privateBooleanAttributes) {
    candidate.enforcement = clone(legacy.enforcement);
  }
  if (legacy.commands && Object.keys(legacy.commands).length)
    candidate.commands = clone(legacy.commands);
  if (legacy.exceptions !== undefined) candidate.exceptions = clone(legacy.exceptions);
  if (legacy.extensions !== undefined) candidate.extensions = clone(legacy.extensions);
  if (legacy.lintEngine) candidate.lintEngine = legacy.lintEngine;
  return candidate;
}

function diffValues(left, right, field = "", output = []) {
  if (same(left, right)) return output;
  if (
    left &&
    right &&
    typeof left === "object" &&
    typeof right === "object" &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      diffValues(left[key], right[key], field ? `${field}.${key}` : key, output);
    }
    return output;
  }
  output.push({ field, before: clone(left), after: clone(right) });
  return output;
}

export function planLegacyToCompact(
  legacy,
  { discoveredFacts = {}, preset = "vite-react@1" } = {},
) {
  const errors = [];
  let candidate;
  try {
    candidate = compactFromLegacy(legacy, { preset });
  } catch (error) {
    errors.push({
      field: error.message.split(" cannot be represented")[0],
      message: error.message,
    });
    return { status: "unsupported", candidate: undefined, errors, differences: [] };
  }
  const before = resolveContract(legacy, { discoveredFacts });
  const after = resolveContract(candidate, { discoveredFacts });
  const differences = diffValues(before.profile, after.profile);
  if (differences.length) {
    errors.push(
      ...differences.map(({ field, before: oldValue, after: newValue }) => ({
        field,
        message: `Resolved field ${field} would change during legacy-to-compact migration`,
        before: oldValue,
        after: newValue,
      })),
    );
  }
  return {
    status: errors.length ? "unsupported" : "supported",
    candidate,
    before,
    after,
    errors,
    differences,
  };
}

export function resolvedOutput(contract) {
  return {
    format: contract.format,
    version: contract.version,
    ...(contract.preset ? { preset: contract.preset } : {}),
    profile: clone(contract.profile),
    provenance: clone(contract.provenance),
    owners: clone(contract.owners),
    commands: clone(contract.commands),
    compatibility: {
      drift: clone(contract.drift),
      ambiguities: clone(contract.ambiguities),
    },
    unverified: clone(contract.unverified),
  };
}

export function formatResolvedContract(contract) {
  const output = resolvedOutput(contract);
  const lines = [
    "CSS Modules resolved configuration",
    `Format: ${output.format}`,
    `Version: ${output.version}`,
    ...(output.preset ? [`Preset: ${output.preset}`] : []),
    "",
    "Resolved profile:",
  ];
  for (const [field, value] of Object.entries(output.profile)) {
    lines.push(`  ${field}: ${JSON.stringify(value)}`);
  }
  lines.push("", "Provenance:");
  for (const [field, source] of Object.entries(output.provenance))
    lines.push(`  ${field}: ${source}`);
  lines.push("", "Layer owners:");
  for (const owner of output.owners.ownership) lines.push(`  ${owner.glob} -> ${owner.layer}`);
  lines.push(`  fallback: ${JSON.stringify(output.owners.fallback)}`);
  lines.push("", "Commands:");
  for (const [id, command] of Object.entries(output.commands)) lines.push(`  ${id}: ${command}`);
  if (!Object.keys(output.commands).length) lines.push("  none discovered or explicitly recorded");
  lines.push(
    "",
    `Drift: ${output.compatibility.drift.length}`,
    `Unverified: ${output.unverified.length}`,
  );
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = { root: process.cwd(), profilePath: ".agents/css-modules.json", format: "human" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") options.root = argv[++index];
    else if (argument === "--profile") options.profilePath = argv[++index];
    else if (argument === "--format") options.format = argv[++index];
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!["human", "json"].includes(options.format)) throw new Error("format must be human or json");
  return options;
}

function usage() {
  return [
    "Usage: node contract.mjs [options]",
    "",
    "Read-only resolved CSS Modules configuration output.",
    "--root <path>          project root; defaults to cwd",
    "--profile <path>       authored profile path relative to root",
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
    const contract = await readResolvedContract(options.root, options.profilePath);
    process.stdout.write(
      options.format === "json"
        ? `${JSON.stringify(resolvedOutput(contract), null, 2)}\n`
        : `${formatResolvedContract(contract)}\n`,
    );
  } catch (error) {
    process.stderr.write(`Resolved configuration failed: ${error.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
