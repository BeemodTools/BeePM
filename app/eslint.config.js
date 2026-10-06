import js from "@eslint/js"
import prettier from "eslint-config-prettier"
import reactHooks from "eslint-plugin-react-hooks"
import reactRefresh from "eslint-plugin-react-refresh"
import globals from "globals"

export default [
    { ignores: ["dist/", "release/"] },
    {
        files: ["src/**/*.{js,jsx}"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            globals: globals.browser,
            parserOptions: { ecmaFeatures: { jsx: true } },
        },
        plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
        rules: {
            ...js.configs.recommended.rules,
            ...reactHooks.configs.recommended.rules,
            // ESLint can't see JSX use of components, so capitalized names are skipped
            "no-unused-vars": [
                "error",
                { varsIgnorePattern: "^[A-Z_]", argsIgnorePattern: "^[A-Z_]" },
            ],
            "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
        },
    },
    {
        files: ["backend/**/*.js", "*.{js,mjs}"],
        languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: globals.node },
        rules: js.configs.recommended.rules,
    },
    {
        files: ["backend/**/*.cjs"],
        languageOptions: { ecmaVersion: "latest", sourceType: "commonjs", globals: globals.node },
        rules: js.configs.recommended.rules,
    },
    prettier,
]
