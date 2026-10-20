import { createRequire } from "node:module";
import path from "node:path";

import stylex from "@stylexjs/unplugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { reviewTestAliases } from "../test-config";
import { stylexOptions } from "./stylex-options";

const require = createRequire(import.meta.url);

const mobileStylexOptions = {
  ...stylexOptions,
  lightningcssOptions: {
    ...stylexOptions.lightningcssOptions,
    targets: { safari: 17 << 16 },
  },
};

export default defineConfig({
  root: path.resolve(__dirname, "mobile"),
  base: "/",
  resolve: {
    alias: {
      ...reviewTestAliases,
      "@dev.fast/diffr": path.resolve(
        __dirname,
        "../../../diffr/diffr-ts/src/browser.ts",
      ),
      "decode-named-character-reference": path.join(
        path.dirname(require.resolve("decode-named-character-reference")),
        "index.js",
      ),
    },
  },
  plugins: [stylex.vite(mobileStylexOptions), react()],
  build: {
    target: "safari17",
    outDir: "../dist/mobile",
    emptyOutDir: true,
    assetsInlineLimit: 0,
  },
});
