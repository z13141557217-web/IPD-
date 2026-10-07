import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 开发时把 /api 转发给本机后端；生产环境由 nginx 做同样的转发。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": process.env.VITE_API_TARGET ?? "http://localhost:8000" },
  },
});
