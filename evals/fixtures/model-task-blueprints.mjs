const PROFILE =
  JSON.stringify(
    {
      format: "css-modules-compact",
      version: 1,
      preset: "vite-react@1",
      styles: { root: "src/shared/styles", alias: "#styles" },
      composition: "markup",
      colors: false,
      checks: "warn",
    },
    null,
    2,
  ) + "\n";

const BUTTON = `.root {\n  display: inline-flex;\n}\n`;
const BUTTON_TSX = `import styles from "./Button.module.css";\n\nexport function Button() {\n  return <button className={styles.root}>Save</button>;\n}\n`;

export const MODEL_TASK_BLUEPRINTS = Object.freeze({
  variant: {
    "README.md": "Profiled Button variant task.\n",
    ".agents/css-modules.json": PROFILE,
    "src/Button.tsx": BUTTON_TSX,
    "src/Button.module.css": BUTTON,
  },
  loading: {
    "README.md": "Profiled Button loading task with an existing browser fixture.\n",
    ".agents/css-modules.json": PROFILE,
    "src/Button.tsx": BUTTON_TSX.replace("Save", "Loading save"),
    "src/Button.module.css": BUTTON,
    "browser-tests/Button.spec.mjs":
      "// Existing browser entry is supplied by the target project.\n",
  },
  "custom-topology": {
    "README.md": "Preserve the custom #design topology.\n",
    ".agents/css-modules.json":
      JSON.stringify(
        {
          methodologyVersion: "1.0.0",
          profileSchemaVersion: 1,
          adapter: { name: "vite-react", version: "1.0.0" },
          appRoot: ".",
          stylesRoot: "src/design/styles",
          globalStylesheet: "src/design/styles/global.css",
          alias: { bare: "#design", subpath: "#design/*" },
          helpers: { classNames: "mergeClasses", cssVariables: "styleVariables" },
          sharedApi: {
            entryPoint: "src/design/index.ts",
            modules: [
              {
                name: "design",
                export: "design",
                path: "src/design/styles/core.module.css",
                layer: "ui",
                publicClasses: ["root"],
              },
            ],
            admissionRule: { strategy: "project-review" },
          },
          layers: {
            order: ["reset", "primitives", "ui"],
            ownership: [],
            localModules: { strategy: "unlayered" },
          },
          composition: { mode: "markup" },
          colorTokens: { enabled: false },
          commands: {
            "css:generate": "vite-css-modules",
            "css:types": "tsc --noEmit",
          },
          exceptions: [],
        },
        null,
        2,
      ) + "\n",
    "src/components/Card.module.css": BUTTON,
    "src/design/styles/global.css": "@layer reset, primitives, ui;\n",
    "src/design/styles/core.module.css": ".root { display: inline-flex; }\n",
    "src/design/index.ts": 'export { default as design } from "./styles/core.module.css";\n',
  },
  "unprofiled-adoption": {
    "README.md":
      "Repository convention: typed CSS Modules are adopted; no JSON profile has been selected.\n",
    "src/Card.tsx": `import styles from "./Card.module.css";\nexport function Card() { return <article className={styles.root}>Card</article>; }\n`,
    "src/Card.module.css": BUTTON,
  },
  "non-adoption": {
    "README.md": "Generic React project. No CSS Modules methodology adoption.\n",
    "src/Widget.tsx": `export function Widget() { return <div className="widget">Widget</div>; }\n`,
    "src/widget.css": ".widget { display: block; }\n",
  },
  "invalid-profile": {
    "README.md": "Invalid compact profile must block setup.\n",
    ".agents/css-modules.json":
      '{"format":"css-modules-compact","version":1,"preset":"unknown@9","styles":{"root":"src/shared/styles","alias":"#styles"}}\n',
  },
  migration: {
    "README.md": "Explicit legacy-to-compact migration.\n",
    ".agents/css-modules.json":
      JSON.stringify(
        {
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
            modules: [
              {
                name: "atoms",
                export: "atoms",
                path: "src/shared/styles/atoms.module.css",
                layer: "atoms",
                publicClasses: ["root"],
              },
            ],
            admissionRule: { strategy: "project-review" },
          },
          layers: {
            order: ["reset", "base", "atoms", "ui"],
            ownership: [],
            localModules: { strategy: "unlayered" },
          },
          composition: { mode: "markup" },
          colorTokens: { enabled: false },
          commands: {
            "css:generate": "vite-css-modules",
            "css:types": "tsc --noEmit",
          },
          exceptions: [],
        },
        null,
        2,
      ) + "\n",
    "src/shared/styles/index.ts": "export {};\n",
    "src/shared/styles/global.css": "@layer reset, base, atoms, ui;\n",
    "src/shared/styles/atoms.module.css": ".root { display: inline-flex; }\n",
  },
  "explicit-scale": {
    "README.md": "Written design decision: Button may use a 4px scale.\n",
    ".agents/css-modules.json": PROFILE,
    "src/Button.tsx": BUTTON_TSX,
    "src/Button.module.css": BUTTON,
    "src/styles/tokens.css": ":root { --space-1: 4px; }\n",
  },
  "missing-tools": {
    "README.md": "Profiled project with unavailable css:types command.\n",
    ".agents/css-modules.json": PROFILE,
    "src/Button.module.css": BUTTON,
  },
  "broader-verification": {
    "README.md": "Existing production build is the relevant alias/cascade evidence.\n",
    ".agents/css-modules.json": PROFILE,
    "src/component.module.css": BUTTON,
    "src/main.tsx": `import "#styles/global.css";\nimport styles from "./component.module.css";\nexport const className = styles.root;\n`,
  },
  "pre-existing-failure": {
    "README.md": "Baseline failure: src/legacy.tsx has a known unrelated type error.\n",
    ".agents/css-modules.json": PROFILE,
    "src/Button.tsx": BUTTON_TSX,
    "src/Button.module.css": BUTTON,
    "src/legacy.tsx": "export const broken: string = 1;\n",
  },
  "integration-exception": {
    "README.md": "Floating UI owns the inline geometry at the marked boundary.\n",
    ".agents/css-modules.json": PROFILE,
    "src/FloatingPanel.tsx": `export function FloatingPanel({ style }: { style?: Record<string, string> }) { return <div data-library-geometry style={style}>Panel</div>; }\n`,
    "src/FloatingPanel.module.css": BUTTON,
  },
  "fresh-setup": {
    "README.md": "Fresh Vite + React app. Bootstrap compact infrastructure with no shared class.\n",
    "package.json":
      JSON.stringify({ private: true, type: "module", scripts: { build: "vite build" } }, null, 2) +
      "\n",
    "src/main.tsx": "export function App() { return <main>Fresh app</main>; }\n",
  },
});
