// Shared helpers for the CSS Modules harness scripts. Setup bundles this file
// into projects beside the checker scripts, so it must import nothing outside
// this directory and node built-ins.

import { access, lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "test-results",
]);

const LIB_ROOT = path.dirname(fileURLToPath(import.meta.url));

async function loadProfileSchema() {
  const candidates = [
    path.join(LIB_ROOT, "../assets/css-modules.schema.json"),
    path.join(LIB_ROOT, "../../css-modules.schema.json"),
  ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(await readFile(candidate, "utf8"));
    } catch {
      // The installed harness keeps the copied schema beside .agents/, while
      // the source harness reads the canonical asset from ../assets.
    }
  }
  throw new Error("Unable to locate the canonical css-modules.schema.json");
}

const DEFAULT_PROFILE_SCHEMA = await loadProfileSchema();

export async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export function resolveInside(root, relativePath) {
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes the project root: ${relativePath}`);
  }

  return resolved;
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))
  );
}

async function nearestExistingAncestor(filePath) {
  let candidate = filePath;
  while (true) {
    try {
      await lstat(candidate);
      return candidate;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) return undefined;
      candidate = parent;
    }
  }
}

/**
 * Check the complete output manifest before any mutation. This protects the
 * lexical root check from symlinked parents while intentionally leaving the
 * final write race to the exclusive/preimage checks in setup.mjs.
 */
export async function preflightWriteSet(root, entries) {
  const lexicalRoot = path.resolve(root);
  const canonicalRoot = await realpath(lexicalRoot);
  const collisions = new Map();
  const errors = [];

  for (const entry of entries) {
    const destination = resolveInside(lexicalRoot, entry.path);
    const normalizedPath = path.relative(lexicalRoot, destination).split(path.sep).join("/");
    const source = entry.source ?? entry.path;
    const first = collisions.get(destination);
    if (first) {
      if (!first.sources.includes(source)) first.sources.push(source);
      continue;
    }
    collisions.set(destination, { path: normalizedPath, sources: [source] });

    const existingAncestor = await nearestExistingAncestor(destination);
    if (!existingAncestor) {
      errors.push({
        path: normalizedPath,
        reason: "destination has no existing ancestor to canonicalize",
        sources: [source],
      });
      continue;
    }
    let canonicalAncestor;
    try {
      canonicalAncestor = await realpath(existingAncestor);
    } catch (error) {
      errors.push({
        path: normalizedPath,
        reason: `destination ancestor cannot be resolved: ${error.message}`,
        sources: [source],
      });
      continue;
    }
    if (!isContained(canonicalRoot, canonicalAncestor)) {
      errors.push({
        path: normalizedPath,
        reason: `destination escapes the canonical target root through ${path.relative(lexicalRoot, existingAncestor) || "."}`,
        sources: [source],
      });
    }
  }

  for (const collision of collisions.values()) {
    if (collision.sources.length > 1) {
      errors.push({
        path: collision.path,
        reason: `normalized destination is produced by multiple sources: ${collision.sources.join(", ")}`,
        sources: collision.sources,
      });
    }
  }
  return { canonicalRoot, errors };
}

export async function walk(directory, predicate, output = []) {
  if (!(await exists(directory))) return output;
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(entryPath, predicate, output);
    else if (predicate(entryPath)) output.push(entryPath);
  }
  return output;
}

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function globToRegExp(glob) {
  const normalized = glob.split(path.sep).join("/");
  let pattern = "^";

  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*" && normalized[index + 1] === "*") {
      if (normalized[index + 2] === "/") {
        pattern += "(?:.*/)?";
        index += 2;
      } else {
        pattern += ".*";
        index += 1;
      }
    } else if (character === "*") pattern += "[^/]*";
    else if (character === "?") pattern += "[^/]";
    else pattern += escapeRegExp(character);
  }

  return new RegExp(`${pattern}$`);
}

export function matchesGlob(filePath, glob) {
  return globToRegExp(glob).test(filePath.split(path.sep).join("/"));
}

function resolveSchemaRef(schema, rootSchema) {
  if (!schema.$ref) return schema;
  const prefix = "#/$defs/";
  if (!schema.$ref.startsWith(prefix)) return {};
  return rootSchema.$defs?.[schema.$ref.slice(prefix.length)] ?? {};
}

function matchesType(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object")
    return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function instancePath(parent, key) {
  return typeof key === "number" ? `${parent}[${key}]` : `${parent}.${key}`;
}

function schemaErrors(value, schema, location, rootSchema, options, errors) {
  const resolved = resolveSchemaRef(schema, rootSchema);
  if (resolved.type) {
    const types = Array.isArray(resolved.type) ? resolved.type : [resolved.type];
    if (!types.some((type) => matchesType(value, type))) {
      errors.push(`${location} must be ${types.join(" or ")}`);
      return;
    }
  }

  if (
    resolved.const !== undefined &&
    !(options.ignoreVersion && ["$.profileSchemaVersion", "$.version"].includes(location))
  ) {
    if (JSON.stringify(value) !== JSON.stringify(resolved.const)) {
      errors.push(`${location} must equal ${JSON.stringify(resolved.const)}`);
      return;
    }
  }
  if (
    resolved.enum &&
    !resolved.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))
  ) {
    errors.push(
      `${location} must be one of ${resolved.enum.map((candidate) => JSON.stringify(candidate)).join(", ")}`,
    );
  }
  if (typeof value === "string") {
    if (resolved.minLength !== undefined && value.length < resolved.minLength) {
      errors.push(`${location} must be a non-empty string`);
    }
    if (resolved.pattern && !new RegExp(resolved.pattern).test(value)) {
      errors.push(`${location} must match ${resolved.pattern}`);
    }
  }
  if (typeof value === "number" && resolved.minimum !== undefined && value < resolved.minimum) {
    errors.push(`${location} must be at least ${resolved.minimum}`);
  }
  if (Array.isArray(value)) {
    if (resolved.minItems !== undefined && value.length < resolved.minItems) {
      errors.push(`${location} must contain at least ${resolved.minItems} item(s)`);
    }
    if (resolved.uniqueItems) {
      const serialized = value.map((item) => JSON.stringify(item));
      if (new Set(serialized).size !== serialized.length)
        errors.push(`${location} must not contain duplicates`);
    }
    if (resolved.items) {
      value.forEach((item, index) =>
        schemaErrors(
          item,
          resolved.items,
          instancePath(location, index),
          rootSchema,
          options,
          errors,
        ),
      );
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const properties = resolved.properties ?? {};
    if (
      resolved.minProperties !== undefined &&
      Object.keys(value).length < resolved.minProperties
    ) {
      errors.push(`${location} must contain at least ${resolved.minProperties} properties`);
    }
    for (const required of resolved.required ?? []) {
      if (!(required in value)) errors.push(`${instancePath(location, required)} is required`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (!(key in properties)) {
        if (resolved.additionalProperties === false) {
          if (location === "$" && (key === "spacing" || key === "sizeScale")) {
            errors.push(
              `$.${key} must not define spacing or sizeScale policy in a generic profile`,
            );
          } else if (location === "$.commands") {
            errors.push(
              `${instancePath(location, key)} is not a CSS harness command (additional property is not allowed)`,
            );
          } else {
            errors.push(`${instancePath(location, key)} is not allowed by the profile schema`);
          }
        } else if (resolved.additionalProperties && resolved.additionalProperties !== true) {
          schemaErrors(
            item,
            resolved.additionalProperties,
            instancePath(location, key),
            rootSchema,
            options,
            errors,
          );
        }
        continue;
      }
      schemaErrors(item, properties[key], instancePath(location, key), rootSchema, options, errors);
    }
  }
  for (const condition of resolved.allOf ?? []) {
    schemaErrors(value, condition, location, rootSchema, options, errors);
  }
  if (resolved.if) {
    const conditionErrors = [];
    schemaErrors(value, resolved.if, location, rootSchema, options, conditionErrors);
    const branch = conditionErrors.length === 0 ? resolved.then : resolved.else;
    if (branch) schemaErrors(value, branch, location, rootSchema, options, errors);
  }
}

function semanticProfileErrors(profile) {
  if (
    !profile.layers ||
    !profile.layers.order ||
    !profile.sharedApi ||
    !Array.isArray(profile.sharedApi.modules) ||
    !profile.colorTokens
  ) {
    return [];
  }
  if (profile.profileSchemaVersion !== DEFAULT_PROFILE_SCHEMA.properties.profileSchemaVersion.const)
    return [];
  const errors = [];
  const order = profile.layers.order;
  const modules = profile.sharedApi.modules;
  const ownership = profile.layers.ownership;
  const moduleNames = modules.map(({ name }) => name);
  const modulePaths = modules.map(({ path: modulePath }) => modulePath);
  if (new Set(moduleNames).size !== moduleNames.length)
    errors.push("sharedApi.modules names must be unique");
  if (new Set(modulePaths).size !== modulePaths.length)
    errors.push("sharedApi.modules paths must be unique");
  for (const [index, module] of modules.entries()) {
    if (!order.includes(module.layer))
      errors.push(`sharedApi.modules[${index}].layer is absent from layers.order`);
  }
  for (const [index, owner] of ownership.entries()) {
    if (!order.includes(owner.layer))
      errors.push(`layers.ownership[${index}].layer is absent from layers.order`);
    if (path.isAbsolute(owner.glob) || owner.glob.split(/[\\/]/).includes("..")) {
      errors.push(`layers.ownership[${index}].glob must stay inside the project root`);
    }
  }
  if (
    profile.layers.localModules.strategy === "profiled" &&
    !order.includes(profile.layers.localModules.layer)
  ) {
    errors.push("layers.localModules.layer is absent from layers.order");
  }
  if (profile.colorTokens.enabled) {
    const supportedMappings = new Set(["light", "dark", "light dark"]);
    for (const mode of profile.colorTokens.modes) {
      if (
        !["system", "light", "dark"].includes(mode) &&
        !supportedMappings.has(profile.colorTokens.modeMapping?.[mode])
      ) {
        errors.push(`colorTokens.modes.${mode} requires colorTokens.modeMapping.${mode}`);
      }
    }
  }
  return errors;
}

export function validateProfile(
  profile,
  { schema = DEFAULT_PROFILE_SCHEMA, ignoreVersion = false } = {},
) {
  if (profile === null || typeof profile !== "object" || Array.isArray(profile)) {
    return ["$ must be a JSON object"];
  }
  const errors = [];
  schemaErrors(profile, schema, "$", schema, { ignoreVersion }, errors);
  if (errors.length === 0) errors.push(...semanticProfileErrors(profile));
  return errors;
}

export async function readProfileSchema(root, profilePath) {
  const profileFile = resolveInside(root, profilePath);
  const besideProfile = path.join(path.dirname(profileFile), "css-modules.schema.json");
  try {
    return JSON.parse(await readFile(besideProfile, "utf8"));
  } catch {
    return DEFAULT_PROFILE_SCHEMA;
  }
}

export async function readProfile(root, profilePath) {
  const profile = await readJson(resolveInside(root, profilePath));
  if (profile?.format === "css-modules-compact") {
    const { readResolvedContract } = await import("./contract.mjs");
    return (await readResolvedContract(root, profilePath)).profile;
  }
  const schema = await readProfileSchema(root, profilePath);
  const errors = validateProfile(profile, { schema });
  if (errors.length > 0) throw new Error(`Invalid CSS Modules profile: ${errors.join("; ")}`);
  return profile;
}

export function selectSeverity(profile, override) {
  const severity = override ?? profile.enforcement?.severity ?? "error";
  if (!["warning", "error"].includes(severity)) {
    throw new Error("severity must be warning or error");
  }
  return severity;
}

export function matchesException(finding, exception) {
  return (
    exception.kind === "rule" &&
    exception.rule === finding.ruleId &&
    matchesGlob(finding.file, exception.scope) &&
    (!exception.match || finding.message.includes(exception.match))
  );
}

export function finalizeFindings(rawFindings, exceptions = [], uncertainties = []) {
  const sorted = [...rawFindings].sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.column - right.column ||
      left.ruleId.localeCompare(right.ruleId),
  );
  const findings = [];
  const suppressed = [];
  for (const item of sorted) {
    const exception = exceptions.find((candidate) => matchesException(item, candidate));
    if (exception) suppressed.push({ finding: item, exception });
    else findings.push(item);
  }
  const status = findings.some(({ severity }) => severity === "error")
    ? "failed"
    : findings.length > 0
      ? "warnings"
      : uncertainties.length > 0
        ? "uncertain"
        : "passed";
  return { findings, suppressed, status, uncertainties };
}

export function exitCodeForFindings(result) {
  return result.status === "failed" ? 1 : 0;
}

export function formatFindingsReport(result, title) {
  const lines = [`${title}: ${result.root}`, ""];
  for (const item of result.findings) {
    lines.push(
      `${item.severity.toUpperCase()} ${item.file}:${item.line}:${item.column} ${item.ruleId} ${item.message}`,
    );
  }
  if (result.findings.length === 0) lines.push("No violations.");
  if (result.suppressed.length > 0)
    lines.push("", `Suppressed by documented exceptions: ${result.suppressed.length}`);
  if (result.uncertainties?.length > 0) {
    lines.push("", `Analysis uncertainty: ${result.uncertainties.length}`);
    for (const item of result.uncertainties) lines.push(`UNVERIFIED ${item.file} ${item.message}`);
  }
  lines.push("", `Result: ${result.status}`);
  return lines.join("\n");
}
