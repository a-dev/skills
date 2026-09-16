#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";
import stylelint from "stylelint";

import stylelintPlugins, { stylelintRuleIds } from "../harness/stylelint-plugin.mjs";
import { colorValuePositions } from "./color-analysis.mjs";
import {
  escapeRegExp,
  exists,
  exitCodeForFindings,
  finalizeFindings,
  formatFindingsReport,
  resolveInside,
  selectSeverity,
  walk,
} from "./lib.mjs";
import { readResolvedContract, resolveLayerOwner, tsxRuleSettings } from "./contract.mjs";

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".mts", ".cjs", ".cts"]);

function finding({ engine, ruleId, file, line = 1, column = 1, message, severity }) {
  return { engine, ruleId, file, line, column, message, severity };
}

async function paletteTokens(root, profile) {
  const tokens = new Set();
  if (!profile.colorTokens.enabled) return tokens;
  for (const file of profile.colorTokens.paletteFiles) {
    const target = resolveInside(root, file);
    if (!(await exists(target))) continue;
    const css = postcss.parse(await readFile(target, "utf8"), { from: target });
    css.walkDecls((declaration) => {
      if (declaration.prop.startsWith("--")) tokens.add(declaration.prop);
    });
  }
  return tokens;
}

function layerOwners(profile, relativeFile) {
  return resolveLayerOwner(profile, relativeFile).matches;
}

// Returns the layer the file must declare, null when it must stay unlayered, or
// undefined when the profile does not decide. More than one matching ownership
// glob is ambiguous, not a fallback: css-modules/layer-ownership-ambiguous
// reports it rather than this rule guessing a layer.
function expectedLayer(profile, relativeFile) {
  const owner = resolveLayerOwner(profile, relativeFile);
  return owner.status === "resolved" ? owner.layer : undefined;
}

// ESLint, its Babel parser, and oxc-parser are optional per engine, so they are
// imported only when the selected lintEngine needs them.
async function runEslint(root, profile, severity) {
  const sourceFiles = await walk(
    resolveInside(root, profile.appRoot),
    (file) => SOURCE_EXTENSIONS.has(path.extname(file)) && !file.endsWith(".d.ts"),
  );
  if (sourceFiles.length === 0) return [];
  const [{ ESLint }, { default: babelParser }, { default: eslintPlugin, eslintRuleIds }] =
    await Promise.all([
      import("eslint"),
      import("@babel/eslint-parser"),
      import("../harness/eslint-plugin.mjs"),
    ]);
  const ruleSeverity = severity === "error" ? 2 : 1;
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.{js,jsx,ts,tsx,mjs,mts,cjs,cts}"],
        languageOptions: {
          parser: babelParser,
          parserOptions: {
            requireConfigFile: false,
            babelOptions: { parserOpts: { plugins: ["jsx", "typescript"] } },
          },
        },
        plugins: { "css-modules": eslintPlugin },
        rules: Object.fromEntries(eslintRuleIds.map((id) => [`css-modules/${id}`, ruleSeverity])),
        settings: { cssModules: tsxRuleSettings(profile) },
      },
    ],
  });
  const results = await eslint.lintFiles(sourceFiles);
  return results.flatMap((result) =>
    result.messages.map((message) =>
      finding({
        engine: "eslint",
        ruleId: message.ruleId ?? "eslint/parse-error",
        file: path.relative(root, result.filePath).split(path.sep).join("/"),
        line: message.line,
        column: message.column,
        message: message.message,
        severity: message.severity === 2 ? "error" : "warning",
      }),
    ),
  );
}

async function runTsxRules(root, profile, severity) {
  if (profile.lintEngine === "oxlint") {
    const { runOxlint } = await import("./check-oxlint.mjs");
    return runOxlint(root, profile, severity);
  }
  return runEslint(root, profile, severity);
}

