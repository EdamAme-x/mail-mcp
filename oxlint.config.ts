import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

export default defineConfig({
  extends: [core],
  ignorePatterns: core.ignorePatterns,
  overrides: [
    {
      files: ["test/**/*.ts"],
      rules: {
        // Permission checks use bit masks; mocks deliberately accept malformed input.
        "no-bitwise": "off",
        "typescript/no-explicit-any": "off",
        "typescript/no-non-null-assertion": "off",
        // IMAP mocks implement the Node EventEmitter contract.
        "unicorn/prefer-event-target": "off",
      },
    },
  ],
  rules: {
    // Protocol dispatch and error classification include many explicit branches.
    complexity: ["error", 35],
    "func-style": ["error", "declaration", { allowArrowFunctions: true }],
    // Worker pools, stream readers and pagination require ordered awaits.
    "no-await-in-loop": "off",
    // Preserve byte-oriented protocol regexes and positional capture groups.
    "prefer-named-capture-group": "off",
    // Node callbacks and neverthrow ResultAsync are intentional I/O boundaries.
    "promise/avoid-new": "off",
    "promise/prefer-await-to-callbacks": "off",
    "promise/prefer-await-to-then": "off",
    // Async adapters preserve rejected-Promise semantics even without an await.
    "require-await": "off",
    "require-unicode-regexp": "off",
    "typescript/method-signature-style": ["error", "method"],
    "typescript/parameter-properties": [
      "error",
      { prefer: "parameter-property" },
    ],
    // Keep helpers close to their call sites and use named Node imports.
    "unicorn/consistent-function-scoping": "off",
    "unicorn/import-style": "off",
    "unicorn/no-await-expression-member": "off",
  },
});
