function ruleMeta(messages) {
  return {
    type: "problem",
    docs: { description: "Enforce the typed CSS Modules project contract." },
    schema: [],
    messages,
  };
}

function settings(context) {
  return context.settings?.cssModules ?? {};
}

function jsxName(attribute) {
  return attribute.type === "JSXAttribute" && attribute.name.type === "JSXIdentifier"
    ? attribute.name.name
    : undefined;
}

function expressionOf(attribute) {
  return attribute.value?.type === "JSXExpressionContainer"
    ? attribute.value.expression
    : attribute.value;
}

function resolveBinding(context, node) {
  if (node?.type !== "Identifier") return undefined;
  let scope = context.sourceCode.getScope(node);
  while (scope) {
    const variable = scope.set?.get(node.name);
    if (variable) return variable;
    scope = scope.upper;
  }
  return undefined;
}

function sharedSource(source, context) {
  const configured = settings(context).sharedApiSources ?? [];
  return configured.includes(source);
}

function importedName(specifier) {
  return specifier.imported?.name ?? specifier.imported?.value;
}

function bindingTracker(context) {
  const cssBindings = new Set();
  const cssNamespaces = new Set();
  const helperNamespaces = new Set();
  const sharedExports = new Set(settings(context).sharedCssModuleExports ?? []);
  const classHelper = settings(context).classNamesHelper ?? "cx";
  const variablesHelper = settings(context).cssVariablesHelper ?? "cssVars";
  const helperBindings = new Map([
    [classHelper, new Set()],
    [variablesHelper, new Set()],
  ]);

  function addBinding(set, node) {
    const variable = resolveBinding(context, node);
    if (variable) set.add(variable);
  }

  function addImportBinding(specifier, source) {
    if (specifier.type === "ImportDefaultSpecifier") {
      if (source.endsWith(".module.css")) addBinding(cssBindings, specifier.local);
      return;
    }
    if (specifier.type === "ImportNamespaceSpecifier") {
      if (source.endsWith(".module.css")) addBinding(cssNamespaces, specifier.local);
      if (sharedSource(source, context)) addBinding(helperNamespaces, specifier.local);
      return;
    }
    const name = importedName(specifier);
    if (!sharedSource(source, context)) return;
    if (sharedExports.has(name)) addBinding(cssBindings, specifier.local);
    if (name === classHelper) addBinding(helperBindings.get(classHelper), specifier.local);
    if (name === variablesHelper) addBinding(helperBindings.get(variablesHelper), specifier.local);
  }

  return {
    ImportDeclaration(node) {
      for (const specifier of node.specifiers) addImportBinding(specifier, node.source.value);
    },
    cssAccess(node) {
      if (node?.type !== "MemberExpression" || node.optional) return false;
      if (node.object?.type === "Identifier") {
        const binding = resolveBinding(context, node.object);
        return cssBindings.has(binding) || cssNamespaces.has(binding);
      }
      if (
        node.object?.type === "MemberExpression" &&
        !node.object.computed &&
        node.object.object?.type === "Identifier" &&
        node.object.property?.type === "Identifier" &&
        helperNamespaces.has(resolveBinding(context, node.object.object))
      ) {
        return sharedExports.has(node.object.property.name);
      }
      return false;
    },
    helperCall(node, helperName) {
      if (node?.type === "Identifier") {
        return helperBindings.get(helperName)?.has(resolveBinding(context, node)) ?? false;
      }
      return (
        node?.type === "MemberExpression" &&
        !node.computed &&
        node.object?.type === "Identifier" &&
        node.property?.type === "Identifier" &&
        node.property.name === helperName &&
        helperNamespaces.has(resolveBinding(context, node.object))
      );
    },
    cssBindings,
  };
}

function cssModuleTracker(context, visitor) {
  const tracker = bindingTracker(context);
  return { ImportDeclaration: tracker.ImportDeclaration, ...visitor(tracker) };
}

function isStringLiteralKey(node) {
  return (
    node?.type === "StringLiteral" || (node?.type === "Literal" && typeof node.value === "string")
  );
}

