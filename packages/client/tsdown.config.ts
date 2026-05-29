import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./mod.ts"],
  format: "esm",
  dts: true,
  exports: true,
  fixedExtension: false,
  publint: true,
});
