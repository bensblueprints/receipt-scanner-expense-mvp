const { defineConfig } = require('vite');
const reactMod = require('@vitejs/plugin-react');
const tailwindMod = require('@tailwindcss/vite');
// CJS interop: these plugins ship ESM default exports
const react = reactMod.default || reactMod;
const tailwindcss = tailwindMod.default || tailwindMod;

module.exports = defineConfig({
  base: './', // built output is loaded via file:// by BrowserWindow.loadFile
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true }
});
