// Workspace-wide ESLint (flat config). Every package's `lint` script runs `eslint .` from its
// own directory; flat-config discovery walks up to this file, so there is exactly one ruleset.
//
// Scope: syntax-level linting (typescript-eslint recommended). Type-AWARE rules
// (no-floating-promises etc.) need per-package project wiring and a slower pass — worth doing
// later, but the build's `tsc` already covers type errors.
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/out/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/next-env.d.ts",
      "**/*.config.{js,mjs,ts}",
      "infra/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // `_`-prefixed params/vars are the deliberate-ignore convention.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      // Repo style: interfaces + casts at IO boundaries use `any` sparingly but on purpose
      // (HTTP bodies, plugin payloads).
      "@typescript-eslint/no-explicit-any": "off",
      // node:test suites intentionally fire-and-forget some promises via `void`.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // Plain-JS utility scripts and .mjs test files run under Node. Browser tests also pass
    // small callbacks into the page (page.addInitScript), where `window` is real.
    files: ["scripts/**/*.mjs", "**/scripts/**/*.mjs", "**/test/**/*.mjs"],
    languageOptions: { globals: { ...globals.node, window: "readonly" } },
  },
  {
    // The panel's service worker (phone notifications) runs in a worker's own scope, not a page's.
    files: ["apps/panel/public/sw.js"],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
  {
    // React hooks correctness for the panel — deps-array mistakes are real bugs.
    files: ["apps/panel/**/*.tsx", "apps/panel/**/*.ts"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The panel's standing pattern is load-on-mount + reset-derived-state in effects; the
      // React-Compiler-era rewrite this rule wants (~46 sites) is tracked in the audit doc,
      // not smuggled into lint adoption.
      "react-hooks/set-state-in-effect": "off",
    },
  },
);
