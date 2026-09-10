#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { escapeRegExp, exists, readJson, resolveInside, walk } from "./lib.mjs";
import {
  discoverProjectFacts,
  isCompactInput,
  readInputSchema,
  resolveContract,
  resolveLayerOwner,
  validateInput,
} from "./contract.mjs";
import { analyzeLayerOrder } from "./layer-analysis.mjs";

export { validateInput as validateProfile };

const VITE_CONFIG_NAMES = [
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.cjs",
  "vite.config.cts",
];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs"]);

const VERSION_CONTRACT = JSON.parse(
  await readFile(new URL("../versions.json", import.meta.url), "utf8"),
);
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
function finding(id, status, detail, expected, actual, verifyCommand) {
  return {
    id,
    status,
    detail,
    ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual }),
    ...(verifyCommand === undefined ? {} : { verifyCommand }),
  };
}

async function readText(filePath) {
  return readFile(filePath, "utf8");
}

async function detectPackageManager(root) {
  const markers = [
    ["pnpm", "pnpm-lock.yaml"],
    ["yarn", "yarn.lock"],
    ["bun", "bun.lock"],
    ["bun", "bun.lockb"],
    ["npm", "package-lock.json"],
  ];
  const detected = [];

  for (const [manager, marker] of markers) {
    if (await exists(path.join(root, marker))) {
      detected.push({ manager, marker });
    }
  }

  const managers = [...new Set(detected.map(({ manager }) => manager))];
  if (managers.length > 1) {
    return finding(
      "project.package-manager",
      "ambiguous",
      `Multiple lockfile families found: ${detected.map(({ marker }) => marker).join(", ")}`,
    );
  }

  let packageManagerField;
  const packagePath = path.join(root, "package.json");
  if (await exists(packagePath)) {
    const packageJson = await readJson(packagePath);
    packageManagerField = packageJson.packageManager?.split("@")[0];
  }

  if (packageManagerField && managers[0] && packageManagerField !== managers[0]) {
    return finding(
      "project.package-manager",
      "ambiguous",
      "packageManager disagrees with the lockfile",
      packageManagerField,
      managers[0],
    );
  }

  const selected = packageManagerField ?? managers[0];
  return selected
    ? finding("project.package-manager", "aligned", selected, selected, selected)
    : finding(
        "project.package-manager",
        "not-verifiable",
        "No package-manager marker found",
        undefined,
        undefined,
        "node -p \"require('./package.json').packageManager\"",
      );
}

function walkSources(directory) {
  return walk(
    directory,
    (filePath) => SOURCE_EXTENSIONS.has(path.extname(filePath)) && !filePath.endsWith(".d.ts"),
  );
}

function versionMajor(version) {
  return Number.parseInt(version.split(".")[0], 10);
}

async function findViteConfigs(root) {
  return walk(root, (filePath) => VITE_CONFIG_NAMES.includes(path.basename(filePath)));
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function tokenizeJavaScript(source) {
  const tokens = [];
  let index = 0;

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 2;
      continue;
    }
    if (character === '"' || character === "'") {
      const start = index;
      const quote = character;
      index += 1;
      let value = "";
      let closed = false;
      while (index < source.length) {
        if (source[index] === "\\") {
          const escaped = source[index + 1];
          const escapes = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v" };
          value += escapes[escaped] ?? escaped ?? "";
          index += 2;
        } else if (source[index] === quote) {
          index += 1;
          closed = true;
          break;
        } else {
          value += source[index];
          index += 1;
        }
      }
      tokens.push({ type: closed ? "string" : "unsupported", value, start, end: index });
      continue;
    }
    if (character === "`") {
      const start = index;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") index += 2;
        else if (source[index] === "`") {
          index += 1;
          break;
        } else index += 1;
      }
      tokens.push({ type: "unsupported", value: source.slice(start, index), start, end: index });
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[\w$]/.test(source[index])) index += 1;
      tokens.push({ type: "identifier", value: source.slice(start, index), start, end: index });
      continue;
    }
    if (/[0-9]/.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[\w.]/.test(source[index])) index += 1;
      tokens.push({ type: "number", value: source.slice(start, index), start, end: index });
      continue;
    }

    const threeCharacter = source.slice(index, index + 3);
    if (threeCharacter === "...") {
      tokens.push({ type: "punctuation", value: threeCharacter, start: index, end: index + 3 });
      index += 3;
      continue;
    }
    const twoCharacter = source.slice(index, index + 2);
    if (["=>", "&&", "||", "??", "?."].includes(twoCharacter)) {
      tokens.push({ type: "punctuation", value: twoCharacter, start: index, end: index + 2 });
      index += 2;
      continue;
    }
    tokens.push({ type: "punctuation", value: character, start: index, end: index + 1 });
    index += 1;
  }

  return tokens;
}

function isPunctuation(token, value) {
  return token?.type === "punctuation" && token.value === value;
}