// Returns parse(code, filePath) -> ESTree Program for the export analysis.
async function loadModuleParser(lintEngine) {
  if (lintEngine === "oxlint") {
    const { parseSync } = await import("oxc-parser");
    return (code, filePath) => {
      const result = parseSync(filePath, code, { sourceType: "module" });
      if (result.errors.length > 0) throw new Error(result.errors[0].message);
      return result.program;
    };
  }
  const { default: babelParser } = await import("@babel/eslint-parser");
  return (code, filePath) =>
    babelParser.parseForESLint(code, {
      filePath,
      requireConfigFile: false,
      babelOptions: { parserOpts: { plugins: ["typescript", "jsx"] } },
    }).ast;
}

async function runStylelint(root, profile, severity, palette) {
  const cssFiles = await walk(resolveInside(root, profile.appRoot), (file) =>
    file.endsWith(".module.css"),
  );
  const findings = [];
  for (const file of cssFiles) {
    const relativeFile = path.relative(root, file).split(path.sep).join("/");
    const options = {
      severity,
      paletteTokens: [...palette],
      colorContractEnabled: profile.colorTokens.enabled,
      themeAttribute: profile.colorTokens.enabled ? profile.colorTokens.themeAttribute : null,
      themeOwner: profile.colorTokens.enabled ? profile.colorTokens.themeOwner : null,
      expectedLayer: expectedLayer(profile, relativeFile),
      privateBooleanAttributes: profile.enforcement?.privateBooleanAttributes ?? ["data-loading"],
    };
    const result = await stylelint.lint({
      code: await readFile(file, "utf8"),
      codeFilename: file,
      config: {
        plugins: stylelintPlugins,
        rules: Object.fromEntries(stylelintRuleIds.map((id) => [id, [true, options]])),
      },
    });
    for (const warning of result.results[0]?.warnings ?? []) {
      findings.push(
        finding({
          engine: "stylelint",
          ruleId: warning.rule,
          file: relativeFile,
          line: warning.line,
          column: warning.column,
          message: warning.text.replace(new RegExp(`\\s+\\(${escapeRegExp(warning.rule)}\\)$`), ""),
          severity: warning.severity,
        }),
      );
    }
  }
  return findings;
}

function sourcePosition(node) {
  return { line: node?.source?.start?.line ?? 1, column: node?.source?.start?.column ?? 1 };
}

async function semanticDefinitions(root, profile) {
  const definitions = new Set();
  if (!profile.colorTokens.enabled) return definitions;
  for (const file of profile.colorTokens.semanticFiles) {
    const target = resolveInside(root, file);
    if (!(await exists(target))) continue;
    const css = postcss.parse(await readFile(target, "utf8"), { from: target });
    css.walkDecls((declaration) => {
      if (declaration.prop.startsWith("--")) definitions.add(declaration.prop);
    });
  }
  return definitions;
}

function classDefinitions(css) {
  const classes = new Set();
  css.walkRules((rule) => {
    try {
      selectorParser((selectors) =>
        selectors.walkClasses((node) => classes.add(node.value)),
      ).processSync(rule.selector);
    } catch {
      // Stylelint reports malformed selectors.
    }
  });
  return classes;
}

function resolveComposesSpecifier(profile, specifier) {
  if (specifier === profile.alias.bare) return profile.sharedApi.entryPoint;
  const prefix = `${profile.alias.bare}/`;
  return specifier.startsWith(prefix)
    ? path.join(profile.stylesRoot, specifier.slice(prefix.length))
    : null;
}

const RE_EXPORT_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cjs", ".cts"];

async function resolveReExport(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const target = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    target,
    ...RE_EXPORT_EXTENSIONS.map((extension) => `${target}${extension}`),
    ...RE_EXPORT_EXTENSIONS.map((extension) => path.join(target, `index${extension}`)),
  ];
  for (const candidate of candidates) {
    if (path.extname(candidate) && (await exists(candidate))) return candidate;
  }
  return null;
}

const CSS_EXPORT = (modulePath) => ({ kind: "css-module", modulePath });
const TYPE_ONLY_EXPORT = { kind: "type-only" };
const WRONG_EXPORT = (description) => ({ kind: "wrong", description });
const UNKNOWN_EXPORT = (reason) => ({ kind: "unknown", reason });
const MISSING_EXPORT = { kind: "missing" };

function isTypeOnly(node) {
  return node?.exportKind === "type" || node?.importKind === "type";
}

