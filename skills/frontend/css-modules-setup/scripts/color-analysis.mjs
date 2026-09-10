import valueParser from "postcss-value-parser";

const RAW_COLOR_FUNCTIONS = new Set([
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "hwb",
  "lab",
  "lch",
  "oklab",
  "oklch",
  "color",
]);

const GRADIENT_FUNCTIONS = new Set([
  "linear-gradient",
  "radial-gradient",
  "conic-gradient",
  "repeating-linear-gradient",
  "repeating-radial-gradient",
  "repeating-conic-gradient",
]);

const COLOR_COMPOSING_FUNCTIONS = new Set(["light-dark", "color-mix", "color-contrast"]);

const GRADIENT_HEADER_WORDS = new Set([
  "circle",
  "ellipse",
  "closest-corner",
  "closest-side",
  "farthest-corner",
  "farthest-side",
  "contain",
  "cover",
]);
const BACKGROUND_NON_COLOR_WORDS = new Set([
  "auto",
  "border-box",
  "bottom",
  "center",
  "content-box",
  "fixed",
  "left",
  "local",
  "no-repeat",
  "padding-box",
  "repeat",
  "repeat-x",
  "repeat-y",
  "right",
  "round",
  "scroll",
  "space",
  "text",
  "top",
]);

const NON_COLOR_FUNCTIONS = new Set(["url", "image-set", "-webkit-image-set"]);
const NON_AUTHORED_COLOR_KEYWORDS = new Set([
  "transparent",
  "currentcolor",
  "canvas",
  "canvastext",
  "linktext",
  "visitedtext",
  "activetext",
  "buttonface",
  "buttontext",
  "field",
  "fieldtext",
  "highlight",
  "highlighttext",
  "mark",
  "marktext",
  "graytext",
  "accentcolor",
  "accentcolortext",
  "selecteditem",
  "selecteditemtext",
]);

const COLOR_LONGHAND =
  /^(?:color|background-color|outline-color|text-decoration-color|caret-color|accent-color|fill|stroke|flood-color|lighting-color|stop-color|interpolation-color|marker|marker-start|marker-mid|marker-end|-webkit-text-fill-color|-webkit-text-stroke-color)$/i;
const COLOR_SHORTHAND =
  /^(?:background|border|border-(?:top|right|bottom|left|block|block-start|block-end|inline|inline-start|inline-end)|outline|text-decoration|column-rule|-webkit-text-stroke|box-shadow|text-shadow|border-image|border-image-source|background-image|mask-image|-webkit-mask-image)$/i;

function propertyKind(property) {
  const normalized = property.trim().toLowerCase();
  if (COLOR_LONGHAND.test(normalized)) return "longhand";
  if (/^(?:box-shadow|text-shadow)$/i.test(normalized)) return "shadow";
  if (
    /^border(?:-|$)|^(?:outline|text-decoration|column-rule|-webkit-text-stroke)$/i.test(normalized)
  ) {
    return "border-shorthand";
  }
  if (COLOR_SHORTHAND.test(normalized)) return "shorthand";
  return null;
}

export function isColorBearingProperty(property) {
  return propertyKind(property) !== null;
}

function isHex(node) {
  return node.type === "word" && /^#[\da-f]{3,8}$/i.test(node.value);
}

export function isRawColorNode(node, { colorNames } = {}) {
  if (isHex(node)) return true;
  if (node.type !== "word") return false;
  if (NON_AUTHORED_COLOR_KEYWORDS.has(node.value.toLowerCase())) return false;
  return (colorNames ?? new Set()).has(node.value.toLowerCase());
}

function isRawColorFunction(node) {
  return node.type === "function" && RAW_COLOR_FUNCTIONS.has(node.value.toLowerCase());
}

function isVariableFunction(node) {
  return node.type === "function" && node.value.toLowerCase() === "var";
}

function variableReference(node) {
  const variable = node.nodes?.find((child) => child.type === "word");
  if (!variable || !variable.value.startsWith("--")) return null;
  const commaIndex = node.nodes.findIndex((child) => child.type === "div" && child.value === ",");
  return {
    name: variable.value,
    hasFallback: commaIndex !== -1,
    node,
  };
}

