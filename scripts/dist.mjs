import { execSync } from 'child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

const DIST_DIR = 'dist';
const PLUGIN_FILES = ['main.js', 'manifest.json', 'styles.css'];

const ZVEC_PLATFORMS = [
  'bindings-darwin-arm64',
  'bindings-linux-arm64',
  'bindings-linux-x64',
  'bindings-win32-x64',
];

// Clean and create dist directory
if (existsSync(DIST_DIR)) {
  rmSync(DIST_DIR, { recursive: true });
}
mkdirSync(DIST_DIR);

// Build
console.log('Building...');
execSync('node esbuild.config.mjs production', { stdio: 'inherit' });

// Copy plugin files
for (const file of PLUGIN_FILES) {
  if (existsSync(file)) {
    cpSync(file, join(DIST_DIR, file));
    console.log(`Copied ${file}`);
  }
}

// Copy zvec native bindings (all available platforms)
let copiedCount = 0;
for (const platform of ZVEC_PLATFORMS) {
  const src = join('node_modules', '@zvec', platform);
  if (!existsSync(src)) continue;
  const dest = join(DIST_DIR, 'node_modules', '@zvec', platform);
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
  console.log(`Copied native binding: ${platform}`);
  copiedCount++;
}

if (copiedCount === 0) {
  console.warn('Warning: no zvec native bindings found');
}

console.log(`\nDist ready: ./${DIST_DIR}/`);
console.log(
  "Copy the contents of this directory to your vault's " +
    '.obsidian/plugins/obsidian-sonar/ folder.'
);
