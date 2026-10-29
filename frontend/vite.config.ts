import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import moduleIcon from "./vite-icon";

// 页面挂在 /apps/builder/ 下；本地开发时把接口请求转给本机平台的网关（8080 端口）。
export default defineConfig({
  base: "/apps/builder/",
  plugins: [react(), moduleIcon()],
  server: {
    proxy: {
      "/api": "http://localhost:8080",
    },
  },
});
