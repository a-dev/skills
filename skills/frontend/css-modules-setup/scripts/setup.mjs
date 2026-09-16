#!/usr/bin/env node

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import postcss from "postcss";

import { auditProject } from "./audit.mjs";
import {
  COMPACT_SCHEMA_REF,
  LEGACY_SCHEMA_REF,
  discoverProjectFacts,
  formatResolvedContract,
  isCompactInput,
  planLegacyToCompact,
  resolveContract,
  readResolvedContract,
  validateInput,
  resolvedOutput,
} from "./contract.mjs";
import { exists, preflightWriteSet, readJson, resolveInside } from "./lib.mjs";

const MODES = new Set(["audit", "bootstrap", "align", "migrate", "verify", "show-config"]);
const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.dirname(SCRIPT_ROOT);
const ASSET_ROOT = path.join(SKILL_ROOT, "assets");
const TEMPLATE_ROOT = path.join(ASSET_ROOT, "templates");
const HARNESS_ROOT = path.join(SKILL_ROOT, "harness");
const VERSION_CONTRACT = JSON.parse(await readFile(path.join(SKILL_ROOT, "versions.json"), "utf8"));
const SUPPORTED_METHODOLOGY_MAJOR = Number.parseInt(
  VERSION_CONTRACT.methodologyVersion.split(".")[0],
  10,
);
const SUPPORTED_PROFILE_SCHEMA = VERSION_CONTRACT.profileSchemaVersion;
const SUPPORTED_COMPACT_SCHEMA = VERSION_CONTRACT.compactSchemaVersion ?? 1;
const SUPPORTED_ADAPTERS = new Map(
  Object.entries(VERSION_CONTRACT.adapters).map(([name, adapter]) => [
    name,
    Number.parseInt(adapter.version.split(".")[0], 10),
  ]),
);
const SCRIPT_ROOT_FILES = [
  "audit.mjs",
  "layer-analysis.mjs",
  "color-analysis.mjs",
  "contract.mjs",
  "check.mjs",
  "lib.mjs",
];
// eslint-plugin.mjs holds the rule implementations that oxlint-plugin.mjs
// re-exports; it has no ESLint import and ships with both engines.
const BASE_HARNESS_FILES = ["eslint-plugin.mjs", "stylelint-plugin.mjs"];
const OXLINT_SCRIPT_FILES = ["check-oxlint.mjs"];
const OXLINT_HARNESS_FILES = ["oxlint-plugin.mjs"];
const HARNESS_ROOT_PATH = ".agents/css-modules-harness";
// Earlier setups copied the matching schema beside the profile and pointed
// $schema at it. The harness assets now carry both schemas, so these copies are
// obsolete. The bundled $id (equal to that old $schema value) marks a copy as
// skill-owned, which migrate may delete.
const PROFILE_SCHEMA_COPIES = [
  { path: ".agents/css-modules.schema.json", id: "./css-modules.schema.json" },
  { path: ".agents/css-modules.compact.schema.json", id: "./css-modules.compact.schema.json" },
];
const BASE_ENFORCEMENT_DEPENDENCIES = [
  "color-name",
  "postcss",
  "postcss-selector-parser",
  "postcss-value-parser",
  "stylelint",
];
const ENGINE_DEPENDENCIES = {
  eslint: ["@babel/core", "@babel/eslint-parser", "eslint"],
  oxlint: ["oxc-parser", "oxlint"],
};
const TEMPLATE_DEPENDENCIES = ["postcss"];

function enforcementDependencies(engine = "eslint") {
  return [...BASE_ENFORCEMENT_DEPENDENCIES, ...ENGINE_DEPENDENCIES[engine]].sort();
}

function versionMajor(version) {
  return Number.parseInt(version.split(".")[0], 10);
}

function statusForFindings(findings) {
  if (findings.some(({ status }) => status === "ambiguous")) return "ambiguous";
  if (findings.some(({ status }) => status === "drifted")) return "drifted";
  if (findings.some(({ status }) => status === "missing")) return "missing";
  if (findings.some(({ status }) => status === "not-verifiable")) return "not-verifiable";
  return "aligned";
}

function isBlockingPlanFinding({ id, status }) {
  if (status === "ambiguous") return true;
  if (
    (id === "profile.adapter-version" || id === "selected-profile.adapter-version") &&
    ["drifted", "not-verifiable"].includes(status)
  ) {
    return true;
  }
  if (status !== "drifted") return false;
  return (
    id === "profile.methodology-version" ||
    id === "selected-profile.methodology-version" ||
    id === "profile.schema-version" ||
    id === "selected-profile.schema-version" ||
    id === "layers.order" ||
    id.startsWith("layers.module.") ||
    id.startsWith("layers.ownership.") ||
    id === "styles.global-import" ||
    id === "colors.palette-boundary" ||
    id === "colors.theme-ownership" ||
    id.startsWith("contract.drift.")
  );
}