function literalExportState(node) {
  if (
    node?.type === "NumericLiteral" ||
    node?.type === "StringLiteral" ||
    node?.type === "BooleanLiteral" ||
    node?.type === "NullLiteral" ||
    node?.type === "RegExpLiteral" ||
    (node?.type === "Literal" && node.value !== undefined)
  ) {
    const typeName =
      node.type === "NumericLiteral" || node.type === "Literal"
        ? typeof node.value
        : node.type.replace("Literal", "").toLowerCase();
    return WRONG_EXPORT(`a ${typeName} value`);
  }
  return null;
}

function unwrapExportExpression(node) {
  if (
    node?.type === "TSAsExpression" ||
    node?.type === "TSTypeAssertion" ||
    node?.type === "TSNonNullExpression" ||
    node?.type === "TypeCastExpression"
  ) {
    return node.expression;
  }
  return node;
}

async function analyzeExportBindings(filePath, parse, memo = new Map(), visiting = new Set()) {
  const resolved = path.resolve(filePath);
  if (memo.has(resolved)) return memo.get(resolved);
  if (visiting.has(resolved)) {
    return { complete: false, bindings: new Map(), reason: "cyclic export barrel" };
  }
  if (!(await exists(resolved))) {
    const missing = { complete: true, bindings: new Map(), reason: "missing export source" };
    memo.set(resolved, missing);
    return missing;
  }

  visiting.add(resolved);
  let program;
  try {
    program = parse(await readFile(resolved, "utf8"), resolved);
  } catch {
    visiting.delete(resolved);
    const unparsed = { complete: false, bindings: new Map(), reason: "unparseable export source" };
    memo.set(resolved, unparsed);
    return unparsed;
  }

  const bindings = new Map();
  const localBindings = new Map();
  let complete = true;
  let reason;

  async function sourceBindings(statement, importedName) {
    const specifier = statement.source?.value;
    if (typeof specifier !== "string" || !specifier.startsWith(".")) {
      complete = false;
      reason = "external or unresolved export source";
      return UNKNOWN_EXPORT(reason);
    }
    const target = await resolveReExport(resolved, specifier);
    if (!target) {
      complete = false;
      reason = `unresolved relative export source ${specifier}`;
      return UNKNOWN_EXPORT(reason);
    }
    if (target.endsWith(".module.css")) {
      if (importedName === "default") return CSS_EXPORT(target);
      return WRONG_EXPORT(`named export ${importedName} from ${specifier}`);
    }
    const result = await analyzeExportBindings(target, parse, memo, visiting);
    if (!result.complete) {
      complete = false;
      reason = result.reason;
    }
    return (
      result.bindings.get(importedName) ??
      (result.complete ? MISSING_EXPORT : UNKNOWN_EXPORT(reason))
    );
  }

  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration") {
      for (const specifier of statement.specifiers) {
        const localName = specifier.local?.name;
        if (!localName) continue;
        if (isTypeOnly(statement) || isTypeOnly(specifier)) {
          localBindings.set(localName, TYPE_ONLY_EXPORT);
          continue;
        }
        if (!statement.source.value.startsWith(".")) {
          localBindings.set(localName, UNKNOWN_EXPORT("external import"));
          complete = false;
          reason = "external import";
          continue;
        }
        if (specifier.type === "ImportNamespaceSpecifier") {
          localBindings.set(localName, UNKNOWN_EXPORT("namespace import"));
          complete = false;
          reason = "namespace import provenance is not tracked";
          continue;
        }
        const imported = importedNameOfSpecifier(specifier);
        localBindings.set(localName, await sourceBindings(statement, imported));
      }
      continue;
    }

    if (statement.type === "VariableDeclaration") {
      for (const item of statement.declarations) {
        if (item.id.type !== "Identifier") continue;
        const literal = literalExportState(unwrapExportExpression(item.init));
        const state = literal ?? inferExportExpression(item.init, localBindings);
        localBindings.set(item.id.name, state);
        if (state.kind === "unknown") {
          complete = false;
          reason = state.reason;
        }
      }
      continue;
    }

    if (statement.type === "ExportAllDeclaration") {
      if (isTypeOnly(statement)) {
        complete = false;
        reason = "type-only star export";
        continue;
      }
      if (statement.exported) {
        // `export * as ns` is a namespace object, not the default CSS module.
        bindings.set(
          statement.exported.name ?? statement.exported.value,
          UNKNOWN_EXPORT("namespace export"),
        );
      } else {
        const target = await resolveReExport(resolved, statement.source.value);
        if (!target || target.endsWith(".module.css")) {
          complete = false;
          reason = target
            ? "CSS module star export has no tracked named bindings"
            : "unresolved star export";
          continue;
        }
        const result = await analyzeExportBindings(target, parse, memo, visiting);
        if (!result.complete) {
          complete = false;
          reason = result.reason;
        }
        for (const [name, state] of result.bindings) {
          if (name === "default") continue;
          if (bindings.has(name)) {
            bindings.set(name, UNKNOWN_EXPORT(`ambiguous star export ${name}`));
            complete = false;
            reason = `ambiguous star export ${name}`;
          } else {
            bindings.set(name, state);
          }
        }
      }
      continue;
    }

    if (statement.type !== "ExportNamedDeclaration") continue;
    const declaration = statement.declaration;
    if (declaration) {
      if (declaration.type === "VariableDeclaration") {
        for (const item of declaration.declarations) {
          if (item.id.type !== "Identifier") continue;
          const literal = literalExportState(unwrapExportExpression(item.init));
          const state = literal ?? inferExportExpression(item.init, localBindings);
          localBindings.set(item.id.name, state);
          if (state.kind === "unknown") {
            complete = false;
            reason = state.reason;
          }
        }
      } else if (declaration.id?.type === "Identifier") {
        localBindings.set(
          declaration.id.name,
          declaration.type.startsWith("TS")
            ? TYPE_ONLY_EXPORT
            : WRONG_EXPORT("a function or class"),
        );
      } else if (declaration.type.startsWith("TS")) {
        complete = complete;
      }
    }

    for (const specifier of statement.specifiers) {
      const exportedName = specifier.exported?.name ?? specifier.exported?.value;
      if (!exportedName) continue;
      if (isTypeOnly(statement) || isTypeOnly(specifier)) {
        bindings.set(exportedName, TYPE_ONLY_EXPORT);
        continue;
      }
      if (statement.source) {
        bindings.set(
          exportedName,
          await sourceBindings(statement, importedNameOfSpecifier(specifier)),
        );
      } else {
        const localName = specifier.local?.name ?? specifier.local?.value;
        const state = localBindings.get(localName);
        if (state) bindings.set(exportedName, state);
        else {
          bindings.set(exportedName, UNKNOWN_EXPORT(`unresolved local export ${localName}`));
          complete = false;
          reason = `unresolved local export ${localName}`;
        }
      }
    }

    if (declaration?.type === "VariableDeclaration") {
      for (const item of declaration.declarations) {
        if (item.id.type === "Identifier")
          bindings.set(item.id.name, localBindings.get(item.id.name));
      }
    } else if (declaration?.id?.type === "Identifier") {
      bindings.set(declaration.id.name, localBindings.get(declaration.id.name));
    }
  }

  visiting.delete(resolved);
  const result = { complete, bindings, reason };
  memo.set(resolved, result);
  return result;
}

