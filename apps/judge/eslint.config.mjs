import tseslint from "typescript-eslint";
import importX, { createNodeResolver } from "eslint-plugin-import-x";
import globals from "globals";

import airbnbBase from "../../eslint.airbnb-base.mjs";

export default [
  {
    // As ESLint 8 did: a directive that is no longer needed isn't reported
    linterOptions: { reportUnusedDisableDirectives: "off" }
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 2021,
        sourceType: "module",
        project: "tsconfig.json",
        tsconfigRootDir: import.meta.dirname
      },
      globals: { ...globals.node, ...globals.es2021 }
    },
    // import-x under the name of the plugin it replaces, so that rules keep their names
    plugins: { "@typescript-eslint": tseslint.plugin, import: importX },
    settings: {
      "import-x/parsers": { "@typescript-eslint/parser": [".ts"] },
      // As TypeScript resolves this CommonJS package's imports
      "import-x/resolver-next": [
        createNodeResolver({
          extensions: [".ts", ".d.ts", ".js", ".mjs", ".json", ".node"],
          conditionNames: ["types", "node", "require", "default"]
        })
      ],
      "import-x/extensions": [".ts", ".js", ".mjs"],
      "import-x/ignore": ["node_modules", "\\.(coffee|scss|css|less|hbs|svg|json)$"]
    },
    rules: {
      ...airbnbBase,

      "no-await-in-loop": "off",

      // Code style is controlled by Prettier, not ESLint.
      curly: "off",
      "no-confusing-arrow": "off",

      // Some rules in the preset is for JS only, we need the corresponding TS ones.
      "global-require": "off",
      "@typescript-eslint/no-var-requires": "error",
      "no-empty-function": ["error", { allow: ["constructors"] }],
      "no-dupe-class-members": "off",
      "@typescript-eslint/no-dupe-class-members": "error",
      "no-unused-vars": "off",
      // A caught error may go unused, as before typescript-eslint 8
      "@typescript-eslint/no-unused-vars": ["error", { caughtErrors: "none" }],
      "no-redeclare": "off",
      "@typescript-eslint/no-redeclare": "error",
      "no-return-await": "off",
      "@typescript-eslint/return-await": ["error", "always"],
      "no-shadow": "off",
      "@typescript-eslint/no-shadow": "error",
      "no-useless-constructor": "off",
      "@typescript-eslint/no-useless-constructor": "error",

      // `any` is evil. Use `unknown` instead.
      "@typescript-eslint/no-explicit-any": "error",

      // We organize almost everything to methods of the related classes since Nest.js's architecture.
      // It's fine for some methods not using any dependency class or member variables.
      "class-methods-use-this": "off",

      // Don't add the extra extensions in import filenames.
      "import/extensions": ["error", "never"],

      // Don't worry about import cycle as we use Nest.js DI.
      "import/no-cycle": "off",

      // Use a strict order for imports and enforce newlines between them.
      // But also allow manually added newlines to emphasize some special imports.
      "import/order": [
        "error",
        {
          groups: ["builtin", "external", "internal", "sibling"],
          pathGroupsExcludedImportTypes: [],
          "newlines-between": "always-and-inside-groups"
        }
      ],

      // import/export default is harmful: https://basarat.gitbook.io/typescript/main-1/defaultisbad.
      "import/prefer-default-export": "off",

      // This rule is too general. Putting related classes together helps reading the code.
      "max-classes-per-file": "off",

      // `else { if/return }` and `else if/return` are different in semantics.
      // "Lonely" is not a reason to change them.
      "no-else-return": "off",
      "no-lonely-if": "off",

      // Right use of `continue` will reduce code complexity -- they're sometimes better than too many `if`s.
      "no-continue": "off",

      // This rule doesn't have a "allow at the beginning of a function" option so it's hard to use.
      "no-param-reassign": "off",

      // Only language newbies will be confused by non-evil ++ and -- operators.
      "no-plusplus": "off",

      // Airbnb uses it to disallow for...in, for...of, with and labels.
      // But I use for...of since it's clearer than `Array.prototype.forEach()`.
      "no-restricted-syntax": "off", // Disable this ruleset
      "guard-for-in": "error", // Disallow for...in
      "no-with": "error", // Disallow with
      "no-labels": "error", // Disallow labels

      // It's NO problem to use before define
      "no-use-before-define": "off"
    }
  }
];