function selectedVersionFindings(profile, input) {
  const findings = [];
  const methodologyMajor = versionMajor(profile.methodologyVersion);
  findings.push(
    methodologyMajor === SUPPORTED_METHODOLOGY_MAJOR
      ? {
          id: "selected-profile.methodology-version",
          status: "aligned",
          detail: profile.methodologyVersion,
        }
      : {
          id: "selected-profile.methodology-version",
          status: "drifted",
          detail: "Selected profile methodology is unsupported; plan an explicit migration",
          expected: SUPPORTED_METHODOLOGY_MAJOR,
          actual: methodologyMajor,
        },
  );
  const schemaVersion = isCompactInput(input) ? input.version : profile.profileSchemaVersion;
  const supportedSchemaVersion = isCompactInput(input)
    ? SUPPORTED_COMPACT_SCHEMA
    : SUPPORTED_PROFILE_SCHEMA;
  findings.push(
    schemaVersion === supportedSchemaVersion
      ? {
          id: "selected-profile.schema-version",
          status: "aligned",
          detail: schemaVersion,
        }
      : {
          id: "selected-profile.schema-version",
          status: "drifted",
          detail: "Selected profile schema is unsupported; plan an explicit migration",
          expected: supportedSchemaVersion,
          actual: schemaVersion,
        },
  );
  const adapterMajor = versionMajor(profile.adapter.version);
  const supportedAdapterMajor = SUPPORTED_ADAPTERS.get(profile.adapter.name);
  findings.push(
    supportedAdapterMajor === undefined
      ? {
          id: "selected-profile.adapter-version",
          status: "not-verifiable",
          detail:
            "No executable adapter is bundled for " +
            profile.adapter.name +
            "@" +
            profile.adapter.version,
        }
      : adapterMajor === supportedAdapterMajor
        ? {
            id: "selected-profile.adapter-version",
            status: "aligned",
            detail: profile.adapter.name + "@" + profile.adapter.version,
          }
        : {
            id: "selected-profile.adapter-version",
            status: "drifted",
            detail: "Selected profile adapter is unsupported; plan an explicit migration",
            expected: supportedAdapterMajor,
            actual: adapterMajor,
          },
  );
  return findings;
}

function makeCompatibility(audit, extraFindings = [], mode) {
  const findings = [...audit.findings, ...extraFindings];
  let blockingFindings = findings.filter(isBlockingPlanFinding);
  let migration = "not-requested";
  if (mode === "migrate") {
    const migratable = blockingFindings.filter(
      ({ id, status, actual }) =>
        id === "profile.methodology-version" && status === "drifted" && actual === 0,
    );
    const otherBlockers = blockingFindings.filter((item) => !migratable.includes(item));
    if (migratable.length > 0 && otherBlockers.length === 0) {
      blockingFindings = [];
      migration = "supported";
    } else if (
      blockingFindings.some(
        ({ id }) =>
          id === "profile.methodology-version" ||
          id === "profile.schema-version" ||
          id === "profile.adapter-version" ||
          id.startsWith("selected-profile."),
      )
    ) {
      migration = "unsupported";
    }
  }
  return {
    status: statusForFindings(findings),
    findings,
    blockingFindings,
    migration,
  };
}

function verificationState(mode, commands = []) {
  return {
    status: mode === "verify" ? "planned" : "not-run",
    executed: false,
    commands,
    evidence: [],
  };
}

function verificationCommandKeys(profile) {
  if (profile.commands?.["css:check"]) {
    return ["css:check", "css:verify"];
  }
  return ["css:generate", "css:types", "css:verify"];
}

function integrationSteps(plan) {
  const steps = [];
  if (plan.dependencies?.length) {
    steps.push(
      "Install the printed CSS-harness dependencies with the selected package manager: " +
        plan.dependencies.join(", "),
    );
  }
  if (plan.commands?.length) {
    steps.push(...plan.commands.map(({ id, command }) => "Run " + id + ": " + command));
  }
  for (const item of plan.compatibility?.findings ?? []) {
    if (item.status === "not-verifiable" && item.verifyCommand) {
      steps.push("Resolve " + item.id + " with: " + item.verifyCommand);
    }
  }
  if (plan.mode === "verify") {
    steps.push("This command only plans verification; no commands were executed by setup.mjs.");
  }
  return [...new Set(steps)];
}

async function readTemplate(name) {
  return readFile(path.join(TEMPLATE_ROOT, name), "utf8");
}

// The harness assets and version contract install with every profile, even
// with checks off: the profile's $schema points into assets/ for editors.
async function harnessAssetFiles() {
  const files = [
    {
      path: `${HARNESS_ROOT_PATH}/versions.json`,
      source: "versions.json",
      content: await readFile(path.join(SKILL_ROOT, "versions.json"), "utf8"),
    },
  ];
  for (const name of [
    "css-modules.compact.schema.json",
    "css-modules.presets.json",
    "css-modules.schema.json",
  ]) {
    files.push({
      path: `${HARNESS_ROOT_PATH}/assets/${name}`,
      source: `assets/${name}`,
      content: await readFile(path.join(ASSET_ROOT, name), "utf8"),
    });
  }
  return files;
}

async function bundledCheckerFiles({ lintEngine = "eslint" } = {}) {
  const files = [];
  const scriptFiles = [
    ...SCRIPT_ROOT_FILES,
    ...(lintEngine === "oxlint" ? OXLINT_SCRIPT_FILES : []),
  ];
  for (const name of scriptFiles) {
    files.push({
      path: `.agents/css-modules-harness/scripts/${name}`,
      source: `scripts/${name}`,
      content: await readFile(path.join(SCRIPT_ROOT, name), "utf8"),
    });
  }
  const harnessFiles = [
    ...BASE_HARNESS_FILES,
    ...(lintEngine === "oxlint" ? OXLINT_HARNESS_FILES : []),
  ];
  for (const name of harnessFiles) {
    files.push({
      path: `.agents/css-modules-harness/harness/${name}`,
      source: `harness/${name}`,
      content: await readFile(path.join(HARNESS_ROOT, name), "utf8"),
    });
  }
  return files;
}

// Skill-owned files that the selected configuration no longer uses: schema
// copies beside the profile, and Oxlint adapter files once the project uses
// ESLint. Only migrate removes them.
async function obsoleteFiles(root, { enforcement, lintEngine }) {
  const candidates = PROFILE_SCHEMA_COPIES.map(({ path: copyPath, id }) => ({
    path: copyPath,
    kind: "schema-copy",
    id,
  }));
  if (enforcement && lintEngine !== "oxlint") {
    candidates.push(
      ...OXLINT_SCRIPT_FILES.map((name) => ({
        path: `${HARNESS_ROOT_PATH}/scripts/${name}`,
        kind: "harness",
      })),
      ...OXLINT_HARNESS_FILES.map((name) => ({
        path: `${HARNESS_ROOT_PATH}/harness/${name}`,
        kind: "harness",
      })),
    );
  }
  const found = [];
  for (const candidate of candidates) {
    const target = resolveInside(root, candidate.path);
    if (await exists(target)) found.push({ ...candidate, before: await readFile(target, "utf8") });
  }
  return found;
}

