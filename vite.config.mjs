import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const proxyTarget = process.env.RF_MONITOR_PROXY_TARGET ?? "http://127.0.0.1:8080";
const websocketTarget = proxyTarget.replace(/^http/, "ws");

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local", ".local"],
    proxy: {
      "/api": {
        target: proxyTarget,
        changeOrigin: false,
      },
      "/live": {
        target: websocketTarget,
        ws: true,
        changeOrigin: false,
      },
    },
    warmup: {
      clientFiles: ["./src/main.tsx"],
    },
  },
  plugins: [react()],
});
