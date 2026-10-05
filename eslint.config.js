import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["vendor/ws/"] },
  js.configs.recommended,
  {
    files: [
      "server/**/*.js",
      "test/**/*.js",
      "test/**/*.mjs",
      "3270/**/*.js",
      "3270/**/*.mjs",
      "scripts/*.mjs",
      "vendor/*.js",
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["public/**/*.js"],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    rules: {
      // Terminal escape sequences are the domain here.
      "no-control-regex": "off",
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
];