function isBundledSchemaCopy(content, id) {
  try {
    return JSON.parse(content).$id === id;
  } catch {
    return false;
  }
}

// Rewrite a $schema that an earlier setup pointed at a copy beside the profile.
// Any other value is the project's choice and stays as authored.
function schemaRefFor(profile, { force = false } = {}) {
  const ref = isCompactInput(profile) ? COMPACT_SCHEMA_REF : LEGACY_SCHEMA_REF;
  if (force || PROFILE_SCHEMA_COPIES.some(({ id }) => id === profile.$schema)) {
    return { ...profile, $schema: ref };
  }
  return profile;
}

function render(template, variables, templateName) {
  const rendered = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (placeholder, key) => {
    if (!(key in variables)) {
      throw new Error(`${templateName} requires ${key}`);
    }
    return variables[key];
  });

  const unresolved = rendered.match(/\{\{[A-Z0-9_]+\}\}/g);
  if (unresolved) {
    throw new Error(`${templateName} has unresolved placeholders: ${unresolved.join(", ")}`);
  }

  return rendered;
}

function importSpecifier(fromFile, toFile) {
  let relative = path.relative(path.dirname(fromFile), toFile).split(path.sep).join("/");
  if (!relative.startsWith(".")) {
    relative = `./${relative}`;
  }
  return relative;
}

async function colorInputs(profile, inputs) {
  if (!profile.colorTokens.enabled) {
    return { required: [], errors: [], files: [], imports: "", colorScheme: "" };
  }

  const required = [];
  const errors = [];
  const files = [];
  const palette = inputs.paletteFiles ?? {};
  const semantic = inputs.semanticFiles ?? {};
  const paletteTemplate = await readTemplate("palette.css.template");
  const semanticTemplate = await readTemplate("colors.css.template");

  const renderTokens = (filePath, tokens, template, templateName, placeholder, inputKey) => {
    if (typeof tokens !== "string" || tokens.trim().length === 0) {
      required.push(`${inputKey}.${filePath}`);
      return;
    }
    files.push({
      path: filePath,
      content: render(template, { [placeholder]: tokens.trim() }, templateName),
    });
  };

  for (const filePath of profile.colorTokens.paletteFiles) {
    renderTokens(
      filePath,
      palette[filePath],
      paletteTemplate,
      "palette.css.template",
      "PALETTE_TOKENS",
      "paletteFiles",
    );
  }
  for (const filePath of profile.colorTokens.semanticFiles) {
    renderTokens(
      filePath,
      semantic[filePath],
      semanticTemplate,
      "colors.css.template",
      "SEMANTIC_COLOR_TOKENS",
      "semanticFiles",
    );
  }
  if (!profile.layers.order.includes(inputs.colorLayer)) {
    required.push("colorLayer");
  }

  if (required.length > 0) {
    return { required, errors, files: [], imports: "", colorScheme: "" };
  }

  const globalPath = profile.globalStylesheet;
  const imports = [...profile.colorTokens.paletteFiles, ...profile.colorTokens.semanticFiles]
    .map(
      (filePath) =>
        `@import "${importSpecifier(globalPath, filePath)}" layer(${inputs.colorLayer});`,
    )
    .join("\n");
  const attribute = profile.colorTokens.themeAttribute;
  const modeMapping = {
    light: "light",
    dark: "dark",
    system: "light dark",
    ...(profile.colorTokens.modeMapping ?? {}),
  };
  const supportedSchemes = new Set(["light", "dark", "light dark"]);
  const explicitModes = profile.colorTokens.modes.filter((mode) => mode !== "system");
  for (const mode of profile.colorTokens.modes) {
    if (!/^[A-Za-z0-9_-]+$/.test(mode)) {
      errors.push(`colorTokens.modes.${mode}: mode names must be safe attribute values`);
    }
    if (!supportedSchemes.has(modeMapping[mode])) {
      errors.push(
        `colorTokens.modes.${mode}: unsupported theme mapping; set colorTokens.modeMapping.${mode} to light, dark, or light dark`,
      );
    }
  }
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(attribute)) {
    errors.push(`colorTokens.themeAttribute: ${attribute} is not a supported CSS attribute name`);
  }
  if (errors.length > 0) return { required, errors, files: [], imports: "", colorScheme: "" };
  const modeRules = explicitModes
    .map((mode) => `html[${attribute}="${mode}"] {\n  color-scheme: ${modeMapping[mode]};\n}`)
    .join("\n\n");
  const baseScheme = profile.colorTokens.modes.includes("system")
    ? "light dark"
    : [...new Set(explicitModes.map((mode) => modeMapping[mode]))].includes("light dark") ||
        (explicitModes.some((mode) => modeMapping[mode] === "light") &&
          explicitModes.some((mode) => modeMapping[mode] === "dark"))
      ? "light dark"
      : modeMapping[explicitModes[0]];
  const colorScheme = `@layer ${inputs.colorLayer} {\n  html {\n    color-scheme: ${baseScheme};\n  }\n\n${modeRules
    .split("\n")
    .map((line) => (line ? `  ${line}` : line))
    .join("\n")}\n}`;

  return { required, errors, files, imports, colorScheme };
}

