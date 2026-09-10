import { readFile } from "node:fs/promises";
import path from "node:path";

function lineColumn(source, offset) {
  const before = source.slice(0, offset);
  const line = before.split("\n").length;
  const lastNewline = before.lastIndexOf("\n");
  return { line, column: offset - lastNewline };
}

function withoutComments(source) {
  let output = "";
  let index = 0;
  let quote = null;

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    if (quote) {
      output += character;
      if (character === "\\" && index + 1 < source.length) {
        output += source[index + 1];
        index += 2;
        continue;
      }
      if (character === quote) quote = null;
      index += 1;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      output += character;
      index += 1;
      continue;
    }

    if (character === "/" && next === "*") {
      output += "  ";
      index += 2;
      while (index < source.length) {
        if (source[index] === "*" && source[index + 1] === "/") {
          output += "  ";
          index += 2;
          break;
        }
        output += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }

    output += character;
    index += 1;
  }

  return output;
}

function skipString(source, index, end) {
  const quote = source[index];
  index += 1;
  while (index < end) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === quote) return index + 1;
    index += 1;
  }
  return end;
}

function findPreludeEnd(source, index, end) {
  let quote = null;
  let parentheses = 0;
  for (let cursor = index; cursor < end; cursor += 1) {
    const character = source[cursor];
    if (quote) {
      if (character === "\\") cursor += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(") parentheses += 1;
    else if (character === ")") parentheses = Math.max(0, parentheses - 1);
    else if (parentheses === 0 && (character === ";" || character === "{")) {
      return { end: cursor, terminator: character };
    }
  }
  return { end, terminator: null };
}

function splitTopLevel(value, separator) {
  const parts = [];
  let start = 0;
  let parentheses = 0;
  let quote = null;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "(") parentheses += 1;
    else if (character === ")") parentheses = Math.max(0, parentheses - 1);
    else if (character === separator && parentheses === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }

  parts.push(value.slice(start));
  return parts;
}

export function normalizeLayerName(name) {
  return name
    .trim()
    .replace(/\s+/g, "")
    .replace(/\.+/g, ".")
    .replace(/^\.|\.$/g, "");
}

const ANONYMOUS_LAYER = null;

function combineLayer(parent, child) {
  if (parent.includes(ANONYMOUS_LAYER)) return parent;
  const normalized = normalizeLayerName(child);
  if (!normalized) return parent;
  return [...parent, ...normalized.split(".").filter(Boolean)];
}

function parseImport(prelude) {
  const match = prelude.match(/^(["'])([^"']+)\1([\s\S]*)$/);
  if (!match) return { supported: false, reason: "import URL, expression, or unsupported syntax" };

  const rest = match[3].trim();
  if (!rest) return { supported: true, specifier: match[2], layer: null };

  const layerMatch = rest.match(/^layer(?:\(\s*([^)]*)\s*\))?(?:\s*)$/);
  if (!layerMatch) {
    return {
      supported: false,
      specifier: match[2],
      reason: "conditional or media-qualified import",
    };
  }

  return {
    supported: true,
    specifier: match[2],
    layer: layerMatch[1] ? normalizeLayerName(layerMatch[1]) : "",
  };
}

function relativeLocation(filePath, root, source, offset) {
  const location = lineColumn(source, offset);
  return {
    path: root ? path.relative(root, filePath).split(path.sep).join("/") : filePath,
    ...location,
  };
}

/**
 * Analyze first layer appearances in a CSS entry point. This is intentionally
 * a small CSS scanner, not a bundler: comments, layer statements/blocks, and
 * literal local imports are supported. Dynamic, external, conditional, and
 * cyclic imports remain explicit uncertainty.
 */
export async function analyzeLayerOrder({ entryPath, root } = {}) {
  const firstAppearances = [];
  const unknownImports = [];
  const visited = new Set();
  const visiting = new Set();
  const firstByTopLevel = new Map();

  function recordLayer({ filePath, source, offset, parent, name, kind }) {
    const ancestry = combineLayer(parent, name);
    if (ancestry.length === 0 || ancestry.includes(ANONYMOUS_LAYER)) return;
    const fullName = ancestry.join(".");
    const topLevel = ancestry[0];
    if (!firstByTopLevel.has(topLevel)) {
      const evidence = {
        name: fullName,
        topLevel,
        kind,
        source: relativeLocation(filePath, root, source, offset),
      };
      firstByTopLevel.set(topLevel, evidence);
      firstAppearances.push(evidence);
    }
  }

  function importUnknown(filePath, source, offset, reason, specifier) {
    unknownImports.push({
      source: relativeLocation(filePath, root, source, offset),
      specifier,
      reason,
    });
  }

  async function visit(filePath, parent, importSource) {
    const normalizedPath = path.resolve(filePath);
    const visitKey = normalizedPath + "\0" + parent.join(".");
    if (visiting.has(normalizedPath)) {
      unknownImports.push({
        source: importSource,
        specifier: normalizedPath,
        reason: "cyclic local import; effective order is not fully verifiable",
      });
      return;
    }
    if (visited.has(visitKey)) return;

    let source;
    try {
      source = await readFile(normalizedPath, "utf8");
    } catch {
      unknownImports.push({
        source: importSource,
        specifier: normalizedPath,
        reason: "local import target is not readable",
      });
      return;
    }

    visiting.add(normalizedPath);
    const clean = withoutComments(source);

    async function scan(start, end, ancestry, allowImports = false) {
      let index = start;
      let sawRule = false;
      while (index < end) {
        const character = clean[index];
        if (character === '"' || character === "'") {
          index = skipString(clean, index, end);
          continue;
        }
        if (character !== "@") {
          if (allowImports && character === "{") sawRule = true;
          index += 1;
          continue;
        }

        const atRuleStart = index;
        index += 1;
        const nameStart = index;
        while (index < end && /[\w-]/.test(clean[index])) index += 1;
        const atRule = clean.slice(nameStart, index).toLowerCase();
        const preludeStart = index;
        const prelude = findPreludeEnd(clean, index, end);
        const value = clean.slice(preludeStart, prelude.end).trim();

        if (atRule === "layer") {
          const names = splitTopLevel(value, ",").map(normalizeLayerName).filter(Boolean);
          for (const name of names) {
            recordLayer({
              filePath: normalizedPath,
              source,
              offset: atRuleStart,
              parent: ancestry,
              name,
              kind: prelude.terminator === "{" ? "block" : "statement",
            });
          }
        } else if (atRule === "import") {
          if (!allowImports || sawRule) {
            importUnknown(
              normalizedPath,
              source,
              atRuleStart,
              !allowImports
                ? "import is nested inside a rule or conditional block"
                : "import appears after another CSS rule",
              undefined,
            );
            index = prelude.end + (prelude.terminator === ";" ? 1 : 0);
            continue;
          }
          const parsed = parseImport(value);
          if (!parsed.supported) {
            importUnknown(normalizedPath, source, atRuleStart, parsed.reason, parsed.specifier);
          } else if (!parsed.specifier.startsWith(".")) {
            importUnknown(
              normalizedPath,
              source,
              atRuleStart,
              "external import; bundled layer order is not statically known",
              parsed.specifier,
            );
          } else {
            const importedPath = path.resolve(path.dirname(normalizedPath), parsed.specifier);
            if (root) {
              const relative = path.relative(path.resolve(root), importedPath);
              if (relative.startsWith("..") || path.isAbsolute(relative)) {
                importUnknown(
                  normalizedPath,
                  source,
                  atRuleStart,
                  "local import escapes the project root",
                  parsed.specifier,
                );
              } else {
                if (parsed.layer)
                  recordLayer({
                    filePath: normalizedPath,
                    source,
                    offset: atRuleStart,
                    parent: ancestry,
                    name: parsed.layer,
                    kind: "import",
                  });
                await visit(
                  importedPath,
                  combineLayer(ancestry, parsed.layer ?? ""),
                  relativeLocation(normalizedPath, root, source, atRuleStart),
                );
              }
            } else {
              if (parsed.layer)
                recordLayer({
                  filePath: normalizedPath,
                  source,
                  offset: atRuleStart,
                  parent: ancestry,
                  name: parsed.layer,
                  kind: "import",
                });
              await visit(
                importedPath,
                combineLayer(ancestry, parsed.layer ?? ""),
                relativeLocation(normalizedPath, root, source, atRuleStart),
              );
            }
          }
        }

        if (prelude.terminator === "{") {
          if (allowImports) sawRule = true;
          let depth = 1;
          let cursor = prelude.end + 1;
          while (cursor < end && depth > 0) {
            if (clean[cursor] === '"' || clean[cursor] === "'") {
              cursor = skipString(clean, cursor, end);
              continue;
            }
            if (clean[cursor] === "{") depth += 1;
            else if (clean[cursor] === "}") depth -= 1;
            cursor += 1;
          }
          const bodyEnd = cursor - 1;
          const childAncestry =
            atRule === "layer" && !value
              ? [...ancestry, ANONYMOUS_LAYER]
              : atRule === "layer" && !value.includes(",")
                ? combineLayer(ancestry, value)
                : ancestry;
          await scan(prelude.end + 1, Math.max(prelude.end + 1, bodyEnd), childAncestry, false);
          index = cursor;
        } else {
          index = prelude.end + (prelude.terminator === ";" ? 1 : 0);
        }
      }
    }

    await scan(0, clean.length, parent, true);
    visiting.delete(normalizedPath);
    visited.add(visitKey);
  }

  await visit(entryPath, [], undefined);
  return {
    order: firstAppearances.map(({ topLevel }) => topLevel),
    firstAppearances,
    unknownImports,
  };
}