function commaSegments(nodes) {
  const segments = [[]];
  for (const node of nodes) {
    if (node.type === "div" && node.value === ",") segments.push([]);
    else segments.at(-1).push(node);
  }
  return segments;
}

function significantNodes(nodes) {
  return nodes.filter((node) => node.type !== "space" && node.type !== "comment");
}

function isLengthOrPercentage(node) {
  return node.type === "word" && /^(?:-?(?:\d*\.)?\d+)(?:%|[a-z]+)?$/i.test(node.value);
}

function isBackgroundNonColorNode(node) {
  if (node.type === "word") {
    return BACKGROUND_NON_COLOR_WORDS.has(node.value.toLowerCase()) || isLengthOrPercentage(node);
  }
  return node.type === "function" && /^(?:calc|min|max|clamp)$/i.test(node.value);
}

function variableIsBackgroundColorPosition(reference, nodes) {
  const segment = commaSegments(nodes).find((items) => items.includes(reference.node)) ?? [];
  const significant = significantNodes(segment);
  const index = significant.indexOf(reference.node);
  if (index === -1) return false;
  if (significant.length === 1) return true;

  const slashIndex = significant.findIndex((node) => node.type === "div" && node.value === "/");
  if (slashIndex !== -1) {
    if (index < slashIndex) return false;
    // The first value after `/` is the background size. A later value after
    // repeat/box/attachment tokens is the optional background color.
    if (index === slashIndex + 1) return false;
    return significant.slice(slashIndex + 1, index).some(isBackgroundNonColorNode);
  }

  // A variable adjacent to a known position/repeat token is ambiguous: it
  // may be part of the image/position grammar, so do not claim a color role.
  const positionWords = new Set(["bottom", "center", "left", "right", "top"]);
  if (
    significant.some((node) => node.type === "word" && positionWords.has(node.value.toLowerCase()))
  ) {
    return false;
  }
  return significant.slice(0, index).some(isBackgroundNonColorNode);
}

function variableIsColorPosition(reference, kind, nodes) {
  if (kind === "longhand") return true;
  if (kind === "shorthand") return false;

  const segment = commaSegments(nodes).find((items) => items.includes(reference.node)) ?? [];
  const variables = segment.filter((node) => isVariableFunction(node));
  if (variables.length === 0) return false;
  const significant = segment.filter((node) => node.type !== "space");
  if (variables.length === 1) {
    return significant.length === 1 || significant.at(-1) === reference.node;
  }
  return variables.at(-1) === reference.node;
}

function isAngleNode(node) {
  return node.type === "word" && /^-?(?:\d*\.)?\d+(?:deg|grad|rad|turn)$/i.test(node.value);
}

function isGradientHeader(segment, functionName, colorNames) {
  const significant = significantNodes(segment);
  const first = significant[0];
  if (!first) return false;
  if (isRawColorNode(first, { colorNames }) || isRawColorFunction(first)) return false;
  if (COLOR_COMPOSING_FUNCTIONS.has(first.value?.toLowerCase())) return false;

  const normalizedName = functionName.toLowerCase();
  if (normalizedName.includes("linear")) {
    // A custom property in the first slot may be an angle/direction or a
    // color. Treat it as an ambiguous header; later stops remain provable.
    return (
      isVariableFunction(first) ||
      (first.type === "word" && (first.value.toLowerCase() === "to" || isAngleNode(first)))
    );
  }
  if (normalizedName.includes("radial")) {
    return (
      isVariableFunction(first) ||
      significant.some(
        (node) =>
          node.type === "word" &&
          (node.value.toLowerCase() === "at" ||
            GRADIENT_HEADER_WORDS.has(node.value.toLowerCase())),
      ) ||
      isLengthOrPercentage(first)
    );
  }
  if (normalizedName.includes("conic")) {
    return (
      isVariableFunction(first) ||
      significant.some(
        (node) => node.type === "word" && ["from", "at"].includes(node.value.toLowerCase()),
      ) ||
      isAngleNode(first)
    );
  }
  return false;
}

