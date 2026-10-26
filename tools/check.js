'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildUserscripts } = require('./build-userscripts');

const root = path.join(__dirname, '..');
const files = [];
function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (entry.name.endsWith('.js') && !entry.name.startsWith('probe-')) files.push(file);
  }
}
for (const folder of ['extractor', 'userscript', 'tools', 'test']) visit(path.join(root, folder));
let failures = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
  if (result.status === 0) continue;
  console.error(path.relative(root, file), result.stderr || result.error || 'Syntax check failed');
  failures++;
}
const stale = buildUserscripts({ check: true });
if (stale.length) {
  console.error(`Run npm run build:userscripts: ${stale.join(', ')}`);
  failures++;
}
console.log(`Checked ${files.length} JavaScript files; ${failures} failure(s).`);
process.exitCode = failures ? 1 : 0;