function importedNameOfSpecifier(specifier) {
  if (specifier.type === "ImportDefaultSpecifier") return "default";
  return (
    specifier.imported?.name ??
    specifier.imported?.value ??
    specifier.local?.name ??
    specifier.local?.value ??
    "default"
  );
}

function inferExportExpression(node, bindings) {
  const expression = unwrapExportExpression(node);
  if (!expression) return UNKNOWN_EXPORT("export has no initializer");
  if (expression.type === "Identifier")
    return bindings.get(expression.name) ?? UNKNOWN_EXPORT("unresolved identifier");
  if (
    [
      "ArrayExpression",
      "ArrowFunctionExpression",
      "ClassExpression",
      "FunctionExpression",
      "ObjectExpression",
    ].includes(expression.type)
  ) {
    return WRONG_EXPORT(`a ${expression.type.replace("Expression", "").toLowerCase()}`);
  }
  return UNKNOWN_EXPORT(`unsupported ${expression.type}`);
}

async function runContracts(root, profile, severity) {
  const findings = [];
  const uncertainties = [];
  const add = (ruleId, file, node, message) =>
    findings.push(
      finding({
        engine: "contract",
        ruleId,
        file,
        ...sourcePosition(node),
        message,
        severity,
      }),
    );
  const uncertain = (ruleId, file, message) => uncertainties.push({ ruleId, file, message });
  const semanticTokens = await semanticDefinitions(root, profile);
  const componentModules = await walk(resolveInside(root, profile.appRoot), (file) =>
    file.endsWith(".module.css"),
  );
  const modulePaths = new Set(componentModules.map((file) => path.resolve(file)));

  for (const file of componentModules) {
    const relativeFile = path.relative(root, file).split(path.sep).join("/");
    const css = postcss.parse(await readFile(file, "utf8"), { from: file });
    const owners = layerOwners(profile, relativeFile);
    if (owners.length > 1) {
      add(
        "css-modules/layer-ownership-ambiguous",
        relativeFile,
        css,
        `More than one layers.ownership glob matches this module (${owners
          .map(({ glob, layer }) => `${glob} -> ${layer}`)
          .join(", ")}); narrow the globs so exactly one owner selects its layer.`,
      );
    }
    if (profile.colorTokens.enabled && !profile.colorTokens.semanticFiles.includes(relativeFile)) {
      css.walkDecls((declaration) => {
        for (const reference of colorValuePositions(declaration).variables) {
          if (
            reference.name.startsWith("--_") ||
            semanticTokens.has(reference.name) ||
            reference.hasFallback
          ) {
            continue;
          }
          add(
            "css-modules/semantic-token-resolves",
            relativeFile,
            declaration,
            `Semantic color token ${reference.name} is not defined by the recorded color contract.`,
          );
        }
      });
    }
    css.walkDecls("composes", (declaration) => {
      const match = declaration.value.match(/\sfrom\s+["']([^"']+)["']\s*$/);
      if (!match) return;
      const target = resolveComposesSpecifier(profile, match[1]);
      if (!target || !modulePaths.has(resolveInside(root, target))) {
        add(
          "css-modules/composes-path-resolves",
          relativeFile,
          declaration,
          `External composes path ${match[1]} does not resolve through the recorded style alias.`,
        );
      }
    });
  }

  const entryPath = resolveInside(root, profile.sharedApi.entryPoint);
  const parse = await loadModuleParser(profile.lintEngine);
  const entryAnalysis = await analyzeExportBindings(entryPath, parse);
  for (const module of profile.sharedApi.modules) {
    if (module.export) {
      const state = entryAnalysis.bindings.get(module.export);
      const expectedPath = path.resolve(resolveInside(root, module.path));
      if (!state && entryAnalysis.complete) {
        add(
          "css-modules/shared-entry-export",
          profile.sharedApi.entryPoint,
          null,
          `Shared entry point must export ${module.export} for ${module.name} at runtime.`,
        );
      } else if (!state || state.kind === "unknown") {
        uncertain(
          "css-modules/shared-entry-export",
          profile.sharedApi.entryPoint,
          `Could not prove runtime CSS-module provenance for export ${module.export} (${entryAnalysis.reason ?? state?.reason ?? "unsupported export syntax"}).`,
        );
      } else if (state.kind !== "css-module" || path.resolve(state.modulePath) !== expectedPath) {
        const actual =
          state.kind === "css-module"
            ? path.relative(root, state.modulePath).split(path.sep).join("/")
            : state.kind === "type-only"
              ? "a type-only export"
              : state.kind === "wrong"
                ? state.description
                : state.kind;
        add(
          "css-modules/shared-entry-export",
          profile.sharedApi.entryPoint,
          null,
          `Shared export ${module.export} for ${module.name} resolves to ${actual}; expected runtime CSS module ${module.path}.`,
        );
      }
    }
    if (!module.publicClasses) continue;
    const modulePath = resolveInside(root, module.path);
    if (!(await exists(modulePath))) continue;
    const css = postcss.parse(await readFile(modulePath, "utf8"), { from: modulePath });
    const actualClasses = classDefinitions(css);
    for (const className of actualClasses) {
      if (!module.publicClasses.includes(className)) {
        add(
          "css-modules/shared-public-class",
          module.path,
          css,
          `Shared class .${className} is not listed in sharedApi.modules.${module.name}.publicClasses.`,
        );
      }
    }
    for (const className of module.publicClasses) {
      if (!actualClasses.has(className)) {
        add(
          "css-modules/shared-public-class",
          module.path,
          css,
          `Recorded public class .${className} is absent from ${module.path}.`,
        );
      }
    }
  }
  return { findings, uncertainties };
}