function matchingToken(tokens, start, opening, closing) {
  if (!isPunctuation(tokens[start], opening)) return -1;
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if (isPunctuation(tokens[index], opening)) depth += 1;
    else if (isPunctuation(tokens[index], closing)) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function unwrapParentheses(tokens, start, end) {
  while (isPunctuation(tokens[start], "(") && matchingToken(tokens, start, "(", ")") === end - 1) {
    start += 1;
    end -= 1;
  }
  return { start, end };
}

function splitObjectProperties(tokens, start, end) {
  const properties = [];
  let index = start + 1;
  let hasSpread = false;

  while (index < end) {
    if (isPunctuation(tokens[index], ",")) {
      index += 1;
      continue;
    }
    if (isPunctuation(tokens[index], "...")) {
      hasSpread = true;
      index += 1;
      while (index < end && tokens[index].value !== ",") index += 1;
      continue;
    }

    const keyToken = tokens[index];
    const key =
      keyToken?.type === "string" || keyToken?.type === "identifier" ? keyToken.value : null;
    if (!key || !isPunctuation(tokens[index + 1], ":")) {
      return { properties, hasSpread: true, unsupported: true };
    }

    const valueStart = index + 2;
    let cursor = valueStart;
    const stack = [];
    while (cursor < end) {
      const value = tokens[cursor].value;
      if (tokens[cursor].type === "punctuation" && ["{", "[", "("].includes(value)) {
        stack.push(value);
      } else if (tokens[cursor].type === "punctuation" && ["}", "]", ")"].includes(value)) {
        stack.pop();
      }
      if (isPunctuation(tokens[cursor], ",") && stack.length === 0) break;
      cursor += 1;
    }
    properties.push({ key, start: valueStart, end: cursor });
    index = cursor + 1;
  }

  return { properties, hasSpread, unsupported: false };
}

function objectProperties(tokens, start, end) {
  const unwrapped = unwrapParentheses(tokens, start, end);
  if (!isPunctuation(tokens[unwrapped.start], "{")) return null;
  const close = matchingToken(tokens, unwrapped.start, "{", "}");
  if (close !== unwrapped.end - 1) return null;
  return splitObjectProperties(tokens, unwrapped.start, close);
}

function arrayElements(tokens, start, end) {
  const unwrapped = unwrapParentheses(tokens, start, end);
  if (!isPunctuation(tokens[unwrapped.start], "[")) return null;
  const close = matchingToken(tokens, unwrapped.start, "[", "]");
  if (close !== unwrapped.end - 1) return null;

  const elements = [];
  let cursor = unwrapped.start + 1;
  while (cursor < close) {
    if (isPunctuation(tokens[cursor], ",")) {
      cursor += 1;
      continue;
    }
    const elementStart = cursor;
    const stack = [];
    while (cursor < close) {
      const value = tokens[cursor].value;
      if (tokens[cursor].type === "punctuation" && ["{", "[", "("].includes(value)) {
        stack.push(value);
      } else if (tokens[cursor].type === "punctuation" && ["}", "]", ")"].includes(value)) {
        stack.pop();
      }
      if (isPunctuation(tokens[cursor], ",") && stack.length === 0) break;
      cursor += 1;
    }
    elements.push({ start: elementStart, end: cursor });
    cursor += 1;
  }
  return elements;
}

function propertyValue(properties, name) {
  for (let index = (properties?.properties.length ?? 0) - 1; index >= 0; index -= 1) {
    if (properties.properties[index].key === name) return properties.properties[index];
  }
  return undefined;
}

function literalValue(tokens, start, end) {
  const unwrapped = unwrapParentheses(tokens, start, end);
  if (unwrapped.end !== unwrapped.start + 1) return undefined;
  const token = tokens[unwrapped.start];
  if (token?.type === "string") return token.value;
  if (token?.value === "true") return true;
  if (token?.value === "false") return false;
  return undefined;
}

function expressionEnd(tokens, start) {
  const stack = [];
  for (let index = start; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (tokens[index].type === "punctuation" && ["{", "[", "("].includes(value)) {
      stack.push(value);
    } else if (tokens[index].type === "punctuation" && ["}", "]", ")"].includes(value)) {
      stack.pop();
    } else if (isPunctuation(tokens[index], ";") && stack.length === 0) {
      return index;
    }
  }
  return tokens.length;
}

function importedNamedBindings(tokens, moduleName, importedName) {
  const bindings = new Set();
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "import") continue;
    if (tokens[index + 1]?.value === "type") continue;
    let from = index + 1;
    while (from < tokens.length && tokens[from].value !== "from" && tokens[from].value !== ";") {
      from += 1;
    }
    if (
      tokens[from]?.value !== "from" ||
      tokens[from + 1]?.type !== "string" ||
      tokens[from + 1]?.value !== moduleName
    ) {
      continue;
    }
    const open = tokens.slice(index, from).findIndex((token) => isPunctuation(token, "{"));
    if (open < 0) continue;
    const openIndex = index + open;
    const closeIndex = matchingToken(tokens, openIndex, "{", "}");
    if (closeIndex < 0 || closeIndex > from) continue;
    for (let cursor = openIndex + 1; cursor < closeIndex; cursor += 1) {
      if (tokens[cursor].value !== importedName) continue;
      const alias = tokens[cursor + 1]?.value === "as" ? tokens[cursor + 2]?.value : undefined;
      bindings.add(alias ?? importedName);
    }
  }
  return bindings;
}

function findExportedConfig(tokens) {
  const exportIndex = tokens.findIndex(
    ({ value }, index) => value === "export" && tokens[index + 1]?.value === "default",
  );
  if (exportIndex < 0) return { status: "not-verifiable", reason: "no export default was found" };

  const start = exportIndex + 2;
  const end = expressionEnd(tokens, start);
  if (isPunctuation(tokens[start], "{")) {
    const close = matchingToken(tokens, start, "{", "}");
    return close < 0
      ? { status: "not-verifiable", reason: "exported config object is incomplete" }
      : close + 1 === end
        ? { status: "supported", start, end }
        : {
            status: "not-verifiable",
            reason: "exported config has unsupported trailing expressions",
          };
  }

  const defineConfigBindings = importedNamedBindings(tokens, "vite", "defineConfig");
  if (
    tokens[start]?.type === "identifier" &&
    defineConfigBindings.has(tokens[start].value) &&
    isPunctuation(tokens[start + 1], "(")
  ) {
    const close = matchingToken(tokens, start + 1, "(", ")");
    if (close < 0) return { status: "not-verifiable", reason: "defineConfig call is incomplete" };
    const objectStart = start + 2;
    const object = objectProperties(tokens, objectStart, close);
    return close + 1 === end && object
      ? { status: "supported", start: objectStart, end: close }
      : {
          status: "not-verifiable",
          reason: "defineConfig receives a dynamic config or has trailing expressions",
        };
  }

  let arrow = -1;
  let parameterNames = [];
  if (isPunctuation(tokens[start], "(")) {
    const parametersEnd = matchingToken(tokens, start, "(", ")");
    if (parametersEnd >= 0 && tokens[parametersEnd + 1]?.value === "=>") {
      parameterNames = tokens
        .slice(start + 1, parametersEnd)
        .filter(({ type }) => type === "identifier")
        .map(({ value }) => value);
      arrow = parametersEnd + 1;
    }
  } else if (tokens[start]?.type === "identifier" && tokens[start + 1]?.value === "=>") {
    parameterNames = [tokens[start].value];
    arrow = start + 1;
  }
  if (arrow >= 0) {
    const bodyStart = arrow + 1;
    const body = objectProperties(tokens, bodyStart, end);
    if (body) return { status: "supported", start: bodyStart, end, parameterNames };
    if (isPunctuation(tokens[bodyStart], "(")) {
      const close = matchingToken(tokens, bodyStart, "(", ")");
      if (close >= 0 && close + 1 === end && objectProperties(tokens, bodyStart + 1, close)) {
        return { status: "supported", start: bodyStart + 1, end: close, parameterNames };
      }
    }
  }

  return { status: "not-verifiable", reason: "exported Vite config uses an unsupported factory" };
}

