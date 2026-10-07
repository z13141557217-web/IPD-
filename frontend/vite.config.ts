import { readFileSync } from "node:fs";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 版本号取自 package.json（Docker 构建时只能看到 frontend 目录）。
// 它必须与仓库根目录的 VERSION、backend/app/version.py 一致，后端测试会检查。
const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
) as { version: string };

// 开发时把 /api 转发给本机后端；生产环境由 nginx 做同样的转发。
export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: {
    port: 5173,
    proxy: { "/api": process.env.VITE_API_TARGET ?? "http://localhost:8000" },
  },
});