function validateTemplateInputs(profile, inputs) {
  const errors = [];
  if (inputs === null || typeof inputs !== "object" || Array.isArray(inputs)) {
    return ["$: template inputs must be a JSON object"];
  }
  const allowedKeys = new Set(["sharedModules", "paletteFiles", "semanticFiles", "colorLayer"]);
  for (const key of Object.keys(inputs)) {
    if (!allowedKeys.has(key)) errors.push(`${key}: unsupported template input`);
  }
  if (inputs.sharedModules !== undefined) {
    if (
      inputs.sharedModules === null ||
      typeof inputs.sharedModules !== "object" ||
      Array.isArray(inputs.sharedModules)
    ) {
      errors.push("sharedModules: must be an object keyed by shared module name");
    } else {
      const knownModules = new Set(profile.sharedApi.modules.map(({ name }) => name));
      for (const [name, value] of Object.entries(inputs.sharedModules)) {
        if (!knownModules.has(name)) errors.push(`sharedModules.${name}: unknown shared module`);
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          errors.push(`sharedModules.${name}: must be an object`);
          continue;
        }
        if (
          value.className !== undefined &&
          (typeof value.className !== "string" ||
            !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(value.className))
        ) {
          errors.push(`sharedModules.${name}.className: must be one CSS class identifier`);
        }
        if (value.declarations !== undefined && typeof value.declarations !== "string") {
          errors.push(`sharedModules.${name}.declarations: must be a string`);
        }
      }
    }
  }
  if (inputs.paletteFiles !== undefined) {
    if (
      inputs.paletteFiles === null ||
      typeof inputs.paletteFiles !== "object" ||
      Array.isArray(inputs.paletteFiles)
    ) {
      errors.push("paletteFiles: must be an object keyed by profile file path");
    } else {
      const knownFiles = new Set(profile.colorTokens.paletteFiles ?? []);
      for (const filePath of Object.keys(inputs.paletteFiles)) {
        if (!knownFiles.has(filePath))
          errors.push(`paletteFiles.${filePath}: unknown profile file path`);
      }
    }
  }
  if (inputs.semanticFiles !== undefined) {
    if (
      inputs.semanticFiles === null ||
      typeof inputs.semanticFiles !== "object" ||
      Array.isArray(inputs.semanticFiles)
    ) {
      errors.push("semanticFiles: must be an object keyed by profile file path");
    } else {
      const knownFiles = new Set(profile.colorTokens.semanticFiles ?? []);
      for (const filePath of Object.keys(inputs.semanticFiles)) {
        if (!knownFiles.has(filePath))
          errors.push(`semanticFiles.${filePath}: unknown profile file path`);
      }
    }
  }
  if (inputs.colorLayer !== undefined && typeof inputs.colorLayer !== "string") {
    errors.push("colorLayer: must be a layer name string");
  }
  return errors;
}

function validateRenderedCss(files) {
  const errors = [];
  for (const file of files.filter(({ path: filePath }) => filePath.endsWith(".css"))) {
    if (file.content.includes("{{")) {
      errors.push(`${file.path}: rendered CSS contains an unresolved placeholder`);
      continue;
    }
    try {
      const root = postcss.parse(file.content, { from: file.path });
      root.walkDecls((declaration) => {
        if (declaration.value.trim().length === 0) {
          errors.push(`${file.path}: empty declaration at input ${file.source ?? file.path}`);
        }
      });
    } catch (error) {
      errors.push(`${file.path}: invalid rendered CSS (${error.message})`);
    }
  }
  return errors;
}

async function renderBaseline(profile, inputs) {
  const requiredInputs = [];
  const inputErrors = validateTemplateInputs(profile, inputs);
  const files = [];
  const sharedTemplate = await readTemplate("shared.module.css.template");

  for (const module of profile.sharedApi.modules) {
    const moduleInput = inputs.sharedModules?.[module.name];
    if (
      typeof moduleInput?.className !== "string" ||
      moduleInput.className.trim().length === 0 ||
      typeof moduleInput?.declarations !== "string" ||
      moduleInput.declarations.trim().length === 0
    ) {
      requiredInputs.push(`sharedModules.${module.name}`);
      continue;
    }

    files.push({
      path: module.path,
      source: `sharedModules.${module.name}`,
      content: render(
        sharedTemplate,
        {
          SHARED_LAYER: module.layer,
          CLASS_NAME: moduleInput.className.trim(),
          DECLARATIONS: moduleInput.declarations.trim(),
        },
        "shared.module.css.template",
      ),
    });
  }

  const colors = await colorInputs(profile, inputs);
  requiredInputs.push(...colors.required);
  inputErrors.push(...colors.errors);
  if (requiredInputs.length > 0 || inputErrors.length > 0) {
    return {
      requiredInputs: [...new Set(requiredInputs)].sort(),
      errors: [...new Set(inputErrors)],
      files: [],
    };
  }

  files.push(...colors.files);
  const commonVariables = {
    CLASS_HELPER: profile.helpers.classNames,
    CSS_VARIABLE_HELPER: profile.helpers.cssVariables,
  };
  const globalTemplate = await readTemplate("global.css.template");
  files.push({
    path: profile.globalStylesheet,
    source: "globalStylesheet",
    content: render(
      globalTemplate,
      {
        LAYER_ORDER: profile.layers.order.join(", "),
        COLOR_IMPORTS: colors.imports,
        COLOR_SCHEME_BLOCK: colors.colorScheme,
      },
      "global.css.template",
    ),
  });

  const cxTemplate = await readTemplate("cx.ts.template");
  const cssVariablesTemplate = await readTemplate("css-vars.ts.template");
  files.push(
    {
      path: path.join(profile.stylesRoot, "lib", "cx.ts"),
      source: "templates/cx.ts.template",
      content: render(cxTemplate, commonVariables, "cx.ts.template"),
    },
    {
      path: path.join(profile.stylesRoot, "lib", "css-vars.ts"),
      source: "templates/css-vars.ts.template",
      content: render(cssVariablesTemplate, commonVariables, "css-vars.ts.template"),
    },
  );

  const sharedExports = profile.sharedApi.modules
    .filter((module) => module.export)
    .map((module) => {
      const specifier = importSpecifier(profile.sharedApi.entryPoint, module.path);
      return `export { default as ${module.export} } from "${specifier}";`;
    })
    .join("\n");
  const indexTemplate = await readTemplate("index.ts.template");
  const classHelperSpecifier = importSpecifier(
    profile.sharedApi.entryPoint,
    path.join(profile.stylesRoot, "lib", "cx"),
  );
  const cssVariablesHelperSpecifier = importSpecifier(
    profile.sharedApi.entryPoint,
    path.join(profile.stylesRoot, "lib", "css-vars"),
  );
  files.push({
    path: profile.sharedApi.entryPoint,
    source: "templates/index.ts.template",
    content: render(
      indexTemplate,
      {
        ...commonVariables,
        CLASS_HELPER_SPECIFIER: classHelperSpecifier,
        CSS_VARIABLE_HELPER_SPECIFIER: cssVariablesHelperSpecifier,
        SHARED_EXPORTS: sharedExports,
      },
      "index.ts.template",
    ),
  });

  return { requiredInputs: [], errors: validateRenderedCss(files), files };
}