function importedPatchBindings(tokens) {
  return importedNamedBindings(tokens, "vite-css-modules", "patchCssModules");
}

function findCall(tokens, start, end) {
  const open = start + 1;
  if (tokens[start]?.type !== "identifier" || !isPunctuation(tokens[open], "(")) return null;
  const close = matchingToken(tokens, open, "(", ")");
  return close === end - 1 ? { open, close } : null;
}

function analyzeViteConfig(source, verifyCommand = "npm run css:verify") {
  const tokens = tokenizeJavaScript(source);
  const exported = findExportedConfig(tokens);
  if (exported.status !== "supported") {
    return {
      status: "not-verifiable",
      reason: exported.reason,
      verifyCommand,
      patch: "not-verifiable",
      sourceTypes: "not-verifiable",
      classes: "not-verifiable",
    };
  }

  const config = objectProperties(tokens, exported.start, exported.end);
  if (!config || config.unsupported || config.hasSpread) {
    return {
      status: "not-verifiable",
      reason: "exported Vite config contains a spread or unsupported property syntax",
      verifyCommand,
      patch: "not-verifiable",
      sourceTypes: "not-verifiable",
      classes: "not-verifiable",
    };
  }

  const css = propertyValue(config, "css");
  const cssProperties = css && objectProperties(tokens, css.start, css.end);
  const modules = cssProperties && propertyValue(cssProperties, "modules");
  const moduleProperties = modules && objectProperties(tokens, modules.start, modules.end);
  const transformer =
    cssProperties &&
    literalValue(
      tokens,
      propertyValue(cssProperties, "transformer")?.start ?? -1,
      propertyValue(cssProperties, "transformer")?.end ?? -1,
    );
  let classes;
  if (!css) {
    classes = "missing";
  } else if (!cssProperties || cssProperties.hasSpread || (modules && !moduleProperties)) {
    classes = "not-verifiable";
  } else if (!modules) {
    classes = "missing";
  } else if (
    literalValue(
      tokens,
      propertyValue(moduleProperties, "localsConvention")?.start ?? -1,
      propertyValue(moduleProperties, "localsConvention")?.end ?? -1,
    ) === "camelCaseOnly" ||
    (transformer === "lightningcss" && propertyValue(moduleProperties, "pattern"))
  ) {
    classes = "aligned";
  } else {
    classes = "missing";
  }

  const plugins = propertyValue(config, "plugins");
  const pluginElements = plugins && arrayElements(tokens, plugins.start, plugins.end);
  const bindings = importedPatchBindings(tokens);
  const effectiveBindings = new Set(
    [...bindings].filter((binding) => !exported.parameterNames?.includes(binding)),
  );
  let patch = "missing";
  let sourceTypes = "missing";
  let unresolvedPluginExpression = false;
  if (!plugins) {
    patch = "missing";
    sourceTypes = "missing";
  } else if (
    !pluginElements ||
    pluginElements.some(({ start }) => tokens[start]?.value === "...")
  ) {
    patch = "not-verifiable";
    sourceTypes = "not-verifiable";
  } else {
    for (const element of pluginElements) {
      const binding = tokens[element.start]?.value;
      const call = findCall(tokens, element.start, element.end);
      if (
        call &&
        tokens[element.start]?.type === "identifier" &&
        bindings.has(binding) &&
        !effectiveBindings.has(binding)
      ) {
        patch = "not-verifiable";
        sourceTypes = "not-verifiable";
        continue;
      }
      if (!call) {
        if (
          !(
            tokens[element.start]?.type === "identifier" &&
            isPunctuation(tokens[element.start + 1], "(")
          )
        ) {
          unresolvedPluginExpression = true;
        }
        continue;
      }
      if (!effectiveBindings.has(binding)) continue;
      patch = "aligned";
      const argumentsStart = call.open + 1;
      if (argumentsStart === call.close) {
        sourceTypes = "missing";
        continue;
      }
      const options = objectProperties(tokens, argumentsStart, call.close);
      if (!options || options.hasSpread || options.unsupported) {
        patch = "not-verifiable";
        sourceTypes = "not-verifiable";
        continue;
      }
      sourceTypes =
        literalValue(
          tokens,
          propertyValue(options, "generateSourceTypes")?.start ?? -1,
          propertyValue(options, "generateSourceTypes")?.end ?? -1,
        ) === true
          ? "aligned"
          : "missing";
    }
    if (
      pluginElements.some(
        ({ start }) =>
          tokens[start]?.type === "identifier" && tokens[start]?.value === "patchCssModules",
      ) &&
      !effectiveBindings.size
    ) {
      patch = "not-verifiable";
      sourceTypes = "not-verifiable";
    }
  }
  if (unresolvedPluginExpression) {
    patch = "not-verifiable";
    sourceTypes = "not-verifiable";
  }

  return {
    status: "supported",
    reason: "exported Vite config uses supported static syntax",
    verifyCommand,
    patch,
    sourceTypes,
    classes,
  };
}

function stripYamlComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "#" && (index === 0 || /\s/.test(line[index - 1])))
      return line.slice(0, index);
  }
  return line;
}

