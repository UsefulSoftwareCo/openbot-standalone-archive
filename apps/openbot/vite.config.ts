import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineProject, type TestProjectInlineConfiguration } from "vite-plus/test/config";
import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

import { DEV_PROXIED_PATH_PREFIXES } from "@t3tools/shared/devProxy";

import pkg from "./package.json" with { type: "json" };

// OpenBot is a second single-origin client of the same T3 server. The dev
// server proxies the backend the same way apps/web does, so the session cookie
// issued for this host works here without a second pairing.
const port = Number(process.env.OPENBOT_PORT ?? process.env.PORT ?? 5735);
const backendPort = Number(process.env.T3CODE_PORT?.trim());
const devProxyTarget =
  Number.isInteger(backendPort) && backendPort > 0 ? `http://localhost:${backendPort}/` : undefined;

const unitTestProject = {
  extends: true,
  test: {
    name: "unit",
    include: ["src/**/*.test.{ts,tsx}"],
  },
} satisfies TestProjectInlineConfiguration;

export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  define: {
    "import.meta.env.APP_VERSION": JSON.stringify(pkg.version),
  },
  resolve: {
    tsconfigPaths: true,
    dedupe: ["react", "react-dom"],
  },
  server: {
    host: "localhost",
    port,
    strictPort: true,
    ...(devProxyTarget
      ? {
          proxy: Object.fromEntries(
            DEV_PROXIED_PATH_PREFIXES.map((prefix) => [
              prefix,
              {
                target: devProxyTarget,
                changeOrigin: true,
                ...(prefix === "/ws" ? { ws: true } : {}),
              },
            ]),
          ),
        }
      : {}),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    projects: [defineProject(unitTestProject)],
  },
}));
