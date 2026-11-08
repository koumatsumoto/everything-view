import { cp, mkdir } from "node:fs/promises";
const target = "dist/web/assets/pdfjs";
await mkdir(target, { recursive: true });
for (const directory of ["cmaps", "standard_fonts", "wasm"])
  await cp(`node_modules/pdfjs-dist/${directory}`, `${target}/${directory}`, { recursive: true });
