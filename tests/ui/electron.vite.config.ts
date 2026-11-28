import {defineConfig} from 'electron-vite'
import react from '@vitejs/plugin-react'
import {resolve} from 'node:path'
const root = process.cwd()
export default defineConfig({
    main: {build: {outDir: 'out/qa/main', rollupOptions: {input: resolve(root, 'tests/ui/main.ts')}}},
    preload: {build: {outDir: 'out/qa/preload', rollupOptions: {input: resolve(root, 'src/preload/index.ts')}}},
    renderer: {root: resolve(root, 'tests/ui'), plugins: [react()], build: {outDir: resolve(root, 'out/qa/renderer'), rollupOptions: {input: resolve(root, 'tests/ui/index.html')}}}
})
