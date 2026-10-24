import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

const typescriptFiles = ["**/*.{ts,tsx,mts,cts}"];
const applicationTypeScript = ["packages/*/src/**/*.{ts,tsx}", "apps/desktop/src/**/*.{ts,tsx}", "apps/website/src/**/*.ts"];
// The editor engine stays behind one folder, so swapping or upgrading it touches nothing else.
const codeEditorFolder = "apps/desktop/src/renderer/src/components/code-editor";
const codeEditorFence = {
  patterns: [
    { regex: "^(codemirror|@codemirror/|@lezer/)", message: `CodeMirror is imported only in ${codeEditorFolder}/. Use CodeEditor from there.` },
    { regex: "(^|/)code-editor/.", message: `Import CodeEditor from ${codeEditorFolder}, not its files.` },
  ],
};

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/out/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/.astro/**",
      ".local-development/**",
      ".codegraph/**",
      ".promo-videos/**",
      "output/**",
      "licenses/vendor/**",
      "apps/website/public/licenses/**",
    ],
  },
  {
    files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
    rules: { "no-nested-ternary": "error", "no-control-regex": "error" },
    linterOptions: { reportUnusedDisableDirectives: "error" },
  },
  {
    files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
    ignores: [`${codeEditorFolder}/**`],
    rules: { "no-restricted-imports": ["error", codeEditorFence] },
  },
  {
    files: typescriptFiles,
    languageOptions: { parser: tseslint.parser },
    plugins: { "@typescript-eslint": tseslint.plugin },
  },
  {
    files: applicationTypeScript,
    languageOptions: {
      parserOptions: {
        project: ["packages/*/tsconfig.json", "apps/desktop/tsconfig.node.json", "apps/desktop/tsconfig.web.json", "apps/website/tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    files: ["apps/desktop/src/renderer/**/*.{ts,tsx}", "packages/client/src/**/*.ts", "scripts/fixtures/**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: { "react-hooks/rules-of-hooks": "error", "react-hooks/exhaustive-deps": "error" },
  },
  // The browser preview is a native view drawn above the whole window, so no z-index lifts a popup
  // over it. A portal mounts CoversPreview to swap the page for a still while it is open.
  {
    files: ["apps/desktop/src/renderer/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXElement[openingElement.name.property.name='Portal'][openingElement.name.object.name!='BaseTooltip']:not(:has(JSXIdentifier[name='CoversPreview']))",
          message: "Mount <CoversPreview /> inside this portal, or the browser preview draws over it.",
        },
      ],
    },
  },
  // Application projects already check unused declarations with TypeScript.
  // Standalone TypeScript fixtures/configuration do not belong to those projects.
  {
    files: ["**/scripts/**/*.{ts,tsx,mts,cts}", "**/*.config.{ts,mts,cts}"],
    rules: { "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }] },
  },
];