async function classifyDesiredFiles(
  root,
  desiredFiles,
  { allowReplace = false, obsolete = [] } = {},
) {
  const changes = [];
  const preflight = await preflightWriteSet(root, [...desiredFiles, ...obsolete]);
  const conflicts = preflight.errors.map((error) => ({
    path: error.path,
    reason: error.reason,
    sources: error.sources,
  }));
  if (conflicts.length > 0) return { changes, conflicts };

  for (const { migrateOnly, ...desired } of [...desiredFiles].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    const target = resolveInside(root, desired.path);
    if (!(await exists(target))) {
      changes.push({ action: "create", ...desired });
      continue;
    }

    const current = await readFile(target, "utf8");
    if (current !== desired.content) {
      if (allowReplace) {
        changes.push({ action: "replace", ...desired, before: current });
      } else if (migrateOnly) {
        conflicts.push({
          path: desired.path,
          reason: migrateOnly,
          sources: [desired.source ?? desired.path],
        });
      } else {
        conflicts.push({
          path: desired.path,
          reason: "existing file differs; bootstrap and align never overwrite",
          sources: [desired.source ?? desired.path],
        });
      }
    }
  }

  for (const stale of obsolete) {
    if (stale.kind === "schema-copy" && !isBundledSchemaCopy(stale.before, stale.id)) {
      conflicts.push({
        path: stale.path,
        reason:
          "schemas now live only in the harness assets, but this file is not a bundled schema copy",
        sources: [stale.path],
      });
    } else if (allowReplace) {
      changes.push({
        action: "delete",
        path: stale.path,
        source: stale.path,
        before: stale.before,
      });
    } else {
      conflicts.push({
        path: stale.path,
        reason: "obsolete skill-owned file; run migrate --authorize-migrate to remove it",
        sources: [stale.path],
      });
    }
  }

  return { changes, conflicts };
}

