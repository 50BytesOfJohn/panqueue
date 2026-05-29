import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./index.ts"],
  format: "esm",
  dts: true,
  exports: true,
  fixedExtension: false,
  publint: true,
});
