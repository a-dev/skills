import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { checkProject, exitCodeForCheck } from "../scripts/check.mjs";

async function write(root, relativePath, contents) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
}

function profile(overrides = {}) {
  return {
    methodologyVersion: "1.0.0",
    profileSchemaVersion: 1,
    adapter: { name: "vite-react", version: "1.0.0" },
    appRoot: ".",
    stylesRoot: "src/styles",
    globalStylesheet: "src/styles/global.css",
    alias: { bare: "#styles", subpath: "#styles/*" },
    helpers: { classNames: "cx", cssVariables: "cssVars" },
    sharedApi: {
      entryPoint: "src/styles/index.ts",
      modules: [
        {
          name: "atoms",
          export: "atoms",
          path: "src/styles/atoms.module.css",
          layer: "atoms",
          publicClasses: ["stack"],
        },
      ],
      admissionRule: { strategy: "project-review" },
    },
    layers: {
      order: ["base", "atoms", "ui"],
      ownership: [{ glob: "src/styles/*.module.css", layer: "atoms" }],
      localModules: { strategy: "unlayered" },
    },
    composition: { mode: "composes" },
    colorTokens: {
      enabled: true,
      paletteFiles: ["src/styles/palette.css"],
      semanticFiles: ["src/styles/colors.css"],
      themeOwner: "src/theme.ts",
      themeAttribute: "data-theme",
      modes: ["system", "light", "dark"],
    },
    commands: {
      "css:generate": "npm run css:generate",
      "css:types": "npm run css:types",
      "css:check": "npm run css:check",
    },
    enforcement: {
      severity: "error",
      privateBooleanAttributes: ["data-loading"],
    },
    exceptions: [],
    ...overrides,
  };
}

async function createFixture({ invalid = false, overrides = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "css-modules-check-"));
  await write(root, ".agents/css-modules.json", `${JSON.stringify(profile(overrides), null, 2)}\n`);
  await write(root, "src/styles/global.css", "@layer base, atoms, ui;\n");
  await write(root, "src/styles/palette.css", ":root { --palette-blue-500: #2563eb; }\n");
  await write(
    root,
    "src/styles/colors.css",
    ":root { --color-action-bg: light-dark(var(--palette-blue-500), Canvas); }\n",
  );
  await write(root, "src/theme.ts", "export const themeOwner = true;\n");
  await write(
    root,
    "src/styles/index.ts",
    invalid
      ? "// atoms appears only in a comment.\nexport {};\n"
      : 'export { default as atoms } from "./atoms.module.css";\n',
  );
  await write(
    root,
    "src/styles/atoms.module.css",
    invalid
      ? "@layer ui { .stack { display: grid; } .extraClass { color: red; } }\n"
      : "@layer atoms { .stack { display: grid; } }\n",
  );
  await write(
    root,
    "src/button.module.css",
    invalid
      ? `.root h2, .badClass[aria-pressed] {
  color: #fff !important;
  background: var(--palette-blue-500);
  border-color: var(--color-missing);
}

.root[data-loading="true"] {
  opacity: 0.5;
}

[data-theme="dark"] .root {
  color: white;
}

.label {
  composes: missing from "#styles/missing.module.css";
}
`
      : `.root[aria-pressed="false"] {
  color: var(--color-action-bg);
}

.root[data-loading] .label {
  opacity: 0.5;
}

.label {
  composes: stack from "#styles/atoms.module.css";
}

:global(.thirdPartyClass) {
  display: block;
}
`,
  );
  await write(
    root,
    "src/button.tsx",
    invalid
      ? `import styles from "./button.module.css";
import { cx } from "#styles";

type ButtonProps = { loading: boolean; size: string };

export function Button({ loading, size }: ButtonProps) {
  return (
    <button
      disabled={loading}
      data-disabled={loading}
      data-loading={loading}
      className={cx(styles[\`size-${"${size}"}\`], loading && styles.loading)}
      style={{ opacity: loading ? 0.5 : 1 }}
    />
  );
}
`
      : `import styles from "./button.module.css";
import { cx, cssVars } from "#styles";

const SIZE_CLASS = { small: styles.root, large: styles.label };

type ButtonProps = { loading: boolean; size: keyof typeof SIZE_CLASS };

export function Button({ loading, size }: ButtonProps) {
  return (
    <button
      data-loading={loading || undefined}
      className={cx(styles.root, SIZE_CLASS[size])}
      style={cssVars({ "--_progress": loading ? 1 : 0 })}
    />
  );
}
`,
  );
  return root;
}

