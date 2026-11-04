import { defineConfig } from "tsup";

// Workspace packages (@zeb/*) are TypeScript source: bundle them. Third-party deps stay external
// and are installed by `pnpm deploy --prod` in the runtime image.
export default defineConfig({
  entry: ["src/main.ts", "src/migrate.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: false,
  noExternal: [/^@zeb\//],
  external: ["@node-rs/argon2"],
});
