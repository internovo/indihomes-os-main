import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'url'

// root is pinned to this file's own directory (frontend/) so `vite` behaves
// the same whether it's invoked with cwd = repo root (via the --config flag
// in package.json) or from inside frontend/ directly.
const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root,
  plugins: [react()],
  build: {
    // preserves the original output location: previously root was the repo
    // root and output went to ./dist there. Now root is frontend/, so we
    // go one level up to land in the same place: <repo-root>/dist
    outDir: '../dist',
    emptyOutDir: true,
  },
})
