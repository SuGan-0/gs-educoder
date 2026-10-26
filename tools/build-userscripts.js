'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { installEducoderPasteUnlock } = require('../userscript/lib/paste-unlock');
const { virtualTaskInfo } = require('../userscript/lib/virtual-task');

const ROOT = path.join(__dirname, '..');
const TARGETS = [
  'userscript/educoder-autosubmit.user.js',
  'userscript/educoder-paste-unlock.user.js'
];
const START = '  // BEGIN GENERATED: paste-unlock';
const END = '  // END GENERATED: paste-unlock';

function buildUserscripts({ check = false } = {}) {
  const block = `${START}\n  // Source: userscript/lib/paste-unlock.js; rebuild with npm run build:userscripts.\n`
    + installEducoderPasteUnlock.toString().replace(/\r\n/g, '\n').split('\n').map((line) => line ? `  ${line}` : '').join('\n')
    + `\n${END}`;
  const stale = [];
  for (const target of TARGETS) {
    const file = path.join(ROOT, target);
    const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const start = source.indexOf(START);
    const end = source.indexOf(END, start);
    if (start < 0 || end < 0) throw new Error(`${target}: missing generated block markers`);
    let next = source.slice(0, start) + block + source.slice(end + END.length);
    if (target.endsWith('educoder-autosubmit.user.js')) {
      const vmStart = '  // BEGIN GENERATED: virtual-task';
      const vmEnd = '  // END GENERATED: virtual-task';
      const from = next.indexOf(vmStart);
      const to = next.indexOf(vmEnd, from);
      if (from < 0 || to < 0) throw new Error(`${target}: missing virtual-task block markers`);
      const vmBlock = `${vmStart}\n  // Source: userscript/lib/virtual-task.js; rebuild with npm run build:userscripts.\n`
        + virtualTaskInfo.toString().replace(/\r\n/g, '\n').split('\n').map((line) => line ? `  ${line}` : '').join('\n')
        + `\n${vmEnd}`;
      next = next.slice(0, from) + vmBlock + next.slice(to + vmEnd.length);
    }
    if (source === next) continue;
    stale.push(target);
    if (!check) fs.writeFileSync(file, next, 'utf8');
  }
  return stale;
}

if (require.main === module) {
  const check = process.argv.includes('--check');
  const stale = buildUserscripts({ check });
  if (check && stale.length) {
    console.error(`Userscript bundles need rebuilding: ${stale.join(', ')}\nRun npm run build:userscripts.`);
    process.exitCode = 1;
  } else {
    console.log(check ? 'Userscript bundles are up to date.' : `Built ${stale.length} userscript(s).`);
  }
}

module.exports = { buildUserscripts };
