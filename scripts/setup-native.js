// Dual-runtime native bindings for better-sqlite3.
// `npm test` runs under Node, `npm start` under Electron — different ABIs.
// This postinstall saves the Node binding, fetches the Electron prebuild, and vendors
// both; src/db.js picks the right one at runtime via the `nativeBinding` option.
// No-ops gracefully when Electron isn't installed.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const bs3 = path.join(root, 'node_modules', 'better-sqlite3');
const built = path.join(bs3, 'build', 'Release', 'better_sqlite3.node');
const vendor = path.join(root, 'vendor');
const nodeBinding = path.join(vendor, 'better_sqlite3-node.node');
const electronBinding = path.join(vendor, 'better_sqlite3-electron.node');

if (!fs.existsSync(built)) {
  console.log('[setup-native] better-sqlite3 binding not found, skipping');
  process.exit(0);
}
fs.mkdirSync(vendor, { recursive: true });
fs.copyFileSync(built, nodeBinding);

let electronVersion = null;
try {
  electronVersion = require(path.join(root, 'node_modules', 'electron', 'package.json')).version;
} catch {
  console.log('[setup-native] Electron not installed — Electron binding skipped.');
}

if (electronVersion) {
  try {
    execSync(`npx prebuild-install --runtime=electron --target=${electronVersion}`, { cwd: bs3, stdio: 'inherit' });
    fs.copyFileSync(built, electronBinding);
    console.log(`[setup-native] vendored Electron ${electronVersion} binding`);
  } catch (e) {
    console.warn('[setup-native] could not fetch Electron prebuild:', e.message);
  } finally {
    // restore the Node binding so `npm test` keeps working
    fs.copyFileSync(nodeBinding, built);
  }
}
console.log('[setup-native] done');
