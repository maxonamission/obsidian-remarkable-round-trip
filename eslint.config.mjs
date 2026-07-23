import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

export default tseslint.config(
	// eslint-plugin-obsidianmd exports `recommended` as a full flat-config
	// array (incl. typescript-eslint + the obsidianmd rules).
	...obsidianmd.configs.recommended,
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
			"@typescript-eslint/no-deprecated": "warn",
			// Proper nouns (reMarkable, PDF, rmfakecloud) break the
			// sentence-case heuristic; UI text is hand-kept in sentence case.
			"obsidianmd/ui/sentence-case": "off",
		},
	},
	{
		// Tests run under vitest/node, never inside an Obsidian window.
		files: ["src/__tests__/**/*.ts"],
		rules: {
			"obsidianmd/prefer-window-timers": "off",
			"obsidianmd/prefer-active-doc": "off",
		},
	},
	{
		ignores: ["main.js", "node_modules/"],
	},
);