const noComputedKey = {
  meta: ruleMeta({
    computed: "Use an exhaustive typed lookup instead of a computed CSS Module key.",
  }),
  create(context) {
    return cssModuleTracker(context, (tracker) => ({
      MemberExpression(node) {
        if (!node.computed || !tracker.cssAccess(node)) return;
        // styles["root"] is checked against the generated declarations exactly
        // like styles.root; only a dynamic key escapes the type system.
        if (isStringLiteralKey(node.property)) return;
        context.report({ node, messageId: "computed" });
      },
    }));
  },
};

const noBooleanStateClass = {
  meta: ruleMeta({
    conditional:
      "Expose boolean state through its native, ARIA, library, or presence-based data attribute instead of a conditional CSS Module class.",
  }),
  create(context) {
    return cssModuleTracker(context, (tracker) => ({
      CallExpression(node) {
        const helper = settings(context).classNamesHelper ?? "cx";
        if (!tracker.helperCall(node.callee, helper)) return;
        for (const argument of node.arguments) {
          if (hasConditionalCssAccess(argument, tracker))
            context.report({ node: argument, messageId: "conditional" });
        }
      },
    }));
  },
};

function hasCssAccess(node, tracker) {
  if (!node || typeof node !== "object") return false;
  if (tracker.cssAccess(node)) return true;
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") {
      if (Array.isArray(value)) {
        if (value.some((child) => hasCssAccess(child, tracker))) return true;
      } else if (hasCssAccess(value, tracker)) return true;
    }
  }
  return false;
}

function hasConditionalCssAccess(node, tracker) {
  if (!node) return false;
  if (node.type === "LogicalExpression" && node.operator === "&&") {
    return hasCssAccess(node.right, tracker);
  }
  if (node.type === "ConditionalExpression") {
    return hasCssAccess(node.consequent, tracker) || hasCssAccess(node.alternate, tracker);
  }
  if (node.type === "ArrayExpression") {
    return node.elements.some((element) => hasConditionalCssAccess(element, tracker));
  }
  if (node.type === "ObjectExpression") {
    return node.properties.some(
      (property) =>
        property.type !== "SpreadElement" &&
        property.computed &&
        hasCssAccess(property.key, tracker),
    );
  }
  return false;
}

function propertyName(property) {
  if (property.type !== "ObjectProperty" && property.type !== "Property") return undefined;
  if (property.computed) return undefined;
  if (property.key.type === "Identifier") return property.key.name;
  if (property.key.type === "StringLiteral" || property.key.type === "Literal")
    return property.key.value;
  return undefined;
}

const customPropertyStyleOnly = {
  meta: ruleMeta({
    property:
      "Move the visual style {{name}} to CSS; application-owned runtime values must use the configured custom-property helper.",
    expression:
      "Move {{expression}} to CSS or record a narrow integration exception for this library-owned style object.",
  }),
  create(context) {
    const tracker = bindingTracker(context);
    return {
      ImportDeclaration: tracker.ImportDeclaration,
      JSXAttribute(node) {
        if (jsxName(node) !== "style") return;
        const expression = expressionOf(node);
        const helper = settings(context).cssVariablesHelper ?? "cssVars";
        if (
          expression?.type === "CallExpression" &&
          tracker.helperCall(expression.callee, helper)
        ) {
          return;
        }
        if (expression?.type !== "ObjectExpression") {
          context.report({
            node: expression ?? node,
            messageId: "expression",
            data: {
              expression: expression ? context.sourceCode.getText(expression) : "this visual style",
            },
          });
          return;
        }
        for (const property of expression.properties) {
          const name = propertyName(property);
          if (typeof name !== "string" || !name.startsWith("--_")) {
            context.report({
              node: property,
              messageId: "property",
              data: { name: typeof name === "string" ? `"${name}"` : "entry" },
            });
          }
        }
      },
    };
  },
};

const DUPLICATE_STATE = new Map([
  ["data-disabled", ["disabled", "aria-disabled"]],
  ["data-checked", ["checked", "aria-checked"]],
  ["data-selected", ["aria-selected"]],
  ["data-expanded", ["aria-expanded"]],
  ["data-pressed", ["aria-pressed"]],
  ["data-invalid", ["aria-invalid"]],
]);

