const js = require("@eslint/js");
const globals = require("globals");

const commonRules = {
  "no-empty": ["error", { allowEmptyCatch: true }],
  "no-unused-vars": ["error", {
    argsIgnorePattern: "^_",
    caughtErrors: "none",
  }],
};

module.exports = [
  {
    ignores: ["node_modules/**", "backups/**", "coverage/**"],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.js", "test/**/*.js", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: globals.node,
    },
    rules: commonRules,
  },
  {
    files: ["public/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: {
        ...globals.browser,
        Chart: "readonly",
        Sortable: "readonly",
      },
    },
    rules: commonRules,
  },
];
