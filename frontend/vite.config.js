import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // 编辑器写文件时会在同目录生成 ".文件名.<pid>.<uuid>.tmpdir/xxx.tmp"，
    // watcher 碰到被占用的临时文件会抛 EBUSY 直接崩掉 dev server，这里整体忽略。
    watch: {
      ignored: ['**/*.tmpdir/**', '**/.*.tmpdir/**'],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:3456',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  },
})
