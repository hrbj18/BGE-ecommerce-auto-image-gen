import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backendPort = process.env.RUOYI_SERVER_PORT || "18080";
const backendUrl = `http://127.0.0.1:${backendPort}`;

export default defineConfig({
  // RuoYi embeds the operator workbench at /workbench/. The self-service
  // portal is served at /portal/ on its own authenticated entry port.
  base: process.env.BGE_WORKBENCH_BASE || "/",
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    // This is a trusted local-network workstation app. Accept the machine IP
    // and local hostnames so another device on the same Wi-Fi can use it.
    allowedHosts: true,
    proxy: {
      "/portal-auth": { target: backendUrl, changeOrigin: true },
      "/portal-api": { target: backendUrl, changeOrigin: true },
      "/portal-media": {
        target: backendUrl,
        changeOrigin: true,
        rewrite: (path) => path
          .replace(/^\/portal-media\/o\//, "/portal-api/outputs/")
          .replace(/^\/portal-media\/e\//, "/portal-api/example-assets/"),
      },
      "/captchaImage": { target: backendUrl, changeOrigin: true },
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: true, xfwd: true },
      "/outputs": { target: "http://127.0.0.1:8787", changeOrigin: true, xfwd: true },
      "/example-assets": { target: "http://127.0.0.1:8787", changeOrigin: true, xfwd: true },
    },
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react()],
});
