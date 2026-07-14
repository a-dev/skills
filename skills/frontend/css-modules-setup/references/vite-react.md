# Vite + React reference adapter

Load this reference only for a Vite + React target.

## Dependencies

Install `vite-css-modules` as a development dependency. Install `classix` only when the project selects the reference `cx` helper and has no compatible class combiner.

Use the detected package manager and selected workspace package. Do not copy npm commands into pnpm, Yarn, or Bun projects.

## Merge the Vite configuration

The target shape is:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { patchCssModules } from "vite-css-modules";

export default defineConfig({
  css: {
    devSourcemap: true,
    modules: {
      localsConvention: "camelCaseOnly",
    },
  },
  plugins: [
    react(),
    patchCssModules({
      generateSourceTypes: true,
      declarationMap: true,
    }),
  ],
});
```

This is a merge target, not a replacement file.

Preserve:

- existing plugins and their order constraints;
- `css.modules` options such as `generateScopedName`;
- aliases and resolve conditions;
- server, build, test, and framework configuration;
- function-form and environment-dependent config shapes.

When `css.transformer` is `lightningcss`, configure CSS Modules through `css.lightningcss.cssModules` rather than `css.modules`.

## Declaration workflow

The CLI reads the Vite config and defaults to CSS Module globs under the resolved Vite root:

```sh
vite-css-modules
```

In a monorepo, run from the selected Vite app or pass `--config` explicitly.

Add a dedicated declaration-generation command and record it as `css:generate`. Record the TypeScript command that validates generated declarations as `css:types`; declarations must exist before it runs.

Do not overwrite an existing `prepare` script. Prefer a project-native aggregate check or compose lifecycle commands in the style already used by the repository.

Generated declarations may be committed or ignored. If ignored, fresh clones and CI must generate them before typechecking.

## Aliases

The selected alias must resolve:

- the bare shared entry point in TypeScript;
- subpaths such as the global stylesheet;
- external CSS `composes` paths when selected.

Keep Vite, TypeScript, and package import maps consistent. Verify alias and transform behavior through a CSS-specific fixture when the project has one.

## Global stylesheet

Import the selected global stylesheet exactly once from the application entry.

It declares the selected layer order and optional color-token imports. Theme mapping belongs to the layer selected for global base rules.

## Verification

Run the profile's CSS-harness commands and use a disposable reference component or existing style fixture. Do not run general application checks by default, and do not restyle production UI during setup.

If only a general application build can prove an alias or external `composes`, report that behavior as `not-verifiable`. The developer may choose to run the broader command, but it does not belong in the generic CSS profile.
