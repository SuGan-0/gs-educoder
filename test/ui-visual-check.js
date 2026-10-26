'use strict';

// 兼容旧视觉检查入口；统一使用真实本地服务的控制台浏览器测试。
// 新入口：npm run test:ui。避免维护另一套旧 UI 夹具与模块替换逻辑。
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const result = spawnSync(process.execPath, ['--test', path.join(__dirname, 'console-ui.browser.js')], {
  stdio: 'inherit', windowsHide: true
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status === null ? 1 : result.status;
