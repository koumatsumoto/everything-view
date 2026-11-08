import { defineConfig } from "vite-plus";
export default defineConfig({
  root: "src/web",
  build: { outDir: "../../dist/web", emptyOutDir: true, assetsInlineLimit: 0 },
  pack: {
    entry: ["src/cli.ts"],
    outDir: "dist",
    format: "esm",
    platform: "node",
    target: "node24",
    clean: false,
    dts: false,
    sourcemap: false,
  },
  test: { root: ".", include: ["tests/**/*.test.ts"], testTimeout: 15000 },
  lint: { ignorePatterns: ["dist/**", "node_modules/**"] },
  fmt: { ignorePatterns: ["dist/**", "node_modules/**", "package-lock.json"] },
});
