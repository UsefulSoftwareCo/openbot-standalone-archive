import { defineConfig, mergeConfig } from "vite-plus";
import webConfig from "../web/vite.config";

// OpenBot uses T3's entry point, providers, settings, and route tree.
export default defineConfig(async (env) => {
  const base = typeof webConfig === "function" ? await webConfig(env) : await webConfig;
  return mergeConfig(
    { ...base, test: undefined },
    {
      root: `${import.meta.dirname}/../web`,
      define: { "import.meta.env.VITE_APP_PRODUCT": JSON.stringify("openbot") },
      optimizeDeps: { exclude: ["@phosphor-icons/react"] },
      server: { port: Number(process.env.OPENBOT_PORT ?? process.env.PORT ?? 5735) },
      test: {
        projects: [
          {
            extends: true,
            test: {
              name: "unit",
              include: [`${import.meta.dirname}/src/**/*.test.{ts,tsx}`],
            },
          },
        ],
      },
      build: { outDir: `${import.meta.dirname}/dist`, emptyOutDir: true },
    },
  );
});