test("reports every objective TSX, CSS, and cross-file contract rule with stable IDs", async () => {
  const root = await createFixture({ invalid: true });

  try {
    const result = await checkProject({ root });
    const ids = new Set(result.findings.map(({ ruleId }) => ruleId));

    for (const id of [
      "css-modules/no-computed-key",
      "css-modules/no-boolean-state-class",
      "css-modules/custom-property-style-only",
      "css-modules/no-duplicate-state",
      "css-modules/data-boolean-presence",
      "css-modules/class-pattern",
      "css-modules/no-palette-in-component",
      "css-modules/no-raw-color-in-component",
      "css-modules/no-local-theme-selector",
      "css-modules/layer-by-profile",
      "css-modules/no-descendant-type",
      "css-modules/no-important",
      "css-modules/state-selector-shape",
      "css-modules/semantic-token-resolves",
      "css-modules/shared-entry-export",
      "css-modules/shared-public-class",
      "css-modules/composes-path-resolves",
    ]) {
      assert.ok(ids.has(id), `missing ${id}`);
    }

    assert.ok(result.findings.every(({ message }) => /\S/.test(message)));
    assert.equal(result.status, "failed");
    assert.equal(exitCodeForCheck(result), 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts a compliant project without inventing spacing or extraction policy", async () => {
  const root = await createFixture();

  try {
    const result = await checkProject({ root });

    assert.deepEqual(result.findings, []);
    assert.equal(result.status, "passed");
    assert.equal(exitCodeForCheck(result), 0);
    assert.doesNotMatch(JSON.stringify(result), /spacing|second.consumer/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a layer on a local module configured as unlayered", async () => {
  const root = await createFixture();

  try {
    const currentProfile = JSON.parse(
      await readFile(path.join(root, ".agents/css-modules.json"), "utf8"),
    );
    const unexpectedLayer = currentProfile.layers.order.at(-1);
    const moduleCss = await readFile(path.join(root, "src/button.module.css"), "utf8");
    await write(root, "src/button.module.css", `@layer ${unexpectedLayer} {\n${moduleCss}}\n`);

    const result = await checkProject({ root });
    const layerFinding = result.findings.find(
      ({ ruleId, file }) =>
        ruleId === "css-modules/layer-by-profile" && file === "src/button.module.css",
    );

    assert.equal(
      layerFinding?.message,
      `Expected an unlayered rule; found @layer ${unexpectedLayer}.`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports disagreement between a profiled fallback and an existing unmatched module", async () => {
  const fallbackLayer = "layer-a";
  const root = await createFixture({
    overrides: {
      layers: {
        order: ["base", "atoms", fallbackLayer],
        ownership: [{ glob: "src/styles/*.module.css", layer: "atoms" }],
        localModules: { strategy: "profiled", layer: fallbackLayer },
      },
    },
  });

  try {
    const result = await checkProject({ root });
    const layerFinding = result.findings.find(
      ({ ruleId, file }) =>
        ruleId === "css-modules/layer-by-profile" && file === "src/button.module.css",
    );

    assert.equal(
      layerFinding?.message,
      `Expected @layer ${fallbackLayer}; found an unlayered rule.`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supports warning-first migration and narrow, documented rule exceptions", async () => {
  const root = await createFixture({
    invalid: true,
    overrides: {
      enforcement: { severity: "warning", privateBooleanAttributes: ["data-loading"] },
      exceptions: [
        {
          kind: "rule",
          rule: "css-modules/custom-property-style-only",
          scope: "src/button.tsx",
          match: "opacity",
          reason: "Fixture integration owns this one computed value.",
        },
      ],
    },
  });

  try {
    const result = await checkProject({ root });

    assert.ok(result.findings.length > 0);
    assert.ok(result.findings.every(({ severity }) => severity === "warning"));
    assert.ok(
      !result.findings.some(
        ({ ruleId, message }) =>
          ruleId === "css-modules/custom-property-style-only" && message.includes("opacity"),
      ),
    );
    assert.equal(result.suppressed.length, 1);
    assert.equal(result.status, "warnings");
    assert.equal(exitCodeForCheck(result), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the checker is read-only", async () => {
  const root = await createFixture();

  try {
    const before = await readFile(path.join(root, "src/button.tsx"), "utf8");
    await checkProject({ root });
    const after = await readFile(path.join(root, "src/button.tsx"), "utf8");

    assert.equal(after, before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports ambiguous layer ownership instead of guessing the fallback layer", async () => {
  const root = await createFixture({
    overrides: {
      layers: {
        order: ["base", "atoms", "ui"],
        ownership: [
          { glob: "src/styles/*.module.css", layer: "atoms" },
          { glob: "src/**/*.module.css", layer: "ui" },
        ],
        localModules: { strategy: "unlayered" },
      },
    },
  });

  try {
    const result = await checkProject({ root });
    const ambiguous = result.findings.filter(
      ({ ruleId }) => ruleId === "css-modules/layer-ownership-ambiguous",
    );

    assert.ok(
      ambiguous.some(({ file }) => file === "src/styles/atoms.module.css"),
      "the doubly-owned shared module must be reported as ambiguous",
    );
    // The shared module declares the layer its profile entry records, so the
    // layer rule must not demand that the developer strip the wrapper.
    assert.deepEqual(
      result.findings.filter(
        ({ ruleId, file }) =>
          ruleId === "css-modules/layer-by-profile" && file === "src/styles/atoms.module.css",
      ),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts a shared export re-exported through a star specifier", async () => {
  const root = await createFixture();

  try {
    await write(
      root,
      "src/styles/exports.ts",
      'import atomsStyles from "./atoms.module.css";\nexport const atoms = atomsStyles;\n',
    );
    await write(root, "src/styles/index.ts", 'export * from "./exports";\n');

    const result = await checkProject({ root });

    assert.deepEqual(
      result.findings.filter(({ ruleId }) => ruleId === "css-modules/shared-entry-export"),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("separates a typed literal class key from a dynamic one", async () => {
  const root = await createFixture();

  try {
    await write(
      root,
      "src/literal-key.tsx",
      'import styles from "./button.module.css";\n\nexport const literal = styles["root"];\n',
    );
    await write(
      root,
      "src/dynamic-key.tsx",
      'import styles from "./button.module.css";\n\nexport const dynamic = (key: string) => styles[key];\n',
    );

    const result = await checkProject({ root });
    const computed = result.findings.filter(
      ({ ruleId }) => ruleId === "css-modules/no-computed-key",
    );

    // styles["root"] is checked by the generated declarations exactly like
    // styles.root; only the dynamic key escapes the type system.
    assert.deepEqual(
      computed.map(({ file }) => file),
      ["src/dynamic-key.tsx"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("judges descendant type selectors by the compound that owns them", async () => {
  const root = await createFixture();

  try {
    await write(
      root,
      "src/qualified.module.css",
      ".root h2.title {\n  color: var(--color-action-bg);\n}\n",
    );
    await write(
      root,
      "src/nested-list.module.css",
      ".root :is(h2, h3) {\n  color: var(--color-action-bg);\n}\n",
    );

    const result = await checkProject({ root });
    const descendants = result.findings.filter(
      ({ ruleId }) => ruleId === "css-modules/no-descendant-type",
    );

    assert.ok(
      !descendants.some(({ file }) => file === "src/qualified.module.css"),
      "h2.title already owns a role class",
    );
    assert.ok(
      descendants.some(({ file }) => file === "src/nested-list.module.css"),
      "a bare type inside :is() is still a bare descendant type",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("enforces presence-safe boolean expressions and verifies both rendered states", async () => {
  const root = await createFixture();

  try {
    await write(
      root,
      "src/presence-probe.tsx",
      `export function Presence({ loading }: { loading: boolean }) {
  return <>
    <div data-loading={loading || undefined} />
    <div data-loading={loading ? true : undefined} />
    <div data-loading={!loading ? undefined : true} />
    <div data-loading={true} />
    <div data-loading={null} />
    <div data-loading={undefined} />
    <div data-loading={loading ?? undefined} />
    <div data-loading={loading ? false : undefined} />
    <div data-loading={false} />
  </>;
}

export function ShadowedUndefined({ loading }: { loading: boolean }) {
  return function shadowed(undefined: string) {
    return <div data-loading={loading || undefined} />;
  };
}
`,
    );

    const result = await checkProject({ root });
    const presenceFindings = result.findings.filter(
      ({ ruleId, file }) =>
        ruleId === "css-modules/data-boolean-presence" && file === "src/presence-probe.tsx",
    );

    assert.equal(presenceFindings.length, 4);
    assert.equal(
      presenceFindings.filter(({ message }) => message.includes("data-loading")).length,
      4,
    );

    const render = (loading, value) =>
      renderToStaticMarkup(createElement("div", { "data-loading": value(loading) }));
    assert.match(
      render(true, (value) => value || undefined),
      /data-loading/,
    );
    assert.doesNotMatch(
      render(false, (value) => value || undefined),
      /data-loading/,
    );
    assert.match(
      render(true, (value) => (value ? true : undefined)),
      /data-loading/,
    );
    assert.doesNotMatch(
      render(false, (value) => (value ? true : undefined)),
      /data-loading/,
    );
    assert.match(
      render(true, (value) => (!value ? undefined : true)),
      /data-loading/,
    );
    assert.doesNotMatch(
      render(false, (value) => (!value ? undefined : true)),
      /data-loading/,
    );
    assert.match(
      render(false, (value) => value ?? undefined),
      /data-loading="false"/,
    );
    assert.doesNotMatch(
      render(false, (value) => (value ? false : undefined)),
      /data-loading/,
    );
    assert.match(
      render(true, (value) => (value ? false : undefined)),
      /data-loading="false"/,
    );
    assert.match(
      render(true, () => true),
      /data-loading/,
    );
    assert.doesNotMatch(
      render(true, () => null),
      /data-loading/,
    );
    assert.doesNotMatch(
      render(true, () => undefined),
      /data-loading/,
    );
    assert.match(
      render(true, () => false),
      /data-loading="false"/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checks complete layer ancestry and gives keyframes an at-rule diagnostic", async () => {
  const root = await createFixture();

  try {
    await write(
      root,
      "src/styles/atoms.module.css",
      "@layer unexpected { @layer atoms { .stack { display: grid; } } }\n",
    );
    let result = await checkProject({ root });
    const nestedLayer = result.findings.find(
      ({ ruleId, file }) =>
        ruleId === "css-modules/layer-by-profile" && file === "src/styles/atoms.module.css",
    );
    assert.equal(nestedLayer?.message, "Expected @layer atoms; found @layer unexpected.atoms.");

    await write(
      root,
      "src/styles/atoms.module.css",
      "@layer atoms { .stack { animation: spin 1s; } } @keyframes spin { to { opacity: 1; } }\n",
    );
    result = await checkProject({ root });
    assert.deepEqual(
      result.findings
        .filter(({ file }) => file === "src/styles/atoms.module.css")
        .map(({ ruleId }) => ruleId),
      ["css-modules/keyframes-layer-by-profile"],
    );

    await write(
      root,
      "src/styles/atoms.module.css",
      "@layer atoms { @layer foo { .stack { display: grid; } } }\n",
    );
    const dottedProfile = JSON.parse(
      await readFile(path.join(root, ".agents/css-modules.json"), "utf8"),
    );
    dottedProfile.sharedApi.modules[0].layer = "atoms.foo";
    dottedProfile.layers.ownership[0].layer = "atoms.foo";
    dottedProfile.layers.order = ["base", "atoms.foo", "ui"];
    await write(root, ".agents/css-modules.json", `${JSON.stringify(dottedProfile, null, 2)}\n`);
    result = await checkProject({ root });
    assert.deepEqual(
      result.findings.filter(({ file }) => file === "src/styles/atoms.module.css"),
      [],
    );

    await write(
      root,
      "src/styles/atoms.module.css",
      "@layer atoms { @layer foo { .stack { animation: spin 1s; } @keyframes spin { to { opacity: 1; } } } }\n",
    );
    result = await checkProject({ root });
    assert.deepEqual(
      result.findings.filter(({ file }) => file === "src/styles/atoms.module.css"),
      [],
    );

    await write(
      root,
      "src/styles/atoms.module.css",
      "@layer { @layer atoms.foo { .stack { display: grid; } } }\n",
    );
    result = await checkProject({ root });
    assert.equal(
      result.findings.find(
        ({ ruleId, file }) =>
          ruleId === "css-modules/layer-by-profile" && file === "src/styles/atoms.module.css",
      )?.message,
      "Expected @layer atoms.foo; found @layer <anonymous>.atoms.foo.",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recognizes raw colors only in bounded color-bearing value positions", async () => {
  const root = await createFixture();

  try {
    await write(
      root,
      "src/color-context.module.css",
      `.root {
  color: red;
  background: linear-gradient(to right, red, #fff);
  border: 1px solid rgb(0 0 0 / 50%);
  box-shadow: 0 0 2px hsl(0 0% 0%);
  outline: 1px solid tan;
  color: var(--color-action-bg);
  color: Canvas;
  color: transparent;
  color: currentColor;
  animation-name: red;
  grid-area: tan;
  font-family: black;
}
`,
    );

    const result = await checkProject({ root });
    const rawColors = result.findings.filter(
      ({ ruleId, file }) =>
        ruleId === "css-modules/no-raw-color-in-component" &&
        file === "src/color-context.module.css",
    );

    assert.equal(rawColors.length, 6);
    assert.ok(rawColors.every(({ message }) => !/Canvas|transparent|currentColor/.test(message)));
    assert.ok(rawColors.every(({ line }) => line <= 7));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps non-color background and gradient variables out of semantic checks", async () => {
  const root = await createFixture();

  try {
    await write(
      root,
      "src/gradient-context.module.css",
      `.root {
  background: var(--background-position) center / var(--background-size) no-repeat;
  background: center / cover no-repeat var(--missing-background-color);
  background: radial-gradient(circle at var(--gradient-position), var(--missing-gradient-color));
  background: conic-gradient(from var(--gradient-angle) at var(--conic-position), var(--missing-conic-color));
  background: linear-gradient(var(--linear-gradient-angle), var(--missing-linear-angle-color));
  background: linear-gradient(to right, var(--missing-linear-color) 20%);
  background: linear-gradient(to right, red var(--gradient-stop-position), var(--missing-stop-color));
}
`,
    );

    const result = await checkProject({ root });
    const missing = result.findings.filter(
      ({ ruleId, file }) =>
        ruleId === "css-modules/semantic-token-resolves" &&
        file === "src/gradient-context.module.css",
    );

    assert.deepEqual(
      missing.map(({ message }) => message.match(/--[\w-]+/)?.[0]),
      [
        "--missing-background-color",
        "--missing-gradient-color",
        "--missing-conic-color",
        "--missing-linear-angle-color",
        "--missing-linear-color",
        "--missing-stop-color",
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolves semantic color references in longhands and shorthands with honest fallbacks", async () => {
  const root = await createFixture();

  try {
    await write(
      root,
      "src/styles/colors.css",
      ":root { --color-action-bg: light-dark(var(--palette-blue-500), Canvas); --role-border: Canvas; }\n",
    );
    await write(
      root,
      "src/semantic-context.module.css",
      `.root {
  --_width: 1px;
  color: var(--role-foreground);
  background: var(--missing-background);
  border: var(--_width) solid var(--role-border);
  outline: var(--spacing-width) solid var(--role-border);
  border-color: var(--missing-border);
  box-shadow: 0 0 2px var(--missing-shadow);
  color: var(--missing-with-fallback, Canvas);
  padding: var(--spacing);
}
`,
    );

    const result = await checkProject({ root });
    const missing = result.findings.filter(
      ({ ruleId, file }) =>
        ruleId === "css-modules/semantic-token-resolves" &&
        file === "src/semantic-context.module.css",
    );
    assert.deepEqual(
      missing.map(({ message }) => message.match(/--[\w-]+/)?.[0]),
      ["--role-foreground", "--missing-background", "--missing-border", "--missing-shadow"],
    );
    assert.ok(!missing.some(({ message }) => message.includes("missing-with-fallback")));
    assert.ok(!missing.some(({ message }) => message.includes("spacing-width")));
    assert.ok(!missing.some(({ message }) => message.includes("spacing")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applies descendant ownership through native nesting and nested media", async () => {
  const root = await createFixture();

  try {
    await write(
      root,
      "src/nesting-context.module.css",
      `.root h2, .root :is(h3, h4), .root :where(h5, h6) { color: var(--color-action-bg); }
.root h2.title { color: var(--color-action-bg); }
.root {
  h2 { color: var(--color-action-bg); }
  & h3 { color: var(--color-action-bg); }
  & .title { color: var(--color-action-bg); }
  @media (min-width: 1px) {
    h4 { color: var(--color-action-bg); }
  }
}
:global(.markdown) h2 { color: var(--color-action-bg); }
:global(.markdown) { h2 { color: var(--color-action-bg); } }
`,
    );

    const result = await checkProject({ root });
    const descendants = result.findings.filter(
      ({ ruleId, file }) =>
        ruleId === "css-modules/no-descendant-type" && file === "src/nesting-context.module.css",
    );
    assert.equal(descendants.length, 8);
    assert.ok(!descendants.some(({ message }) => message.includes("h2.title")));
    assert.ok(!descendants.some(({ message }) => message.includes("markdown")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tracks imported helper and CSS bindings through aliases and public barrels", async () => {
  const root = await createFixture();

  try {
    await write(
      root,
      "src/bindings-context.tsx",
      `import localStyles from "./button.module.css";
import { cx as cls, cssVars as vars, atoms as atomStyles } from "#styles";
import * as styleApi from "#styles";

const bySize = { small: localStyles.root, large: localStyles.label } as const;

export function Bound({ loading, size }: { loading: boolean; size: keyof typeof bySize }) {
  return <div
    data-loading={loading || undefined}
    className={cls(
      loading && localStyles.loading,
      loading ? localStyles.root : localStyles.label,
      { [localStyles.loading]: loading },
      bySize[size],
      atomStyles.stack,
      styleApi.atoms.stack,
    )}
    style={vars({ "--_progress": loading ? 1 : 0 })}
  />;
}

export function Unrelated({ loading }: { loading: boolean }) {
  function cls(value: unknown) { return value; }
  return <div className={cls(loading && localStyles.loading)} />;
}
`,
    );

    const result = await checkProject({ root });
    const bindingFindings = result.findings.filter(
      ({ ruleId, file }) =>
        ["css-modules/no-boolean-state-class", "css-modules/custom-property-style-only"].includes(
          ruleId,
        ) && file === "src/bindings-context.tsx",
    );
    assert.equal(
      bindingFindings.filter(({ ruleId }) => ruleId === "css-modules/no-boolean-state-class")
        .length,
      3,
    );
    assert.equal(
      bindingFindings.filter(({ ruleId }) => ruleId === "css-modules/custom-property-style-only")
        .length,
      0,
    );
    assert.ok(
      !result.findings.some(
        ({ ruleId, file }) =>
          ruleId === "css-modules/no-boolean-state-class" && file === "src/bindings-context.tsx",
      ) || bindingFindings.length >= 3,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requires shared exports to retain CSS-module runtime provenance", async () => {
  const root = await createFixture();

  try {
    await write(root, "src/styles/other.module.css", "@layer atoms { .stack {} }\n");
    await write(root, "src/styles/index.ts", "export const atoms = 123;\n");
    let result = await checkProject({ root });
    assert.ok(result.findings.some(({ ruleId }) => ruleId === "css-modules/shared-entry-export"));

    await write(
      root,
      "src/styles/index.ts",
      'export { default as atoms } from "./other.module.css";\n',
    );
    result = await checkProject({ root });
    assert.ok(result.findings.some(({ ruleId }) => ruleId === "css-modules/shared-entry-export"));

    await write(
      root,
      "src/styles/exports.ts",
      'import atomsStyles from "./atoms.module.css";\nexport { atomsStyles as atoms };\n',
    );
    await write(root, "src/styles/index.ts", 'export * from "./exports";\n');
    result = await checkProject({ root });
    assert.ok(!result.findings.some(({ ruleId }) => ruleId === "css-modules/shared-entry-export"));

    await write(root, "src/styles/index.ts", 'export { atoms } from "./exports";\n');
    result = await checkProject({ root });
    assert.ok(!result.findings.some(({ ruleId }) => ruleId === "css-modules/shared-entry-export"));

    await write(
      root,
      "src/styles/first.ts",
      'export { default as atoms } from "./atoms.module.css";\n',
    );
    await write(
      root,
      "src/styles/second.ts",
      'export { default as atoms } from "./atoms.module.css";\n',
    );
    await write(
      root,
      "src/styles/index.ts",
      'export * from "./first";\nexport * from "./second";\n',
    );
    result = await checkProject({ root });
    assert.equal(result.status, "uncertain");
    assert.ok(!result.findings.some(({ ruleId }) => ruleId === "css-modules/shared-entry-export"));
    assert.ok(result.uncertainties.some(({ message }) => message.includes("provenance")));

    await write(
      root,
      "src/styles/index.ts",
      'export type { default as atoms } from "./atoms.module.css";\n',
    );
    result = await checkProject({ root });
    assert.ok(result.findings.some(({ ruleId }) => ruleId === "css-modules/shared-entry-export"));

    await write(root, "src/styles/index.ts", "export const atoms = runtimeAtoms;\n");
    result = await checkProject({ root });
    assert.equal(result.status, "uncertain");
    assert.ok(!result.findings.some(({ ruleId }) => ruleId === "css-modules/shared-entry-export"));
    assert.ok(
      result.uncertainties.some(({ ruleId }) => ruleId === "css-modules/shared-entry-export"),
    );

    await write(
      root,
      "src/styles/index.ts",
      'export * from "./exports";\nexport * from "./exports";\n',
    );
    result = await checkProject({ root });
    assert.equal(result.status, "uncertain");
    assert.ok(!result.findings.some(({ ruleId }) => ruleId === "css-modules/shared-entry-export"));
    assert.ok(result.uncertainties.some(({ message }) => message.includes("provenance")));

    await write(root, "src/styles/index.ts", 'export * as atoms from "./atoms.module.css";\n');
    result = await checkProject({ root });
    assert.equal(result.status, "uncertain");
    assert.ok(!result.findings.some(({ ruleId }) => ruleId === "css-modules/shared-entry-export"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retains export uncertainty when ordinary warnings are also present", async () => {
  const root = await createFixture({
    overrides: { enforcement: { severity: "warning", privateBooleanAttributes: ["data-loading"] } },
  });

  try {
    await write(root, "src/styles/index.ts", "export const atoms = runtimeAtoms;\n");
    await write(root, "src/warning.module.css", "@layer atoms { .warning { color: red; } }\n");

    const result = await checkProject({ root });

    assert.equal(result.status, "warnings");
    assert.ok(
      result.findings.some(({ ruleId }) => ruleId === "css-modules/no-raw-color-in-component"),
    );
    assert.ok(
      result.uncertainties.some(({ ruleId }) => ruleId === "css-modules/shared-entry-export"),
    );
    assert.equal(exitCodeForCheck(result), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