export async function checkProject({
  root = process.cwd(),
  profilePath = ".agents/css-modules.json",
  severity,
} = {}) {
  const resolvedRoot = path.resolve(root);
  const contract = await readResolvedContract(resolvedRoot, profilePath);
  const profile = contract.profile;
  const selectedSeverity = selectSeverity(profile, severity);
  const palette = await paletteTokens(resolvedRoot, profile);
  const contractResult = await runContracts(resolvedRoot, profile, selectedSeverity);
  const rawFindings = [
    ...(await runTsxRules(resolvedRoot, profile, selectedSeverity)),
    ...(await runStylelint(resolvedRoot, profile, selectedSeverity, palette)),
    ...contractResult.findings,
  ];
  const finalized = finalizeFindings(
    rawFindings,
    profile.exceptions ?? [],
    contractResult.uncertainties,
  );
  return {
    root: resolvedRoot,
    profilePath,
    severity: selectedSeverity,
    ...finalized,
  };
}

export function exitCodeForCheck(result) {
  return exitCodeForFindings(result);
}

function runCommand(command, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Command failed${signal ? ` with ${signal}` : ` with exit code ${code}`}: ${command}`,
          ),
        );
    });
  });
}

export async function runProfileCommands({ root, profilePath = ".agents/css-modules.json" }) {
  const profile = (await readResolvedContract(root, profilePath)).profile;
  const commands = [];
  for (const id of ["css:generate", "css:types"]) {
    const command = profile.commands[id];
    if (!command) {
      throw new Error(
        `Resolved configuration has no ${id} command; add the package script or an explicit command override.`,
      );
    }
    await runCommand(command, root);
    commands.push({
      id,
      command,
      status: "passed",
      effect: id === "css:generate" ? "declared generated outputs" : "read-only typechecking",
    });
  }
  return {
    commands,
    authoredEdits: [],
    generatedOutputs: ["CSS Module declaration files and maps produced by css:generate"],
  };
}

export function formatCheck(result) {
  const report = formatFindingsReport(result, "CSS Modules source checks");
  if (!result.execution) return report;
  return `${report}\n\nExecution:\n${result.execution.commands
    .map(({ id, command, effect }) => `  EXECUTED ${id}: ${command} (${effect})`)
    .join(
      "\n",
    )}\n  Authored source/config edits: none\n  Generated outputs: permitted and reported above.`;
}

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    profilePath: ".agents/css-modules.json",
    format: "human",
    runDeclarations: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") options.root = argv[++index];
    else if (argument === "--profile") options.profilePath = argv[++index];
    else if (argument === "--format") options.format = argv[++index];
    else if (argument === "--severity") options.severity = argv[++index];
    else if (argument === "--run-declarations") options.runDeclarations = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!["human", "json"].includes(options.format)) throw new Error("format must be human or json");
  return options;
}

function usage() {
  return [
    "Usage: node check.mjs [options]",
    "",
    "--root <path>          project root; defaults to cwd",
    "--profile <path>       profile path relative to root",
    "--severity <level>     warning or error; overrides the profile migration level",
    "--run-declarations     run css:generate and css:types before source/contract checks",
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
    const execution = options.runDeclarations ? await runProfileCommands(options) : undefined;
    const result = await checkProject(options);
    if (execution) result.execution = execution;
    process.stdout.write(
      options.format === "json"
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${formatCheck(result)}\n`,
    );
    process.exitCode = exitCodeForCheck(result);
  } catch (error) {
    process.stderr.write(`CSS Modules checks failed: ${error.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