function analyzeCiOrder(ciFiles, generateCommand, typesCommand) {
  const jobs = [];
  let unsupported = false;
  for (const { path: filePath, text } of ciFiles) {
    const lines = text.split(/\r?\n/);
    let job = "implicit";
    let inJobs = false;
    const runs = [];
    for (let index = 0; index < lines.length; index += 1) {
      const raw = lines[index];
      const clean = stripYamlComment(raw);
      if (!clean.trim()) continue;
      const indentation = clean.length - clean.trimStart().length;
      if (/^\s*(?:-\s+)?if\s*:/.test(clean)) {
        unsupported = true;
        continue;
      }
      if (indentation === 0 && clean.trim() === "jobs:") {
        inJobs = true;
        continue;
      }
      if (inJobs && indentation === 2 && /^[\w-]+:\s*$/.test(clean.trim())) {
        job = clean.trim().slice(0, -1);
        continue;
      }
      const inline = clean.match(/^\s*-\s+run:\s*(.*)$/);
      const property = clean.match(/^\s+run:\s*(.*)$/);
      if (!inline && !property) continue;
      const match = inline ?? property;
      const runIndent = match[0].indexOf("r");
      let command = match[1].trim();
      if (command === "|" || command === ">" || command === "|-" || command === ">-") {
        const block = [];
        index += 1;
        while (index < lines.length) {
          const next = stripYamlComment(lines[index]);
          if (next.trim() && next.length - next.trimStart().length <= runIndent) {
            index -= 1;
            break;
          }
          if (next.trim()) block.push(next.trim());
          index += 1;
        }
        command = block.join("\n");
      }
      if (!command || command.includes("${{") || command.includes("{{")) {
        unsupported = true;
        continue;
      }
      runs.push({ filePath, job, command });
    }
    jobs.push(...runs);
  }

  const byJob = new Map();
  for (const run of jobs) {
    const key = `${run.filePath}\0${run.job}`;
    byJob.set(key, [...(byJob.get(key) ?? []), run]);
  }
  const evaluations = [...byJob.values()].map((runs) => {
    const commands = runs.flatMap(({ command }) =>
      command.split(/\r?\n/).map((value) => value.trim()),
    );
    const generate = commands.findIndex((command) => command === generateCommand);
    const types = commands.findIndex((command) => command === typesCommand);
    return { runs, generate, types };
  });
  const ordered = evaluations.find(({ generate, types }) => generate >= 0 && types > generate);
  const reversed = evaluations.find(({ generate, types }) => generate >= 0 && types >= 0);
  const anyGenerate = jobs.some(({ command }) =>
    command.split(/\r?\n/).some((line) => line.trim() === generateCommand),
  );
  const anyTypes = jobs.some(({ command }) =>
    command.split(/\r?\n/).some((line) => line.trim() === typesCommand),
  );
  return { ordered, reversed, anyGenerate, anyTypes, unsupported };
}

function auditResult(root, profilePath, findings, resolved) {
  return {
    root,
    profilePath,
    status: summarizeStatus(findings),
    findings,
    blockingFindings: findings.filter(isBlockingFinding),
    ...(resolved ? { resolved } : {}),
  };
}

function isBlockingFinding({ id, status }) {
  if (status === "ambiguous") return true;
  if (id === "profile.adapter-version" && ["drifted", "not-verifiable"].includes(status)) {
    return true;
  }
  if (status !== "drifted") return false;
  return (
    id === "profile.methodology-version" ||
    id === "profile.schema-version" ||
    id === "layers.order" ||
    id.startsWith("layers.module.") ||
    id.startsWith("layers.ownership.") ||
    id === "styles.global-import" ||
    id === "colors.palette-boundary" ||
    id === "colors.theme-ownership" ||
    id.startsWith("contract.drift.")
  );
}

async function collectStaticConfigText(root, appRoot, viteConfigs) {
  const candidates = [
    path.join(root, "package.json"),
    path.join(root, "tsconfig.json"),
    path.join(appRoot, "package.json"),
    path.join(appRoot, "tsconfig.json"),
    ...viteConfigs,
  ];

  const texts = [];
  for (const candidate of new Set(candidates)) {
    if (await exists(candidate)) {
      texts.push(await readText(candidate));
    }
  }

  return texts.join("\n");
}

async function collectCiFiles(root) {
  const candidates = [];
  const workflowRoot = path.join(root, ".github", "workflows");

  if (await exists(workflowRoot)) {
    candidates.push(...(await walk(workflowRoot, (filePath) => /\.ya?ml$/i.test(filePath))));
  }

  for (const fileName of [".gitlab-ci.yml", "azure-pipelines.yml", "bitbucket-pipelines.yml"]) {
    const candidate = path.join(root, fileName);
    if (await exists(candidate)) {
      candidates.push(candidate);
    }
  }

  return Promise.all(
    [...new Set(candidates)].sort().map(async (filePath) => ({
      path: filePath,
      text: await readText(filePath),
    })),
  );
}

