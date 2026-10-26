'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { safeFileName } = require('../extractor/lib/file-name');
const { safeName } = require('../extractor/lib/task-parser');
const { answerDirFor, safeFilePart } = require('../extractor/lib/answer-format');

test('存档路径：空白、点目录、控制字符和 Windows 保留名都有可写名称', () => {
  for (const value of ['', ' ', '.', '..', '...', '\0']) assert.equal(safeFileName(value), 'untitled');
  for (const value of ['CON', 'nul.sql', 'COM1', 'lpt9.txt']) assert.equal(safeFileName(value), `_${value}`);
  assert.equal(safeFileName('MySQL 插入.  '), 'MySQL 插入');
  assert.equal(safeFileName('实验\0一'), '实验 一');
  assert.equal(safeFileName('普通课程（2026）'), '普通课程（2026）');
});

test('存档路径：提取器与答案库保持各自的既有替换字符', () => {
  assert.equal(safeName('  数据库 / SQL  '), '数据库 SQL');
  assert.equal(safeFilePart('  数据库 / SQL  '), '数据库 ～ SQL');
  assert.equal(safeFileName('a/b', { replacement: '_' }), 'a_b');
});

test('存档路径：恶意课程名无法将文件写出预期的答案目录', () => {
  for (const root of ['E:\\exports', '/tmp/exports']) {
    const paths = root.includes(':') ? path.win32 : path.posix;
    for (const name of ['..', ' . . ', '../..', '..\\..', 'CON', '']) {
      const folder = paths.resolve(root, 'answers', safeFilePart(name));
      const relative = paths.relative(paths.resolve(root, 'answers'), folder);
      assert.ok(relative && relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative), name);
    }
  }
  assert.equal(path.relative(path.resolve('exports/answers'), answerDirFor('exports', { name: '..' })), 'untitled');
});
