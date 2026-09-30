import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 开发时:vite 起在 5173,把 /api 反代到 Node 服务(8787)。
// 生产时:server.js 直接发 dist/,不需要这层代理。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8787' },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