export async function planSetup({
  root = process.cwd(),
  mode,
  profileSource,
  inputsPath,
  authorizeMigrate = false,
  targetFormat,
} = {}) {
  if (!MODES.has(mode)) {
    throw new Error(`Mode must be one of: ${[...MODES].join(", ")}`);
  }
  if (mode === "migrate" && !authorizeMigrate) {
    throw new Error("migrate mode requires explicit migration authorization");
  }

  const resolvedRoot = path.resolve(root);
  const audit = await auditProject({ root: resolvedRoot });
  const base = {
    root: resolvedRoot,
    mode,
    audit,
    changes: [],
    conflicts: [],
    requiredInputs: [],
    mutationStatus: "not-planned",
    compatibility: makeCompatibility(audit, [], mode),
    verification: verificationState(mode),
    selection: {
      application: undefined,
      packageManager:
        audit.findings.find(({ id }) => id === "project.package-manager")?.actual ?? undefined,
    },
  };

  if (mode === "audit" || mode === "verify" || mode === "show-config") {
    let commands = [];
    const projectProfile = path.join(resolvedRoot, ".agents", "css-modules.json");
    let resolved;
    if ((mode === "verify" || mode === "show-config") && (await exists(projectProfile))) {
      resolved = await readResolvedContract(resolvedRoot, ".agents/css-modules.json");
      commands = verificationCommandKeys(resolved.profile)
        .filter((key) => resolved.profile.commands?.[key])
        .map((key) => ({ id: key, command: resolved.profile.commands[key] }));
    }
    const verification = verificationState(mode, commands);
    return {
      ...base,
      status: audit.status,
      mutationStatus: "not-applicable",
      commands,
      ...(resolved ? { resolved } : {}),
      verification,
      integrationSteps: integrationSteps({ ...base, commands, verification }),
    };
  }

  let selectedProfilePath;
  if (profileSource) {
    selectedProfilePath = resolveInside(resolvedRoot, profileSource);
  } else {
    selectedProfilePath = path.join(resolvedRoot, ".agents", "css-modules.json");
  }
  if (!(await exists(selectedProfilePath))) {
    throw new Error(`${mode} requires a selected profile`);
  }

  const profileInput = await readJson(selectedProfilePath);
  const profileErrors = validateInput(profileInput, { ignoreVersion: true });
  if (profileErrors.length > 0) {
    const invalidFinding = {
      id: "selected-profile.schema",
      status: "ambiguous",
      detail: "Selected profile is invalid: " + profileErrors.join("; "),
    };
    const compatibility = makeCompatibility(audit, [invalidFinding], mode);
    const plan = {
      ...base,
      status: "blocked",
      mutationStatus: "blocked",
      compatibility,
    };
    plan.integrationSteps = integrationSteps(plan);
    return plan;
  }

  const discoveredFacts = await discoverProjectFacts(resolvedRoot);
  const selectedContract = resolveContract(profileInput, { discoveredFacts });
  const resolvedProfile = selectedContract.profile;
  const selectedFindings = selectedVersionFindings(resolvedProfile, profileInput);
  const driftFindings = selectedContract.drift.map(({ field, explicit, discovered, detail }) => ({
    id: `contract.drift.${field.replaceAll(".", "-")}`,
    status: "drifted",
    detail,
    expected: explicit,
    actual: discovered,
  }));
  const ambiguityFindings = selectedContract.ambiguities.map(({ field, values }) => ({
    id: `contract.ambiguous.${field}`,
    status: "ambiguous",
    detail: `${field} has multiple discovered values; select one explicitly`,
    actual: values,
  }));
  const compatibility = makeCompatibility(
    audit,
    [...selectedFindings, ...driftFindings, ...ambiguityFindings],
    mode,
  );
  let migration;
  if (mode === "migrate" && targetFormat === "compact") {
    if (isCompactInput(profileInput)) {
      migration = {
        status: "already-compact",
        errors: [],
        differences: [],
      };
    } else {
      migration = planLegacyToCompact(profileInput, { discoveredFacts });
    }
  }
  const supportedMigration =
    (mode === "migrate" && compatibility.migration === "supported") ||
    migration?.status === "supported";
  if (migration?.status === "unsupported") {
    const plan = {
      ...base,
      status: "blocked",
      mutationStatus: "blocked",
      profile: profileInput,
      resolvedProfile,
      compatibility,
      migration,
      templateErrors: migration.errors.map(({ field, message }) => `${field}: ${message}`),
    };
    plan.integrationSteps = integrationSteps(plan);
    return plan;
  }
  if (compatibility.blockingFindings.length > 0 && !supportedMigration) {
    const plan = {
      ...base,
      status: "blocked",
      mutationStatus: "blocked",
      profile: profileInput,
      resolvedProfile,
      compatibility,
      selection: {
        application: resolvedProfile.appRoot,
        packageManager:
          audit.findings.find(({ id }) => id === "project.package-manager")?.actual ?? undefined,
      },
    };
    plan.integrationSteps = integrationSteps(plan);
    return plan;
  }

  const targetProfilePath = path.join(resolvedRoot, ".agents", "css-modules.json");
  const readsTargetProfile = path.resolve(selectedProfilePath) === targetProfilePath;
  const storedProfile =
    migration?.candidate ?? schemaRefFor(profileInput, { force: !readsTargetProfile });
  const storedContract = migration?.after ?? selectedContract;
  const storedResolvedProfile = storedContract.profile;
  const lintEngine = storedResolvedProfile.lintEngine ?? "eslint";
  const desiredFiles = [];
  if (migration || !readsTargetProfile || !(await exists(targetProfilePath))) {
    desiredFiles.push({
      path: ".agents/css-modules.json",
      source: selectedProfilePath,
      content: `${JSON.stringify(storedProfile, null, 2)}\n`,
    });
  } else if (storedProfile !== profileInput) {
    desiredFiles.push({
      path: ".agents/css-modules.json",
      source: selectedProfilePath,
      content: `${JSON.stringify(storedProfile, null, 2)}\n`,
      migrateOnly:
        "$schema points at a schema copy beside the profile; run migrate --authorize-migrate to point it at the harness assets",
    });
  }

  if (mode === "bootstrap") {
    const inputs = inputsPath ? await readJson(resolveInside(resolvedRoot, inputsPath)) : {};
    const rendered = await renderBaseline(storedResolvedProfile, inputs);
    if (rendered.errors?.length > 0) {
      const plan = {
        ...base,
        status: "blocked",
        mutationStatus: "blocked",
        profile: storedProfile,
        resolvedProfile: storedResolvedProfile,
        requiredInputs: rendered.requiredInputs,
        templateErrors: rendered.errors,
        compatibility,
        dependencies: [
          ...TEMPLATE_DEPENDENCIES,
          ...(mode === "bootstrap" ? ["vite-css-modules"] : []),
          ...(storedResolvedProfile.enforcement ? enforcementDependencies(lintEngine) : []),
        ],
        commands: Object.entries(storedResolvedProfile.commands ?? {}).map(([id, command]) => ({
          id,
          command,
        })),
      };
      plan.verification = verificationState(mode, plan.commands);
      plan.integrationSteps = integrationSteps(plan);
      return plan;
    }
    if (rendered.requiredInputs.length > 0) {
      const plan = {
        ...base,
        status: "needs-input",
        mutationStatus: "needs-input",
        profile: storedProfile,
        resolvedProfile: storedResolvedProfile,
        requiredInputs: rendered.requiredInputs,
        compatibility,
        dependencies: [
          ...TEMPLATE_DEPENDENCIES,
          ...(mode === "bootstrap" ? ["vite-css-modules"] : []),
          ...(storedResolvedProfile.enforcement ? enforcementDependencies(lintEngine) : []),
        ],
        commands: Object.entries(storedResolvedProfile.commands ?? {}).map(([id, command]) => ({
          id,
          command,
        })),
      };
      plan.verification = verificationState(mode, plan.commands);
      plan.integrationSteps = integrationSteps(plan);
      return plan;
    }
    desiredFiles.push(...rendered.files);
  }

  desiredFiles.push(...(await harnessAssetFiles()));
  if (storedResolvedProfile.enforcement) {
    desiredFiles.push(...(await bundledCheckerFiles({ lintEngine })));
  }

  const obsolete = await obsoleteFiles(resolvedRoot, {
    enforcement: Boolean(storedResolvedProfile.enforcement),
    lintEngine,
  });
  const { changes, conflicts } = await classifyDesiredFiles(resolvedRoot, desiredFiles, {
    allowReplace: mode === "migrate",
    obsolete,
  });
  const plan = {
    ...base,
    status: conflicts.length > 0 ? "conflict" : changes.length > 0 ? "ready" : "aligned",
    mutationStatus: conflicts.length > 0 ? "conflict" : changes.length > 0 ? "ready" : "aligned",
    profile: storedProfile,
    resolvedProfile: storedResolvedProfile,
    changes,
    conflicts,
    compatibility,
    selection: {
      application: storedResolvedProfile.appRoot,
      packageManager:
        audit.findings.find(({ id }) => id === "project.package-manager")?.actual ?? undefined,
    },
    dependencies: [
      ...(mode === "bootstrap" ? TEMPLATE_DEPENDENCIES : []),
      ...(mode === "bootstrap" ? ["vite-css-modules"] : []),
      ...(storedResolvedProfile.enforcement ? enforcementDependencies(lintEngine) : []),
    ],
    commands: Object.entries(storedResolvedProfile.commands ?? {}).map(([id, command]) => ({
      id,
      command,
    })),
    ...(migration ? { migration } : {}),
  };
  plan.verification = verificationState(mode, plan.commands);
  plan.integrationSteps = integrationSteps(plan);
  return plan;
}

