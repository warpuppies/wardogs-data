import { defineConfig } from "vitest/config";

// Load local settings (gitignored) so the live-install tests run without exporting variables.
// Variables already in the environment win over the file.
try {
  process.loadEnvFile(".env");
} catch {
  // No .env file: live tests skip themselves.
}

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
