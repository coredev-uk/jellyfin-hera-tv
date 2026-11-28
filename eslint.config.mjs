// Lints the scripts the web client loads (web/*.js, which the bundler wraps) and the Dashboard
// pages' controllers (Configuration/*.js). Two things only, both about breaking quietly:
//   - no-undef and no-unused-vars: a misspelt name is a ReferenceError on one page, and a variable
//     nothing reads is usually a feature that stopped being wired up;
//   - hera/jellyfin-selectors: a selector for Jellyfin's markup written outside the JF map
//     (tests/lint/jellyfin-selectors.mjs).
import globals from "globals";
import jellyfinSelectors from "./tests/lint/jellyfin-selectors.mjs";

// What Jellyfin's web client puts on window for plugins' scripts.
const jellyfin = { ApiClient: "readonly", Dashboard: "readonly" };

const rules = {
  "no-undef": "error",
  "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
};

export default [
  { ignores: ["node_modules/**", "tests/**", "obj/**", "bin/**", "out/**", "assets/**", "web-legacy/**"] },
  {
    files: ["web/*.js"],
    plugins: { hera: { rules: { "jellyfin-selectors": jellyfinSelectors } } },
    languageOptions: { ecmaVersion: "latest", sourceType: "script", globals: { ...globals.browser, ...jellyfin } },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: { ...rules, "hera/jellyfin-selectors": "error" },
  },
  {
    files: ["Configuration/*.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: { ...globals.browser, ...jellyfin } },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules,
  },
];
