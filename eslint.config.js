import js from "@eslint/js";
import react from "eslint-plugin-react";
import hooks from "eslint-plugin-react-hooks";
import refresh from "eslint-plugin-react-refresh";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: ["dist/**", "node_modules/**", "*.config.js"],
  },
  {
    languageOptions: {
      ecmaVersion: "latest",
      globals: { ...globals.browser },
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
        project: "tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      react: {
        version: "detect",
      },
      componentWrapperFunctions: ["registerComponent"],
    },
  },
  { ignores: ["superblocks.d.ts"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  tseslint.configs.stylistic,
  react.configs.flat.recommended,
  react.configs.flat["jsx-runtime"],
  hooks.configs.flat["recommended-latest"],
  refresh.configs.vite,
  // Block Node.js globals in client code (they don't exist in browser)
  {
    files: ["client/**/*.ts", "client/**/*.tsx"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "process",
          message:
            "process is not available in browser. Use import.meta.env for environment variables.",
        },
        {
          name: "Buffer",
          message:
            "Buffer is a Node.js global. Use Uint8Array or similar browser APIs.",
        },
        {
          name: "__dirname",
          message:
            "__dirname is not available in browser. Use import.meta.url instead.",
        },
        {
          name: "__filename",
          message:
            "__filename is not available in browser. Use import.meta.url instead.",
        },
        {
          name: "global",
          message: "global is a Node.js global. Use globalThis instead.",
        },
        {
          name: "require",
          message:
            "require is not available in browser. Use ES modules (import/export).",
        },
      ],
    },
  },
  {
    // we disable @typescript-eslint/no-explicit-any because we are allowing use of any
    // for now because many things are not yet typed and we don't want end users
    // in their IDE to see these errors
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "all",
          argsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "@typescript-eslint/consistent-type-imports": "off",
      "@typescript-eslint/consistent-type-exports": "off",
      "@typescript-eslint/no-empty-object-type": "warn",
      "@typescript-eslint/no-empty-interface": "warn",
      "react/prop-types": "off",
      "react-refresh/only-export-components": [
        "error",
        { extraHOCs: ["registerComponent"] },
      ],
    },
  },
);