export async function auditProject({
  root = process.cwd(),
  profilePath = ".agents/css-modules.json",
} = {}) {
  const resolvedRoot = path.resolve(root);
  const findings = [await detectPackageManager(resolvedRoot)];
  const resolvedProfile = resolveInside(resolvedRoot, profilePath);

  if (!(await exists(resolvedProfile))) {
    findings.push(
      finding("profile.exists", "missing", `Profile not found: ${profilePath}`, profilePath),
    );

    const candidateConfigs = await findViteConfigs(resolvedRoot);
    if (candidateConfigs.length > 1) {
      findings.push(
        finding(
          "project.app-root",
          "ambiguous",
          `Profile is required to select one of ${candidateConfigs.length} Vite applications`,
          undefined,
          candidateConfigs.map((file) => path.relative(resolvedRoot, path.dirname(file))),
        ),
      );
    } else if (candidateConfigs.length === 1) {
      findings.push(
        finding(
          "project.app-root",
          "not-verifiable",
          `Candidate application found at ${path.relative(resolvedRoot, path.dirname(candidateConfigs[0]))}; record it in the profile`,
          undefined,
          undefined,
          "node scripts/audit.mjs --format human --profile .agents/css-modules.json",
        ),
      );
    }

    return auditResult(resolvedRoot, profilePath, findings);
  }

  let profile;
  try {
    profile = await readJson(resolvedProfile);
  } catch (error) {
    findings.push(finding("profile.parse", "ambiguous", error.message));
    return auditResult(resolvedRoot, profilePath, findings);
  }

  const profileErrors = validateInput(profile, {
    schema: await readInputSchema(resolvedRoot, profilePath, profile),
    // Version compatibility is reported as its own finding below. Keeping
    // that dispatch separate prevents an unsupported schema from hiding the
    // actionable version drift behind a generic shape error.
    ignoreVersion: true,
  });
  if (profileErrors.length > 0) {
    findings.push(finding("profile.schema", "ambiguous", profileErrors.join("; ")));
    return auditResult(resolvedRoot, profilePath, findings);
  }

  const discoveredFacts = await discoverProjectFacts(resolvedRoot);
  const inputProfile = profile;
  const resolved = resolveContract(inputProfile, { discoveredFacts });
  const selectedProfile = resolved.profile;
  profile = selectedProfile;
  findings.push(
    finding(
      "profile.schema",
      "aligned",
      isCompactInput(inputProfile) ? "Compact profile shape is valid" : "Profile shape is valid",
    ),
  );
  for (const item of resolved.drift) {
    findings.push(
      finding(
        `contract.drift.${item.field.replaceAll(".", "-")}`,
        "drifted",
        item.detail,
        item.explicit,
        item.discovered,
      ),
    );
  }
  for (const item of resolved.ambiguities) {
    findings.push(
      finding(
        `contract.ambiguous.${item.field}`,
        "ambiguous",
        `${item.field} has multiple discovered values; select one explicitly`,
        undefined,
        item.values,
      ),
    );
  }

  const methodologyMajor = versionMajor(selectedProfile.methodologyVersion);
  findings.push(
    methodologyMajor === SUPPORTED_METHODOLOGY_MAJOR
      ? finding("profile.methodology-version", "aligned", selectedProfile.methodologyVersion)
      : finding(
          "profile.methodology-version",
          "drifted",
          "Installed audit does not support this methodology major; plan an explicit migration",
          SUPPORTED_METHODOLOGY_MAJOR,
          methodologyMajor,
        ),
  );

  const profileSchemaVersion = isCompactInput(inputProfile)
    ? inputProfile.version
    : selectedProfile.profileSchemaVersion;
  const supportedSchemaVersion = isCompactInput(inputProfile)
    ? SUPPORTED_COMPACT_SCHEMA
    : SUPPORTED_PROFILE_SCHEMA;
  findings.push(
    profileSchemaVersion === supportedSchemaVersion
      ? finding("profile.schema-version", "aligned", profileSchemaVersion)
      : finding(
          "profile.schema-version",
          "drifted",
          "Installed audit does not support this profile schema; plan an explicit migration",
          supportedSchemaVersion,
          profileSchemaVersion,
        ),
  );

  const supportedAdapterMajor = SUPPORTED_ADAPTERS.get(selectedProfile.adapter.name);
  const adapterMajor = versionMajor(selectedProfile.adapter.version);
  if (supportedAdapterMajor === undefined) {
    findings.push(
      finding(
        "profile.adapter-version",
        "not-verifiable",
        `No executable adapter is bundled for ${selectedProfile.adapter.name}@${selectedProfile.adapter.version}`,
        undefined,
        undefined,
        selectedProfile.commands?.["css:verify"] ?? "node scripts/setup.mjs verify --format human",
      ),
    );
  } else {
    findings.push(
      adapterMajor === supportedAdapterMajor
        ? finding(
            "profile.adapter-version",
            "aligned",
            `${selectedProfile.adapter.name}@${selectedProfile.adapter.version}`,
          )
        : finding(
            "profile.adapter-version",
            "drifted",
            "Installed audit does not support this adapter major; plan an explicit migration",
            supportedAdapterMajor,
            adapterMajor,
          ),
    );
  }

  let appRoot;
  try {
    appRoot = resolveInside(resolvedRoot, profile.appRoot);
  } catch (error) {
    findings.push(finding("project.app-root", "ambiguous", error.message));
    return auditResult(resolvedRoot, profilePath, findings);
  }

  findings.push(
    (await exists(appRoot))
      ? finding("project.app-root", "aligned", profile.appRoot)
      : finding("project.app-root", "missing", "Application root does not exist", profile.appRoot),
  );

  const viteConfigs = [];
  let viteText = "";
  if (profile.adapter.name === "vite-react") {
    for (const name of VITE_CONFIG_NAMES) {
      const candidate = path.join(appRoot, name);
      if (await exists(candidate)) {
        viteConfigs.push(candidate);
      }
    }

    if (viteConfigs.length === 0) {
      findings.push(finding("vite.config", "missing", "No Vite config found"));
    } else if (viteConfigs.length > 1) {
      findings.push(
        finding(
          "vite.config",
          "ambiguous",
          `Multiple Vite configs found: ${viteConfigs.map((file) => path.basename(file)).join(", ")}`,
        ),
      );
    } else {
      findings.push(finding("vite.config", "aligned", path.relative(resolvedRoot, viteConfigs[0])));
    }

    if (viteConfigs.length === 1) {
      viteText = await readText(viteConfigs[0]);
      const config = analyzeViteConfig(
        viteText,
        profile.commands?.["css:verify"] ?? profile.commands?.["css:types"],
      );
      const configFinding = (id, status, alignedDetail, missingDetail) =>
        status === "aligned"
          ? finding(id, status, alignedDetail)
          : status === "missing"
            ? finding(id, status, missingDetail)
            : finding(
                id,
                status,
                `${config.reason}; static Vite analysis cannot prove this setting`,
                undefined,
                undefined,
                config.verifyCommand,
              );
      findings.push(
        configFinding(
          "vite.patch-css-modules",
          config.patch,
          "patchCssModules is configured on the exported config",
          "patchCssModules is absent from the exported config",
        ),
        configFinding(
          "vite.source-types",
          config.sourceTypes,
          "Source type generation is enabled on the exported patchCssModules call",
          "generateSourceTypes: true is absent from the exported patchCssModules call",
        ),
        configFinding(
          "vite.class-exports",
          config.classes,
          "Camel-case class export behavior is configured on the exported config",
          "localsConvention: camelCaseOnly is absent from the exported config",
        ),
      );
    } else if (viteConfigs.length === 0) {
      findings.push(
        finding(
          "vite.patch-css-modules",
          "missing",
          "patchCssModules cannot be present without a Vite config",
        ),
        finding(
          "vite.source-types",
          "missing",
          "Source type generation cannot be present without a Vite config",
        ),
        finding(
          "vite.class-exports",
          "missing",
          "Class export behavior cannot be present without a Vite config",
        ),
      );
    }
  } else {
    findings.push(
      finding(
        "adapter.build-contract",
        "not-verifiable",
        `Use the ${profile.adapter.name} adapter's own executable verifier`,
        undefined,
        undefined,
        profile.commands?.["css:verify"] ?? profile.commands?.["css:types"],
      ),
    );
  }

  const requiredPaths = [
    ["styles.root", profile.stylesRoot],
    ["styles.global", profile.globalStylesheet],
    ["styles.entry-point", profile.sharedApi.entryPoint],
    ...profile.sharedApi.modules.map((module) => [`styles.module.${module.name}`, module.path]),
  ];

  if (profile.colorTokens.enabled) {
    for (const [index, file] of profile.colorTokens.paletteFiles.entries()) {
      requiredPaths.push([`colors.palette.${index}`, file]);
    }
    for (const [index, file] of profile.colorTokens.semanticFiles.entries()) {
      requiredPaths.push([`colors.semantic.${index}`, file]);
    }
    requiredPaths.push(["colors.theme-owner", profile.colorTokens.themeOwner]);
  }

  let invalidProjectPath = false;
  for (const [id, projectPath] of requiredPaths) {
    let target;
    try {
      target = resolveInside(resolvedRoot, projectPath);
    } catch (error) {
      findings.push(finding(id, "ambiguous", error.message));
      invalidProjectPath = true;
      continue;
    }

    findings.push(
      (await exists(target))
        ? finding(id, "aligned", projectPath)
        : finding(id, "missing", "Configured path does not exist", projectPath),
    );
  }

  if (invalidProjectPath) {
    return auditResult(resolvedRoot, profilePath, findings);
  }

  const globalPath = resolveInside(resolvedRoot, profile.globalStylesheet);
  const globalCss = (await exists(globalPath)) ? await readText(globalPath) : "";
  const layerAnalysis = (await exists(globalPath))
    ? await analyzeLayerOrder({ entryPath: globalPath, root: resolvedRoot })
    : { order: [], firstAppearances: [], unknownImports: [] };
  const matchingOrder = sameArray(layerAnalysis.order, profile.layers.order);
  const orderFinding = matchingOrder
    ? finding(
        "layers.order",
        "aligned",
        "Global layer order matches the first observed layer appearances",
        profile.layers.order,
        layerAnalysis.order,
      )
    : finding(
        "layers.order",
        layerAnalysis.order.length === 0 ? "missing" : "drifted",
        layerAnalysis.order.length === 0
          ? "No top-level layer order found in the global stylesheet or its known local imports"
          : `Global layer order differs from the profile; first appearances: ${layerAnalysis.firstAppearances
              .map(({ topLevel, source }) => `${topLevel} (${source.path}:${source.line})`)
              .join(", ")}`,
        profile.layers.order,
        layerAnalysis.order,
      );
  orderFinding.evidence = layerAnalysis.firstAppearances;
  findings.push(orderFinding);
  if (layerAnalysis.unknownImports.length > 0) {
    findings.push(
      finding(
        "layers.imports",
        "not-verifiable",
        `Some CSS imports cannot be resolved safely; effective layer order may be incomplete (${layerAnalysis.unknownImports
          .map(({ specifier, reason }) => `${specifier ?? "unknown"}: ${reason}`)
          .join("; ")})`,
        undefined,
        layerAnalysis.unknownImports,
        profile.commands?.["css:verify"] ?? "node scripts/setup.mjs verify --format human",
      ),
    );
  }

  for (const module of profile.sharedApi.modules) {
    const modulePath = resolveInside(resolvedRoot, module.path);
    if (!(await exists(modulePath))) {
      continue;
    }

    const moduleLayerAnalysis = await analyzeLayerOrder({
      entryPath: modulePath,
      root: resolvedRoot,
    });
    const ownsLayer = moduleLayerAnalysis.firstAppearances.some(
      ({ name }) => name === module.layer,
    );
    findings.push(
      ownsLayer
        ? finding(`layers.module.${module.name}`, "aligned", `${module.path} owns ${module.layer}`)
        : finding(
            `layers.module.${module.name}`,
            "drifted",
            "Shared module does not declare its profiled layer",
            module.layer,
          ),
    );

    const ownerResolution = resolveLayerOwner(resolved, module.path);
    const matchingOwners = ownerResolution.matches;
    if (matchingOwners.length === 0) {
      findings.push(
        finding(
          `layers.ownership.${module.name}`,
          "missing",
          "No layer-ownership glob matches this shared module",
          module.layer,
        ),
      );
    } else if (matchingOwners.length > 1) {
      findings.push(
        finding(
          `layers.ownership.${module.name}`,
          "ambiguous",
          "More than one layer-ownership glob matches this shared module",
          undefined,
          matchingOwners,
        ),
      );
    } else {
      const [owner] = matchingOwners;
      findings.push(
        owner.layer === module.layer
          ? finding(
              `layers.ownership.${module.name}`,
              "aligned",
              `${owner.glob} owns ${module.layer}`,
            )
          : finding(
              `layers.ownership.${module.name}`,
              "drifted",
              "Ownership glob assigns a different layer",
              module.layer,
              owner.layer,
            ),
      );
    }
  }

  const entryPointPath = resolveInside(resolvedRoot, profile.sharedApi.entryPoint);
  if (await exists(entryPointPath)) {
    const entryPointSource = await readText(entryPointPath);
    for (const module of profile.sharedApi.modules) {
      if (!module.export) {
        continue;
      }

      findings.push(
        new RegExp(`\\b${escapeRegExp(module.export)}\\b`).test(entryPointSource)
          ? finding(`styles.export.${module.name}`, "aligned", module.export)
          : finding(
              `styles.export.${module.name}`,
              "missing",
              "Recorded shared export is absent from the entry point",
              module.export,
            ),
      );
    }
  }

  const staticConfigText = await collectStaticConfigText(resolvedRoot, appRoot, viteConfigs);
  for (const [id, alias] of [
    ["alias.bare", profile.alias.bare],
    ["alias.subpath", profile.alias.subpath],
  ]) {
    // Match the alias as a complete quoted key or value. A bare substring search
    // would let "#styles/*" satisfy "#styles" and hide a missing bare mapping.
    const declared = new RegExp(`["']${escapeRegExp(alias)}["']`).test(staticConfigText);
    findings.push(
      declared
        ? finding(
            id,
            "not-verifiable",
            `Alias is declared but resolution is not statically provable: ${alias}`,
            undefined,
            undefined,
            profile.commands?.["css:verify"] ?? profile.commands?.["css:types"],
          )
        : finding(
            id,
            "missing",
            `Alias is not declared in package, TypeScript, or build configuration: ${alias}`,
            alias,
            undefined,
            profile.commands?.["css:verify"] ?? profile.commands?.["css:types"],
          ),
    );
  }

  const stylesRoot = resolveInside(resolvedRoot, profile.stylesRoot);
  const relativeGlobal = path.relative(stylesRoot, globalPath).split(path.sep).join("/");
  const globalSpecifier = `${profile.alias.bare}/${relativeGlobal}`;
  const sourceFiles = await walkSources(appRoot);
  let globalImportCount = 0;
  for (const sourceFile of sourceFiles) {
    const source = await readText(sourceFile);
    for (const match of source.matchAll(/\bimport\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g)) {
      const specifier = match[1];
      const resolvesToGlobal =
        specifier === globalSpecifier ||
        (specifier.startsWith(".") &&
          path.resolve(path.dirname(sourceFile), specifier) === globalPath);

      if (resolvesToGlobal) {
        globalImportCount += 1;
      }
    }
  }
  findings.push(
    globalImportCount === 1
      ? finding("styles.global-import", "aligned", globalSpecifier, 1, 1)
      : finding(
          "styles.global-import",
          globalImportCount === 0 ? "missing" : "drifted",
          "Global stylesheet must be imported exactly once",
          1,
          globalImportCount,
        ),
  );

  if (profile.colorTokens.enabled) {
    findings.push(
      /color-scheme\s*:/.test(globalCss)
        ? finding("colors.color-scheme", "aligned", "color-scheme mapping found")
        : finding("colors.color-scheme", "missing", "color-scheme mapping is absent"),
    );

    for (const mode of profile.colorTokens.modes.filter((mode) => mode !== "system")) {
      const modePattern = new RegExp(
        `\\[${escapeRegExp(profile.colorTokens.themeAttribute)}\\s*=\\s*["']${escapeRegExp(mode)}["']\\]`,
      );
      findings.push(
        modePattern.test(globalCss)
          ? finding(`colors.theme-mode.${mode}`, "aligned", mode)
          : finding(
              `colors.theme-mode.${mode}`,
              "missing",
              "Global stylesheet does not map this recorded theme mode",
              mode,
            ),
      );
    }

    const paletteTokens = new Set();
    for (const paletteFile of profile.colorTokens.paletteFiles) {
      const palettePath = resolveInside(resolvedRoot, paletteFile);
      if (!(await exists(palettePath))) {
        continue;
      }
      const paletteCss = await readText(palettePath);
      for (const match of paletteCss.matchAll(/(--[\w-]+)\s*:/g)) {
        paletteTokens.add(match[1]);
      }
    }

    findings.push(
      paletteTokens.size > 0
        ? finding(
            "colors.palette-definitions",
            "aligned",
            `${paletteTokens.size} palette tokens found`,
          )
        : finding("colors.palette-definitions", "missing", "No palette token definitions found"),
    );

    const semanticTexts = [];
    for (const semanticFile of profile.colorTokens.semanticFiles) {
      const semanticPath = resolveInside(resolvedRoot, semanticFile);
      if (await exists(semanticPath)) {
        semanticTexts.push(await readText(semanticPath));
      }
    }
    findings.push(
      semanticTexts.some((css) => /light-dark\s*\(/.test(css))
        ? finding("colors.semantic-mapping", "aligned", "light-dark semantic mapping found")
        : finding("colors.semantic-mapping", "missing", "No light-dark semantic mapping found"),
    );

    const moduleFiles = await walk(appRoot, (filePath) => filePath.endsWith(".module.css"));
    const paletteViolations = [];
    const themeSelectorViolations = [];
    const themeSelector = new RegExp(
      `\\[${escapeRegExp(profile.colorTokens.themeAttribute)}(?:\\s*=|\\])`,
    );

    for (const moduleFile of moduleFiles) {
      const css = await readText(moduleFile);
      const relativeModule = path.relative(resolvedRoot, moduleFile);
      if (
        [...paletteTokens].some((token) =>
          new RegExp(`var\\(\\s*${escapeRegExp(token)}(?:\\s*[,)]|\\s*$)`).test(css),
        )
      ) {
        paletteViolations.push(relativeModule);
      }
      if (themeSelector.test(css)) {
        themeSelectorViolations.push(relativeModule);
      }
    }

    // An empty scan proves nothing; only a scan that actually read component
    // modules may report these boundaries as aligned.
    const scannedModules = moduleFiles.length > 0;
    findings.push(
      !scannedModules
        ? finding(
            "colors.palette-boundary",
            "not-verifiable",
            `No component modules were found under ${profile.appRoot}`,
            undefined,
            undefined,
            profile.commands?.["css:check"] ?? profile.commands?.["css:types"],
          )
        : paletteViolations.length === 0
          ? finding("colors.palette-boundary", "aligned", "Component modules avoid palette tokens")
          : finding(
              "colors.palette-boundary",
              "drifted",
              "Component modules consume primitive palette tokens",
              "semantic color roles only",
              paletteViolations,
            ),
    );
    findings.push(
      !scannedModules
        ? finding(
            "colors.theme-ownership",
            "not-verifiable",
            `No component modules were found under ${profile.appRoot}`,
            undefined,
            undefined,
            profile.commands?.["css:check"] ?? profile.commands?.["css:types"],
          )
        : themeSelectorViolations.length === 0
          ? finding(
              "colors.theme-ownership",
              "aligned",
              "Component modules do not own theme selectors",
            )
          : finding(
              "colors.theme-ownership",
              "drifted",
              "Component modules contain the application theme selector",
              profile.colorTokens.themeOwner,
              themeSelectorViolations,
            ),
    );
  }

  // css:generate and css:types are guaranteed by profile validation; the optional
  // CSS-specific static and runtime checks are the ones worth reporting on.
  const optionalCommands = ["css:check", "css:verify"].filter((key) => profile.commands?.[key]);
  findings.push(
    optionalCommands.length === 2
      ? finding(
          "commands.profile",
          "aligned",
          "CSS-specific static and runtime checks are recorded",
        )
      : finding(
          "commands.profile",
          "not-verifiable",
          `No recorded CSS-specific ${["css:check", "css:verify"]
            .filter((key) => !profile.commands?.[key])
            .join(" or ")} command`,
          ["css:check", "css:verify"],
          optionalCommands,
          "node .agents/css-modules-harness/scripts/check.mjs --root . --run-declarations",
        ),
  );

  const ciFiles = await collectCiFiles(resolvedRoot);
  if (ciFiles.length === 0) {
    findings.push(
      finding("ci.configuration", "missing", "No supported CI configuration was found"),
    );
  } else {
    const generateCommand = profile.commands?.["css:generate"];
    const typesCommand = profile.commands?.["css:types"];
    const ci = analyzeCiOrder(ciFiles, generateCommand, typesCommand);
    if (ci.ordered && !ci.unsupported) {
      const [{ filePath, job }] = ci.ordered.runs;
      findings.push(
        finding(
          "ci.css-order",
          "aligned",
          `${path.relative(resolvedRoot, filePath)} job ${job} runs the recorded CSS generation command before typechecking`,
        ),
      );
    } else if (ci.unsupported) {
      findings.push(
        finding(
          "ci.css-order",
          "not-verifiable",
          "Static CI analysis cannot prove ordering when a conditional or unsupported step is present",
          [generateCommand, typesCommand],
          ciFiles.map(({ path: filePath }) => path.relative(resolvedRoot, filePath)),
          profile.commands?.["css:verify"] ?? "node scripts/setup.mjs verify --format human",
        ),
      );
    } else if (ci.reversed) {
      findings.push(
        finding(
          "ci.css-order",
          "drifted",
          "CI must run the recorded CSS generation command before the CSS type command",
          [generateCommand, typesCommand],
          [typesCommand, generateCommand],
        ),
      );
    } else if (ci.anyGenerate || ci.anyTypes || ci.unsupported) {
      findings.push(
        finding(
          "ci.css-order",
          "not-verifiable",
          "Static CI analysis only proves direct run steps in the same job; wrappers, expressions, or independent jobs do not prove command ordering",
          [generateCommand, typesCommand],
          ciFiles.map(({ path: filePath }) => path.relative(resolvedRoot, filePath)),
          profile.commands?.["css:verify"] ?? "node scripts/setup.mjs verify --format human",
        ),
      );
    } else {
      findings.push(
        finding(
          "ci.css-order",
          "missing",
          "No supported CI run step contains the recorded CSS generation and CSS type commands",
          [generateCommand, typesCommand],
          [],
        ),
      );
    }
  }

  findings.push(
    finding(
      "types.freshness",
      "not-verifiable",
      `Run explicit verify mode: ${profile.commands?.["css:generate"] ?? "the recorded CSS generation command"} && ${profile.commands?.["css:types"] ?? "the recorded CSS type command"}`,
      undefined,
      undefined,
      `${profile.commands?.["css:generate"] ?? "the recorded CSS generation command"} && ${profile.commands?.["css:types"] ?? "the recorded CSS type command"}`,
    ),
  );

  findings.push(
    finding(
      "runtime.behavior",
      "not-verifiable",
      "Static audit does not execute Vite or a browser; run explicit verify mode",
      undefined,
      undefined,
      profile.commands?.["css:verify"] ?? "node scripts/setup.mjs verify --format human",
    ),
  );

  return auditResult(resolvedRoot, profilePath, findings, resolved);
}

function summarizeStatus(findings) {
  if (findings.some(({ status }) => status === "ambiguous")) {
    return "ambiguous";
  }
  if (findings.some(({ status }) => status === "drifted")) {
    return "drifted";
  }
  if (findings.some(({ status }) => status === "missing")) {
    return "missing";
  }
  if (findings.some(({ status }) => status === "not-verifiable")) {
    return "not-verifiable";
  }
  return "aligned";
}

export function exitCodeFor(result) {
  if (result.status === "ambiguous") {
    return 2;
  }
  if (
    result.blockingFindings?.some(
      ({ id, status }) => id === "profile.adapter-version" && status === "not-verifiable",
    )
  ) {
    return 1;
  }
  if (["missing", "drifted"].includes(result.status)) {
    return 1;
  }
  return 0;
}

export function formatHuman(result) {
  const lines = [`CSS Modules alignment: ${result.root}`, ""];
  const width = Math.max(...result.findings.map(({ status }) => status.length));
  if (result.blockingFindings?.length) {
    lines.push("Blocking findings: " + result.blockingFindings.map(({ id }) => id).join(", "), "");
  }

  for (const item of result.findings) {
    lines.push(`${item.status.toUpperCase().padEnd(width)}  ${item.id.padEnd(28)}  ${item.detail}`);
    if (item.expected !== undefined) {
      lines.push(`${"".padEnd(width)}  ${"expected".padEnd(28)}  ${JSON.stringify(item.expected)}`);
    }
    if (item.actual !== undefined) {
      lines.push(`${"".padEnd(width)}  ${"actual".padEnd(28)}  ${JSON.stringify(item.actual)}`);
    }
    if (item.verifyCommand) {
      lines.push(`${"".padEnd(width)}  ${"verify".padEnd(28)}  ${item.verifyCommand}`);
    }
  }

  lines.push("", `Result: ${result.status}`);
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    profilePath: ".agents/css-modules.json",
    format: "human",
    check: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") {
      options.root = argv[++index];
    } else if (argument === "--profile") {
      options.profilePath = argv[++index];
    } else if (argument === "--format") {
      options.format = argv[++index];
    } else if (argument === "--check") {
      options.check = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!options.root || !options.profilePath) {
    throw new Error("--root and --profile require values");
  }
  if (!new Set(["human", "json"]).has(options.format)) {
    throw new Error("--format must be human or json");
  }

  return options;
}

function usage() {
  return [
    "Usage: node audit.mjs [options]",
    "",
    "--root <path>       project root; defaults to cwd",
    "--profile <path>    profile path relative to root",
    "--format <format>   human or json",
    "--check             CI mode; exit non-zero for missing, drifted, or ambiguous findings",
  ].join("\n");
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }

    const result = await auditProject(options);
    process.stdout.write(
      options.format === "json"
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${formatHuman(result)}\n`,
    );
    process.exitCode = options.check ? exitCodeFor(result) : 0;
  } catch (error) {
    process.stderr.write(`Audit failed: ${error.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
