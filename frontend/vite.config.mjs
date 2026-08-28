import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    // This is a trusted local-network workstation app. Accept the machine IP
    // and local hostnames so another device on the same Wi-Fi can use it.
    allowedHosts: true,
    proxy: {
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