export async function applySetupPlan(plan) {
  if (!["bootstrap", "align", "migrate"].includes(plan.mode)) {
    throw new Error(`${plan.mode} mode never writes`);
  }
  if (plan.compatibility?.blockingFindings?.length > 0) {
    const error = new Error("Setup plan has blocking compatibility findings and cannot be applied");
    error.code = plan.compatibility.status === "ambiguous" ? "INVALID" : "INCOMPATIBLE";
    throw error;
  }
  if (plan.conflicts.length > 0) {
    throw new Error("Setup plan has conflicts and cannot be applied");
  }
  if (plan.requiredInputs.length > 0) {
    throw new Error("Setup plan requires developer input and cannot be applied");
  }

  const preflight = await preflightWriteSet(plan.root, plan.changes);
  if (preflight.errors.length > 0) {
    const error = new Error(
      "Setup plan has an invalid write set: " +
        preflight.errors
          .map(
            ({ path: filePath, reason, sources }) =>
              `${filePath} (${reason}; sources: ${sources.join(", ")})`,
          )
          .join("; "),
    );
    error.touched = [];
    throw error;
  }

  // Recheck every expected preimage before the first mutation. Per-file checks
  // below still protect the exclusive/touched-file behavior if the filesystem
  // changes during the mutation loop.
  for (const change of plan.changes) {
    const target = resolveInside(plan.root, change.path);
    if (change.action === "create" && (await exists(target))) {
      const error = new Error(`Refusing to overwrite ${change.path}`);
      error.touched = [];
      throw error;
    }
    if (
      (change.action === "replace" || change.action === "delete") &&
      (!(await exists(target)) || (await readFile(target, "utf8")) !== change.before)
    ) {
      const error = new Error(`Refusing to ${change.action} changed file ${change.path}`);
      error.touched = [];
      throw error;
    }
  }

  const touched = [];
  try {
    for (const change of plan.changes) {
      if (!new Set(["create", "replace", "delete"]).has(change.action)) {
        throw new Error(`Unsupported mutation: ${change.action}`);
      }
      const target = resolveInside(plan.root, change.path);
      if (change.action === "create") {
        if (await exists(target)) {
          throw new Error(`Refusing to overwrite ${change.path}`);
        }
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, change.content, { flag: "wx" });
      } else if (change.action === "delete") {
        if (!(await exists(target)) || (await readFile(target, "utf8")) !== change.before) {
          throw new Error(`Refusing to delete changed file ${change.path}`);
        }
        await rm(target);
      } else {
        if (!(await exists(target)) || (await readFile(target, "utf8")) !== change.before) {
          throw new Error(`Refusing to replace changed file ${change.path}`);
        }
        await writeFile(target, change.content);
      }
      touched.push(change.path);
    }
  } catch (error) {
    error.touched = touched;
    throw error;
  }

  return { status: "applied", touched };
}

