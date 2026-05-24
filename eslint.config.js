// ESLint flat config for Wild Talents 2e (Foundry VTT v14+)
export default [
  {
    files: ["scripts/**/*.js", "scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        // Foundry VTT globals
        game: "readonly",
        ui: "readonly",
        canvas: "readonly",
        CONFIG: "readonly",
        Hooks: "readonly",
        ChatMessage: "readonly",
        Actor: "readonly",
        Item: "readonly",
        Roll: "readonly",
        foundry: "readonly",
        FormDataExtended: "readonly",
        Handlebars: "readonly",
        Combat: "readonly",
        fromUuid: "readonly",
        // Browser globals
        console: "readonly",
        document: "readonly",
        setTimeout: "readonly",
        HTMLElement: "readonly",
        Event: "readonly",
        requestAnimationFrame: "readonly",
        process: "readonly"
      }
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-undef": "error",
      "no-var": "error",
      "prefer-const": "warn",
      "eqeqeq": ["error", "smart"],
      "no-eval": "error",
      // No jQuery
      "no-restricted-globals": ["error",
        { name: "$", message: "jQuery is not allowed. Use native DOM APIs." },
        { name: "jQuery", message: "jQuery is not allowed. Use native DOM APIs." }
      ],
      "no-restricted-properties": ["error",
        { object: "window", property: "$", message: "jQuery is not allowed." },
        { object: "window", property: "jQuery", message: "jQuery is not allowed." }
      ]
    }
  },
  {
    ignores: ["node_modules/", "packs/", "assets/"]
  }
];
