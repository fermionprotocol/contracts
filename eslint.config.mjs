import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default [
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    languageOptions: {
      sourceType: "module",
      ecmaVersion: 2020,
    },
    rules: {
      "no-empty": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    ignores: [
      "**/libraries/**/*.ts",
      "artifacts/**/*.ts",
      "typechain-types/**",
      "submodules/**",
    ],
  },
];
