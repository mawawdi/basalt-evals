import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const authoredJavaScript = ["**/*.{js,cjs,mjs}"];
const authoredNodeTypeScript = ["packages/**/*.ts", "scripts/**/*.ts", "test/**/*.ts"];
const authoredTypeScript = [...authoredNodeTypeScript, "apps/**/*.{ts,tsx}"];
const [typescriptBase, typescriptEslintRecommended, typescriptRecommended] =
  tseslint.configs.recommended;

export default [
  {
    ignores: [
      ".agents/**",
      ".basalt-evals/**",
      "dist/**",
      "node_modules/**",
      "**/.next/**",
      "**/next-env.d.ts",
      "plugin/BasaltEvalStudioPlugin.rbxmx",
    ],
  },
  {
    files: authoredJavaScript,
    ...eslint.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
  },
  {
    files: authoredTypeScript,
    languageOptions: {
      ...typescriptBase.languageOptions,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: typescriptBase.plugins,
    rules: {
      ...typescriptEslintRecommended.rules,
      ...typescriptRecommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: authoredNodeTypeScript,
    languageOptions: { globals: globals.node },
  },
  {
    files: ["apps/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
];