const noDuplicateState = {
  meta: ruleMeta({
    duplicate: "Style {{semantic}} directly; {{privateState}} duplicates the same semantic state.",
  }),
  create(context) {
    return {
      JSXOpeningElement(node) {
        const attributes = new Map(
          node.attributes
            .map((attribute) => [jsxName(attribute), attribute])
            .filter(([name]) => name),
        );
        for (const [privateState, semanticSources] of DUPLICATE_STATE) {
          if (!attributes.has(privateState)) continue;
          const semantic = semanticSources.find((name) => attributes.has(name));
          if (semantic) {
            context.report({
              node: attributes.get(privateState),
              messageId: "duplicate",
              data: { privateState, semantic },
            });
          }
        }
      },
    };
  },
};

function isUndefinedLike(node, context) {
  if (node?.type === "NullLiteral" || (node?.type === "Literal" && node.value === null)) {
    return true;
  }
  if (node?.type !== "Identifier" || node.name !== "undefined") return false;
  const binding = resolveBinding(context, node);
  return !binding || binding.defs?.length === 0;
}

function literalPresence(node, context) {
  if (isUndefinedLike(node, context)) return "omitted";
  if (
    node?.type === "BooleanLiteral" ||
    (node?.type === "Literal" && typeof node.value === "boolean")
  ) {
    return node.value ? "present" : "false";
  }
  if (
    node?.type === "StringLiteral" ||
    node?.type === "NumericLiteral" ||
    (node?.type === "Literal" && ["string", "number"].includes(typeof node.value))
  ) {
    return "present";
  }
  return "unknown";
}

function presenceClassification(node, context) {
  const literal = literalPresence(node, context);
  if (literal !== "unknown") return literal;

  if (node?.type === "LogicalExpression" && node.operator === "||") {
    if (isUndefinedLike(node.right, context)) {
      const left = literalPresence(node.left, context);
      return left === "false" || left === "omitted" ? "omitted" : "safe";
    }
    return "unknown";
  }

  if (node?.type === "LogicalExpression" && node.operator === "??") {
    if (!isUndefinedLike(node.right, context)) return "unknown";
    const left = literalPresence(node.left, context);
    if (left === "false") return "false";
    if (left === "present") return "present";
    if (left === "omitted") return "omitted";
    return "unknown";
  }

  if (node?.type === "ConditionalExpression") {
    const consequent = presenceClassification(node.consequent, context);
    const alternate = presenceClassification(node.alternate, context);
    const branches = new Set([consequent, alternate]);
    if (branches.has("false") || branches.has("unknown") || branches.has("safe")) return "unknown";
    if (branches.has("omitted") && branches.has("present")) return "safe";
  }

  return "unknown";
}

function isPresenceExpression(node, context) {
  const classification = presenceClassification(node, context);
  return classification === "present" || classification === "omitted" || classification === "safe";
}

const dataBooleanPresence = {
  meta: ruleMeta({
    presence:
      "Render {{name}} as a presence attribute: omit it when false instead of serializing a boolean value.",
  }),
  create(context) {
    return {
      JSXAttribute(node) {
        const name = jsxName(node);
        const configured = settings(context).privateBooleanAttributes ?? ["data-loading"];
        if (!name || !configured.includes(name)) return;
        if (!isPresenceExpression(expressionOf(node), context)) {
          context.report({ node, messageId: "presence", data: { name } });
        }
      },
    };
  },
};

export const eslintRuleIds = [
  "no-computed-key",
  "no-boolean-state-class",
  "custom-property-style-only",
  "no-duplicate-state",
  "data-boolean-presence",
];

export default {
  meta: { name: "eslint-plugin-css-modules-contract", version: "1.0.0" },
  rules: {
    "no-computed-key": noComputedKey,
    "no-boolean-state-class": noBooleanStateClass,
    "custom-property-style-only": customPropertyStyleOnly,
    "no-duplicate-state": noDuplicateState,
    "data-boolean-presence": dataBooleanPresence,
  },
};