function isGradientColorCandidate(node) {
  return (
    node.type === "word" ||
    isVariableFunction(node) ||
    isRawColorFunction(node) ||
    (node.type === "function" && COLOR_COMPOSING_FUNCTIONS.has(node.value.toLowerCase()))
  );
}

function variableIsGradientColorPosition(reference, segment) {
  const significant = significantNodes(segment);
  const index = significant.indexOf(reference.node);
  if (index === -1) return false;
  if (index === 0) return true;

  // In a color-stop, a variable after an authored color (or another first
  // variable) is a stop position rather than a color. A first variable is
  // retained because `var()` is the only token that can represent the stop's
  // color. Untyped values that could be either remain an explicit grammar
  // boundary rather than being guessed.
  return !significant.slice(0, index).some(isGradientColorCandidate);
}

/**
 * Return only the values that are color-bearing under the small grammar this
 * harness supports. Custom properties and unknown functions are deliberately
 * excluded: their value grammar is supplied by a later consumer. Background
 * position/size slots and gradient headers are excluded; ambiguous first
 * gradient slots are left unproven rather than inferred as colors.
 *
 * `variables` contains var() calls in those positions. A reference with a
 * fallback is analysis-uncertain rather than a proven missing semantic role.
 */
export function colorValuePositions(declaration, { colorNames = new Set() } = {}) {
  const kind = propertyKind(declaration.prop);
  if (!kind) return { raw: [], variables: [], uncertain: false };

  const raw = [];
  const variables = [];
  const topLevelNodes = valueParser(declaration.value).nodes;
  const property = declaration.prop.trim().toLowerCase();
  const visitNodes = (nodes, context) => {
    for (const node of nodes) visit(node, context);
  };
  const visitGradient = (node) => {
    const segments = commaSegments(node.nodes ?? []);
    const hasHeader = isGradientHeader(segments[0] ?? [], node.value, colorNames);
    for (const [index, segment] of segments.entries()) {
      if (index === 0 && hasHeader) continue;
      visitNodes(segment, { kind: "gradient-stop", segment });
    }
  };
  const visit = (node, context = { kind }) => {
    if (node.type === "function") {
      if (NON_COLOR_FUNCTIONS.has(node.value.toLowerCase())) return;
      if (isVariableFunction(node)) {
        const reference = variableReference(node);
        const isColorPosition =
          reference &&
          (context.kind === "gradient-stop"
            ? variableIsGradientColorPosition(reference, context.segment)
            : context.kind === "background"
              ? variableIsBackgroundColorPosition(reference, topLevelNodes)
              : context.kind === "composed-color" ||
                variableIsColorPosition(reference, kind, topLevelNodes));
        if (isColorPosition) {
          variables.push(reference);
        }
        // A var() fallback is opaque to this bounded analysis. Inspecting its
        // nested value would turn an unproven fallback into a false finding.
        return;
      }
      if (isRawColorFunction(node)) {
        if (context.kind !== "image") raw.push(node);
        return;
      }
      if (GRADIENT_FUNCTIONS.has(node.value.toLowerCase())) {
        visitGradient(node);
        return;
      }
      if (COLOR_COMPOSING_FUNCTIONS.has(node.value.toLowerCase())) {
        visitNodes(node.nodes ?? [], { kind: "composed-color" });
        return;
      }
      // An unknown function has no established color grammar. Even in a
      // color shorthand, words inside it may be an arbitrary function token.
      return;
    }

    if (
      node.type === "word" &&
      [
        "longhand",
        "background",
        "shorthand",
        "border-shorthand",
        "shadow",
        "gradient-stop",
        "composed-color",
      ].includes(context.kind)
    ) {
      if (context.kind !== "image" && isRawColorNode(node, { colorNames })) raw.push(node);
    }
  };

  const rootKind =
    property === "background" ? "background" : property === "background-image" ? "image" : kind;
  visitNodes(topLevelNodes, { kind: rootKind });
  return { raw, variables, uncertain: false };
}

export function stringifyColorNode(node) {
  return valueParser.stringify(node);
}