export function formatPlan(plan) {
  const lines = [
    `CSS Modules setup: ${plan.mode}`,
    `Target: ${plan.root}`,
    `Status: ${plan.status}`,
    "",
  ];
  const compatibility = plan.compatibility ?? {
    status: plan.audit?.status ?? "not-verifiable",
    findings: plan.audit?.findings ?? [],
    blockingFindings: plan.audit?.blockingFindings ?? [],
  };
  lines.push("Mutation: " + (plan.mutationStatus ?? plan.status));
  lines.push("Compatibility: " + compatibility.status);
  lines.push("Compatibility blockers: " + (compatibility.blockingFindings?.length ?? 0));
  if (plan.selection?.application !== undefined) {
    lines.push("Selected application: " + plan.selection.application);
  }
  if (plan.selection?.packageManager !== undefined) {
    lines.push("Selected package manager: " + plan.selection.packageManager);
  }
  if (plan.resolvedProfile) {
    lines.push(
      "Resolved format: " +
        (plan.migration?.status === "supported" ? "compact candidate" : "in-memory contract"),
    );
  }
  if (compatibility.migration && compatibility.migration !== "not-requested") {
    lines.push("Migration: " + compatibility.migration);
  }
  if (plan.migration?.status) {
    lines.push("Format migration: " + plan.migration.status);
    for (const error of plan.migration.errors ?? []) {
      lines.push(`  ${error.field}: ${error.message}`);
    }
  }
  lines.push("");
  for (const change of plan.changes) {
    lines.push(`${change.action.toUpperCase().padEnd(7)} ${change.path}`);
  }
  for (const change of plan.changes.filter(({ action }) => action === "replace")) {
    lines.push("  BEFORE " + change.path);
    lines.push(change.before);
    lines.push("  AFTER  " + change.path);
    lines.push(change.content);
  }
  for (const change of plan.changes.filter(({ action }) => action === "delete")) {
    lines.push("  REMOVED " + change.path);
    lines.push(change.before);
  }
  for (const conflict of plan.conflicts) {
    lines.push(
      `CONFLICT ${conflict.path}: ${conflict.reason}` +
        (conflict.sources?.length ? ` [sources: ${conflict.sources.join(", ")}]` : ""),
    );
  }
  for (const input of plan.requiredInputs) {
    lines.push(`INPUT   ${input}`);
  }
  for (const error of plan.templateErrors ?? []) {
    lines.push(`INPUT   ${error}`);
  }
  if (plan.dependencies?.length) {
    lines.push("", "Dependencies:");
    lines.push(...plan.dependencies.map((dependency) => "  " + dependency));
  }
  if (plan.commands?.length) {
    lines.push("", "Commands (planned, not executed):");
    lines.push(...plan.commands.map(({ id, command }) => "  " + id + ": " + command));
  }
  if (compatibility.findings?.some(({ status }) => status !== "aligned")) {
    lines.push("", "Unresolved findings:");
    for (const item of compatibility.findings.filter(({ status }) => status !== "aligned")) {
      lines.push("  " + item.status.toUpperCase() + " " + item.id + ": " + item.detail);
      if (item.verifyCommand) lines.push("    follow-up: " + item.verifyCommand);
    }
  }
  if (plan.verification) {
    lines.push(
      "",
      "Verification: " +
        plan.verification.status +
        (plan.verification.executed ? " (executed)" : " (not executed)"),
    );
  }
  if (plan.integrationSteps?.length) {
    lines.push("", "Outstanding integration steps:");
    lines.push(...plan.integrationSteps.map((step) => "  " + step));
  }
  if (
    plan.changes.length === 0 &&
    plan.conflicts.length === 0 &&
    plan.requiredInputs.length === 0
  ) {
    lines.push("No mutations planned.");
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const [first, ...rest] = argv;
  const help = first === "--help" || first === "-h";
  const options = {
    mode: help ? undefined : first,
    help,
    root: process.cwd(),
    format: "human",
    apply: false,
    check: false,
  };

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--root") options.root = rest[++index];
    else if (argument === "--profile-source") options.profileSource = rest[++index];
    else if (argument === "--inputs") options.inputsPath = rest[++index];
    else if (argument === "--format") options.format = rest[++index];
    else if (argument === "--apply") options.apply = true;
    else if (argument === "--check") options.check = true;
    else if (argument === "--authorize-migrate") options.authorizeMigrate = true;
    else if (argument === "--to") options.targetFormat = rest[++index];
    else if (argument === "--compact") options.targetFormat = "compact";
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }

  if (!["human", "json"].includes(options.format)) throw new Error("format must be human or json");
  if (options.targetFormat && !["legacy", "compact"].includes(options.targetFormat)) {
    throw new Error("--to must be legacy or compact");
  }
  return options;
}

function usage() {
  return [
    "Usage: node setup.mjs <audit|bootstrap|align|migrate|verify|show-config> [options]",
    "",
    "Plans are read-only by default. --apply is valid only for bootstrap, align, and migrate.",
    "--profile-source <path>  selected profile for bootstrap or migration",
    "--inputs <path>          explicit template inputs for bootstrap",
    "--authorize-migrate      confirm that migrate was explicitly requested",
    "--to <legacy|compact>    explicit migration destination format",
    "--compact                shorthand for --to compact",
    "show-config              print the read-only resolved contract",
    "--format <human|json>    output format",
    "--apply                  apply creates; explicit migrate may replace selected files",
    "--check                  return audit-style status codes for actionable findings",
  ].join("\n");
}

function exitCodeForPlan(plan, check) {
  if (["conflict", "needs-input", "blocked"].includes(plan.status) && plan.templateErrors?.length)
    return 2;
  if (["conflict", "needs-input"].includes(plan.status)) return 2;
  if (plan.status === "blocked") return plan.compatibility?.status === "ambiguous" ? 2 : 1;
  if (!check) return 0;
  if (plan.audit?.status === "ambiguous") return 2;
  if (["missing", "drifted"].includes(plan.audit?.status)) return 1;
  return 0;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help || !options.mode) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    if (options.apply && ["audit", "verify", "show-config"].includes(options.mode)) {
      throw new Error(`${options.mode} mode never accepts --apply`);
    }

    const plan = await planSetup(options);
    if (options.mode === "show-config" && plan.resolved) {
      process.stdout.write(
        options.format === "json"
          ? `${JSON.stringify(resolvedOutput(plan.resolved), null, 2)}\n`
          : `${formatResolvedContract(plan.resolved)}\n`,
      );
    } else {
      process.stdout.write(
        options.format === "json" ? `${JSON.stringify(plan, null, 2)}\n` : `${formatPlan(plan)}\n`,
      );
    }
    if (options.apply) {
      const result = await applySetupPlan(plan);
      process.stdout.write(`Applied ${result.touched.length} file(s).\n`);
    }
    process.exitCode = exitCodeForPlan(plan, options.check);
  } catch (error) {
    process.stderr.write(`Setup failed: ${error.message}\n`);
    if (error.touched?.length) {
      process.stderr.write(`Touched before failure: ${error.touched.join(", ")}\n`);
    }
    process.exitCode = error.code === "INCOMPATIBLE" ? 1 : 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
