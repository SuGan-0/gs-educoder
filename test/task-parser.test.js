'use strict';

// 离线测试：只依赖 node:test / node:assert，内联构造 payload，不读 exports/、不联网。
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  safeName,
  languageFromPath,
  makeMarkdown,
  makeExperimentDocument,
  makeLevelSection,
  classifyTask,
  levelId,
  answerSpec,
  answerFileName,
  normalizeAnswer,
  demoteHeadings,
  taskFromApi,
  detectImageExtension,
  normalizeImageSource
} = require('../extractor/lib/task-parser');

const COURSE = { name: 'Python 程序设计' };
const EXPERIMENT = { name: '实验一' };
const SOURCE = 'https://www.educoder.net/tasks/abc123';

// ---------------------------------------------------------------- safeName

test('safeName：非法字符替换为空格', () => {
  assert.equal(safeName('a\\b/c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
});

test('safeName：连续空白压成单空格并去首尾空白', () => {
  assert.equal(safeName('  第 1 关   任务\t\n 描述  '), '第 1 关 任务 描述');
});

test('safeName：空值/假值返回 untitled', () => {
  assert.equal(safeName(''), 'untitled');
  assert.equal(safeName(null), 'untitled');
  assert.equal(safeName(undefined), 'untitled');
  assert.equal(safeName(0), 'untitled');
  assert.equal(safeName(false), 'untitled');
});

test('safeName：纯空白输入（非假值）按 run.js 既有行为返回空串', () => {
  // 契约只说「空值/假值 → untitled」；纯空白是 truthy，现有实现 trim 后得到 ''。
  // 此处锁定既有行为，若改为 untitled 属于行为变更，需 Lead 决策。
  assert.equal(safeName('   '), '');
});

// -------------------------------------------------------- languageFromPath

test('languageFromPath：全部已知扩展名映射正确（16 个键，含 cpp 的三个别名）', () => {
  const expected = {
    '.py': 'python',
    '.java': 'java',
    '.c': 'c',
    '.cc': 'cpp',
    '.cpp': 'cpp',
    '.cxx': 'cpp',
    '.cs': 'csharp',
    '.go': 'go',
    '.js': 'javascript',
    '.ts': 'typescript',
    '.jsx': 'jsx',
    '.tsx': 'tsx',
    '.php': 'php',
    '.rb': 'ruby',
    '.rs': 'rust',
    '.sql': 'sql'
  };
  assert.equal(Object.keys(expected).length, 16, '契约映射表共 16 个扩展名键（含 .cc/.cpp/.cxx → cpp）');
  for (const [extension, language] of Object.entries(expected)) {
    assert.equal(languageFromPath(`main${extension}`), language, `main${extension}`);
  }
});

test('languageFromPath：大小写不敏感且支持目录路径', () => {
  assert.equal(languageFromPath('/src/pkg/Main.JAVA'), 'java');
  assert.equal(languageFromPath('a\\b\\script.PY'), 'python');
});

test('languageFromPath：未知扩展名、无扩展名、空值返回空串', () => {
  assert.equal(languageFromPath('notes.txt'), '');
  assert.equal(languageFromPath('Makefile'), '');
  assert.equal(languageFromPath('archive.tar.gz'), '');
  assert.equal(languageFromPath(''), '');
  assert.equal(languageFromPath(null), '');
  assert.equal(languageFromPath(undefined), '');
});

// ---------------------------------------------------- detectImageExtension

test('detectImageExtension：content-type 含 png → png', () => {
  assert.equal(detectImageExtension('image/png', 'AAAA'), 'png');
});

test('detectImageExtension：base64 以 iVBOR 开头 → png（content-type 不可用时）', () => {
  assert.equal(detectImageExtension('application/octet-stream', 'iVBORw0KGgoAAAANSUhEUg=='), 'png');
});

test('detectImageExtension：jpeg → jpg', () => {
  assert.equal(detectImageExtension('image/jpeg', '/9j/4AAQSkZJRg=='), 'jpg');
});

test('detectImageExtension：gif → gif', () => {
  assert.equal(detectImageExtension('image/gif', 'R0lGODlhAQABAAAAACw='), 'gif');
});

test('detectImageExtension：webp → webp', () => {
  assert.equal(detectImageExtension('image/webp', 'UklGRiQAAABXRUJQ'), 'webp');
});

test('detectImageExtension：认不出签名且 content-type 不是图片 → 空串（绝不能落盘成假图片）', () => {
  assert.equal(detectImageExtension('application/octet-stream', 'AAAA'), '');
  assert.equal(detectImageExtension('text/plain', ''), '');
  // 真实事故：服务端返回的是 41 字节的错误 JSON `{"status":-1,"message":"文件不存在"}`，
  // content-type 是 application/octet-stream，早期会兜底成 'bin' 并写成假图片文件。
  const errorJson = Buffer.from('{"status":-1,"message":"文件不存在"}', 'utf8').toString('base64');
  assert.equal(detectImageExtension('application/octet-stream', errorJson), '', '错误 JSON 不能被当成图片');
  const htmlError = Buffer.from('<!DOCTYPE html><html>404</html>', 'utf8').toString('base64');
  assert.equal(detectImageExtension('text/html', htmlError), '', '错误页面也不能被当成图片');
});

test('detectImageExtension：规则顺序优先 png 签名，再 jpeg/gif/webp', () => {
  // contentType 说是 jpeg，但 base64 是 PNG 签名 → 按规则 1 先命 png
  assert.equal(detectImageExtension('image/jpeg', 'iVBORw0KGgo='), 'png');
  // 非 png 的 jpeg：走规则 2
  assert.equal(detectImageExtension('image/jpeg', 'AAAA'), 'jpg');
});

// -------------------------------------------------- normalizeImageSource

test('normalizeImageSource：剥掉 markdown 图片的标题，只留 URL', () => {
  // 真实形态：平台正文是 `![ 酒店页面 ]( /api/attachments/1560519 "酒店页面" )`
  assert.equal(
    normalizeImageSource(' /api/attachments/1560519 "酒店页面" '),
    '/api/attachments/1560519',
    '带标题的写法必须只取 URL，否则请求会带上标题导致「文件不存在」'
  );
  assert.equal(normalizeImageSource("/a/b.png '标题'"), '/a/b.png');
  assert.equal(normalizeImageSource('/a/b.png (标题)'), '/a/b.png');
  assert.equal(normalizeImageSource('<https://cdn/a.png>'), 'https://cdn/a.png');
  assert.equal(normalizeImageSource('<https://cdn/a.png> "标题"'), 'https://cdn/a.png');
  assert.equal(normalizeImageSource('https://cdn/a.png'), 'https://cdn/a.png');
  assert.equal(normalizeImageSource('  '), '');
  assert.equal(normalizeImageSource(null), '');
});

test('normalizeImageSource：URL 内嵌了引号段时截断到引号前', () => {
  // 有些正文把标题粘进了 URL：/api/attachments/1560519"酒店页面"
  assert.equal(normalizeImageSource('/api/attachments/1560519"酒店页面"'), '/api/attachments/1560519');
});

test('makeLevelSection：正文图片带标题时也要替换成本地路径（BUG-034 回归）', () => {
  // 真实 payload：`![ 酒店页面 ]( /api/attachments/1560519 "酒店页面" )`
  const task = {
    taskIndex: 1,
    title: '人机交互',
    type: 'choice',
    taskDescription: '看图作答：\n![ 酒店页面 ]( /api/attachments/1560519 "酒店页面" )',
    choiceQuestions: [{ subject: '缺失的部分是什么？', options: ['A 地址'] }],
    imageMap: {
      // 键是规范化后的 URL（与 attachImages 落盘的键一致）
      '/api/attachments/1560519': 'assets/L001-image-1.png'
    }
  };
  const section = makeLevelSection(task);
  assert.match(section, /!\[酒店页面\]\(assets\/L001-image-1\.png\)/, `图片必须换成本地路径，实际：${section}`);
  assert.ok(!section.includes('"酒店页面"'), '产物里不应再出现 markdown 标题那一段');
  assert.ok(!section.includes('/api/attachments/'), '本地已有图时不应保留远程地址');
});

test('makeLevelSection：图片下载失败时保留规范化后的远程地址', () => {
  const task = {
    taskIndex: 2,
    title: '远程图',
    type: 'choice',
    taskDescription: '![图]( /api/attachments/999 "标题" )',
    choiceQuestions: [{ subject: '题干', options: ['A'] }],
    imageMap: {}
  };
  const section = makeLevelSection(task);
  assert.match(section, /!\[图\]\(\/api\/attachments\/999\)/, `应保留去掉标题的远程地址，实际：${section}`);
});

// ------------------------------------------------------------ taskFromApi

const codePayload = {
  homework_common_name: '实验一',
  challenge: {
    subject: '两数之和',
    homework_challenge_index: 2,
    with_code_file: true,
    path: 'main.py',
    // 注意：末节（其后既无 ### 标题也无 --- 行）按既有正则是抽不出来的，
    // 因此这里保留真实的「后面还有测试说明」形态（见「末节」专项测试）。
    task_pass: '### 任务描述\r\n\r\n读入两个整数。\r\n\r\n### 编程要求\r\n\r\n输出它们的和。\r\n\r\n### 测试说明\r\n\r\n样例一\r\n'
  }
};

test('taskFromApi：编程题的字段映射、小节抽取与 \\r\\n 归一化', () => {
  const task = taskFromApi(codePayload, COURSE, EXPERIMENT, SOURCE);
  assert.equal(task.title, '两数之和');
  assert.equal(task.level, '第2关_两数之和');
  assert.equal(task.type, 'code');
  assert.equal(task.taskDescription, '读入两个整数。');
  assert.equal(task.programmingRequirements, '输出它们的和。');
  assert.equal(task.starterCode, '');
  assert.equal(task.codeLanguage, 'python');
  assert.deepEqual(task.choices, []);
  assert.deepEqual(task.choiceQuestions, []);
  assert.equal(task.course, 'Python 程序设计');
  assert.equal(task.experiment, '实验一');
  assert.equal(task.source, SOURCE);
  assert.equal(task.taskIndex, 2);
  assert.ok(!task.taskDescription.includes('\r'), 'taskDescription 不应残留 \\r');
});

test('taskFromApi：小节以 #### 或 --- 为边界截断', () => {
  const task = taskFromApi({
    challenge: {
      subject: '小节边界',
      homework_challenge_index: 1,
      with_code_file: true,
      path: 'main.c',
      task_pass: '### 任务描述\n第一段\n#### 提示\n这段不属于任务描述\n---\n### 编程要求\n第二段\n---\n'
    }
  }, COURSE, EXPERIMENT, SOURCE);
  assert.equal(task.taskDescription, '第一段');
  assert.equal(task.programmingRequirements, '第二段');
});

test('taskFromApi：末节（其后无 ### 标题或 --- 行）必须抽取到正文', () => {
  // 历史上契约里的前瞻是 `(?=^#{3,}\s*|^---\s*$)`（无 |$），导致「目标小节是最后一节」
  // 时整节返回 ''，把末尾的编程要求（常常含图片）静默丢弃。
  // 契约已修正为 `(?=^#{3,}\s*|^---\s*$|$)`，本用例锁定修正后的行为。
  const lastSection = taskFromApi({
    challenge: { subject: 'x', with_code_file: true, path: 'main.py', task_pass: '### 任务描述\n读入。\n### 编程要求\n求。\n' }
  }, COURSE, EXPERIMENT, SOURCE);
  assert.equal(lastSection.type, 'code');
  assert.equal(lastSection.taskDescription, '读入。');
  assert.equal(lastSection.programmingRequirements, '求。', '末节无终止符时必须取到文末内容');

  // 末节末尾带图片时同样不能丢——这是真实产物里最常见的形态。
  const withImage = taskFromApi({
    challenge: {
      subject: 'x',
      with_code_file: true,
      path: 'main.py',
      task_pass: '### 任务描述\n读入。\n### 编程要求\n补充代码。\n\n<p><img src="/api/attachments/1" /></p>'
    }
  }, COURSE, EXPERIMENT, SOURCE);
  assert.equal(withImage.taskDescription, '读入。');
  assert.equal(
    withImage.programmingRequirements,
    '补充代码。\n\n<p><img src="/api/attachments/1" /></p>',
    '末节里的图片必须保留，后续才能被 attachImages 下载'
  );

  const onlySection = taskFromApi({
    challenge: { subject: 'x', with_code_file: true, path: 'main.py', task_pass: '### 任务描述\n只有这一节\n' }
  }, COURSE, EXPERIMENT, SOURCE);
  assert.equal(onlySection.taskDescription, '只有这一节');
  assert.equal(onlySection.programmingRequirements, '');

  // 末节后接 --- 或下一个 ### 标题时同样正常抽取（且不把 --- 后的内容算进来）
  const terminated = taskFromApi({
    challenge: { subject: 'x', with_code_file: true, path: 'main.py', task_pass: '### 任务描述\n读入。\n### 编程要求\n求。\n---\n### 测试说明\n不保存。' }
  }, COURSE, EXPERIMENT, SOURCE);
  assert.equal(terminated.taskDescription, '读入。');
  assert.equal(terminated.programmingRequirements, '求。');
});

test('taskFromApi：带序号的小节标题与「闯关要求」（真实变体）必须能解析', () => {
  // 真实 payload（软件工程导论 编程风格 / 高质量的代码）：标题带序号（`#### 1 任务描述`），
  // 且实际任务写在 `#### 3 闯关要求` 里。旧正则只认 `### 任务描述`，这两类实验的
  // 题干与要求会**整段丢失**（md 里只剩「作答格式」）。
  const text = [
    '[TOC]',
    '',
    '---',
    '',
    '#### 1 任务描述',
    '',
    '本关任务：本关考察学生对命名规范的掌握。',
    '',
    '#### 2 相关知识',
    '',
    '##### 2.1 命名基本要求',
    '',
    '（1）不能以下划线或美元符号开始或结束。',
    '',
    '#### 3 闯关要求',
    '',
    '**题目**：题目给出了一个类，其中类名的命名不规范。请修改。',
    '',
    '**对应知识点**： 类名使用大驼峰命名风格。',
    '',
    '---',
    '开始你的任务吧，祝你成功！'
  ].join('\n');
  const task = taskFromApi({
    challenge: { subject: '命名', with_code_file: true, path: 'src/step1/source.java', task_pass: text }
  }, COURSE, EXPERIMENT, SOURCE);
  assert.equal(task.type, 'code');
  assert.equal(task.taskDescription, '本关任务：本关考察学生对命名规范的掌握。');
  assert.match(
    task.programmingRequirements,
    /\*\*题目\*\*：题目给出了一个类/,
    '「闯关要求」必须归到编程要求，否则这一关没有任何可解的信息'
  );
  assert.ok(!task.taskDescription.includes('相关知识'), '「相关知识」等教学铺垫仍然必须丢弃');
});

test('taskFromApi：with_code_file=true 但无 ### 小节时 taskDescription 为空', () => {
  const task = taskFromApi({
    challenge: {
      subject: '只有正文',
      with_code_file: true,
      path: 'main.py',
      task_pass: '这是一段没有小节的说明文字。'
    }
  }, COURSE, EXPERIMENT, SOURCE);
  assert.equal(task.type, 'code');
  assert.equal(task.taskDescription, '');
  assert.equal(task.programmingRequirements, '');
});

test('taskFromApi：选择题（chooses 存在且 with_code_file=true）必须判为 choice，正文小节丢弃', () => {
  const task = taskFromApi({
    homework_common_name: '实验二',
    chooses: [
      {
        subject: '下列说法正确的是？',
        challenge_question: [
          { option_name: '甲选项' },
          { option_name: '乙选项' },
          { option_name: '丙选项' },
          { option_name: '丁选项' }
        ]
      }
    ],
    challenge: {
      subject: '单选题',
      homework_challenge_index: 1,
      with_code_file: true,
      path: 'main.c',
      task_pass: '### 任务描述\n\n这段文字必须被丢弃。\n\n### 编程要求\n\n这段也必须被丢弃。\n'
    }
  }, COURSE, EXPERIMENT, SOURCE);

  assert.equal(task.type, 'choice', 'chooses 存在时即使 with_code_file=true 也必须是 choice');
  assert.equal(task.taskDescription, '', '选择题的 taskDescription 必须为空');
  assert.equal(task.programmingRequirements, '', '选择题的 programmingRequirements 必须为空');
  assert.equal(task.choiceQuestions.length, 1);
  assert.deepEqual(task.choiceQuestions[0], {
    subject: '下列说法正确的是？',
    options: ['甲选项', '乙选项', '丙选项', '丁选项']
  });
  assert.equal(task.codeLanguage, 'c');
  assert.equal(task.level, '第1关_单选题');
});

test('taskFromApi：chooses 中 option_name 为空/纯空白要过滤，subject 为空或选项全空要丢弃整题', () => {
  const task = taskFromApi({
    chooses: [
      {
        subject: '  题一  ',
        challenge_question: [
          { option_name: ' 甲 ' },
          { option_name: '' },
          { option_name: '   ' },
          { option_name: null },
          {},
          { option_name: '乙' }
        ]
      },
      { subject: '   ', challenge_question: [{ option_name: '甲' }] },
      { subject: '题三', challenge_question: [] },
      { subject: '题四', challenge_question: 'not-an-array' },
      { subject: '题五', challenge_question: [{ option_name: ' ' }] },
      {}
    ],
    challenge: { subject: '多选题', with_code_file: false, task_pass: '' }
  }, COURSE, EXPERIMENT, SOURCE);

  assert.equal(task.type, 'choice');
  assert.equal(task.choiceQuestions.length, 1);
  assert.deepEqual(task.choiceQuestions[0], { subject: '题一', options: ['甲', '乙'] });
});

test('taskFromApi：chooses 缺失或非数组时 choiceQuestions 为空', () => {
  const noChooses = taskFromApi({
    challenge: { subject: 'x', with_code_file: true, path: 'a.py', task_pass: '### 任务描述\nA\n' }
  }, COURSE, EXPERIMENT, SOURCE);
  assert.deepEqual(noChooses.choiceQuestions, []);

  const choosesObject = taskFromApi({
    chooses: { subject: '不是数组' },
    challenge: { subject: 'x', with_code_file: true, path: 'a.py', task_pass: '' }
  }, COURSE, EXPERIMENT, SOURCE);
  assert.deepEqual(choosesObject.choiceQuestions, []);
  assert.equal(choosesObject.type, 'code');
});

test('taskFromApi：chooses 为空数组时不判为选择题', () => {
  const task = taskFromApi({
    chooses: [],
    challenge: { subject: 'x', with_code_file: true, path: 'a.py', task_pass: '### 任务描述\nA\n### 测试说明\nx\n' }
  }, COURSE, EXPERIMENT, SOURCE);
  assert.equal(task.type, 'code');
  assert.equal(task.taskDescription, 'A');
});

test('taskFromApi：缺失 subject 回退 homework_common_name，再缺失回退「未命名关卡」', () => {
  const fromCommonName = taskFromApi({
    homework_common_name: '作业总名',
    challenge: { subject: '', homework_challenge_index: 3, with_code_file: true, path: 'main.go' }
  }, COURSE, EXPERIMENT, SOURCE);
  assert.equal(fromCommonName.title, '作业总名');
  assert.equal(fromCommonName.level, '第3关_未命名');
  assert.equal(fromCommonName.taskIndex, 3);
  assert.equal(fromCommonName.codeLanguage, 'go');

  const fallback = taskFromApi({ challenge: {} }, COURSE, EXPERIMENT, SOURCE);
  assert.equal(fallback.title, '未命名关卡');
  assert.equal(fallback.level, '第关_未命名');
  // 白名单：既无代码文件路径也无选题的关卡判为 rejected（旧契约里是 text）。
  assert.equal(fallback.type, 'rejected');
  assert.equal(fallback.exportKind, 'rejected');
  assert.equal(fallback.taskDescription, '');
  assert.equal(fallback.taskIndex, 0);
});

test('taskFromApi（回归）：task_pass 为整段纯文本且非编程题 → rejected，正文原样保留', () => {
  const plain = '请阅读下面的说明。\n\n这是第二段，没有任何小节标题。';
  const task = taskFromApi({
    challenge: { subject: '阅读材料', with_code_file: false, path: '', task_pass: `\r\n${plain}\r\n` }
  }, COURSE, EXPERIMENT, SOURCE);
  // 非编程题、无选题的纯文本关卡（含虚拟机/图形化）一律抛弃，但解析结果仍保留正文供诊断。
  assert.equal(task.type, 'rejected');
  assert.equal(task.exportKind, 'rejected');
  assert.match(task.dropReason, /既非编程题也非选择题/);
  assert.equal(task.taskDescription, plain);
  assert.equal(task.programmingRequirements, '');
  assert.deepEqual(task.choices, []);
  assert.equal(task.codeLanguage, '');
});

test('taskFromApi（兼容）：正文行首枚举出的旧 choices 保留，并使 type=choice', () => {
  const task = taskFromApi({
    challenge: {
      subject: '老格式选择',
      with_code_file: false,
      task_pass: '请选择正确答案：\nA. 甲\nB. 乙\n1. 丙\n（C）丁\n'
    }
  }, COURSE, EXPERIMENT, SOURCE);
  assert.equal(task.type, 'choice');
  assert.deepEqual(task.choices, ['A. 甲', 'B. 乙', '1. 丙', '（C）丁']);
  assert.deepEqual(task.choiceQuestions, []);
  assert.equal(task.programmingRequirements, '');
});

// ----------------------------------------------------------- makeMarkdown

test('makeMarkdown：编程题输出「第N关」小节（元信息 + 小节 + 语言围栏 + 作答格式）', () => {
  const task = taskFromApi(codePayload, COURSE, EXPERIMENT, SOURCE);
  task.starterCode = 'print(1)';
  const markdown = makeMarkdown(task);
  assert.equal(
    markdown,
    [
      '## 第2关：两数之和',
      '',
      '- 关卡 id：L002',
      '- 题型：编程题（code）',
      `- 来源：${SOURCE}`,
      '',
      '### 任务描述',
      '',
      '读入两个整数。',
      '',
      '### 编程要求',
      '',
      '输出它们的和。',
      '',
      '### 初始代码',
      '',
      '```python',
      'print(1)',
      '```',
      '',
      '### 测试说明',
      '',
      '样例一',
      '',
      '### 作答格式',
      '',
      '```json',
      '{',
      '  "level_id": "L002",',
      '  "kind": "code",',
      '  "language": "python",',
      '  "answer": "完整代码（保留题目给的框架与 begin/end 标记）"',
      '}',
      '```',
      ''
    ].join('\n')
  );
  assert.ok(markdown.includes('### 测试说明\n\n样例一'), 'code 关卡保留测试说明小节');
});

test('makeMarkdown：无语言时围栏不标注语言，未填 starterCode 时不输出初始代码段', () => {
  const task = taskFromApi({
    challenge: { subject: '无扩展名', with_code_file: true, path: 'Makefile', task_pass: '### 任务描述\nA\n### 测试说明\nx\n' }
  }, COURSE, EXPERIMENT, SOURCE);
  assert.ok(!makeMarkdown(task).includes('### 初始代码'));

  task.starterCode = 'all:\n\techo hi';
  const markdown = makeMarkdown(task);
  assert.ok(markdown.includes('### 初始代码\n\n```\nall:\n\techo hi\n```'), markdown);
  assert.ok(!markdown.includes('```\n```'));

  // 引擎从 base64 解出的正文通常自带尾换行：围栏内会多出一个空行（既有行为，勿改）
  task.starterCode = 'all:\n\techo hi\n';
  assert.ok(makeMarkdown(task).includes('### 初始代码\n\n```\nall:\n\techo hi\n\n```'), makeMarkdown(task));
});

test('makeMarkdown：选择题只输出题干 + A./B./C./D. 三空格缩进选项，且无任务描述/编程要求/初始代码段', () => {
  const task = taskFromApi({
    chooses: [
      {
        subject: '第一题？',
        challenge_question: [
          { option_name: '甲' },
          { option_name: '乙' },
          { option_name: '丙' },
          { option_name: '丁' }
        ]
      },
      {
        subject: '第二题？',
        challenge_question: [
          { option_name: '戊' },
          { option_name: '己' }
        ]
      }
    ],
    challenge: {
      subject: '选择题',
      with_code_file: true,
      path: 'main.c',
      task_pass: '### 任务描述\n\n不应出现。\n\n### 编程要求\n\n也不应出现。\n'
    }
  }, COURSE, EXPERIMENT, SOURCE);
  task.starterCode = 'int main(){}';

  const markdown = makeMarkdown(task);
  assert.ok(markdown.includes([
    '### 选择题',
    '',
    '1. 第一题？',
    '   A. 甲',
    '   B. 乙',
    '   C. 丙',
    '   D. 丁',
    '',
    '2. 第二题？',
    '   A. 戊',
    '   B. 己'
  ].join('\n')), markdown);
  assert.ok(markdown.includes('- 题型：选择题（choice）'));
  assert.ok(!markdown.includes('### 任务描述'));
  assert.ok(!markdown.includes('### 编程要求'));
  assert.ok(!markdown.includes('### 选项'));
  // 选择题不得带初始代码：避免给 AI 错误的作答信号。
  assert.ok(!markdown.includes('### 初始代码'));
  assert.ok(!markdown.includes('int main'));
  assert.ok(!markdown.includes('不应出现'));
  assert.ok(!markdown.includes('也不应出现'));
  assert.ok(markdown.includes('"kind": "choice"'), '选择题必须给出对应的作答格式');
});

test('makeMarkdown：choiceQuestions 为空而 choices 非空时输出 ### 选项', () => {
  const task = taskFromApi({
    challenge: {
      subject: '老格式',
      with_code_file: false,
      task_pass: '请选择：\nA. 甲\nB. 乙\n'
    }
  }, COURSE, EXPERIMENT, SOURCE);
  const markdown = makeMarkdown(task);
  assert.ok(markdown.includes('### 选项\n\n1. A. 甲\n2. B. 乙'), markdown);
  assert.ok(!markdown.includes('### 选择题'));
});

test('makeMarkdown：空段落不输出（无小节时只剩标题、元信息与作答格式）', () => {
  const task = taskFromApi({
    challenge: { subject: '流程说明', with_code_file: false, task_pass: '只有正文。' }
  }, COURSE, EXPERIMENT, SOURCE);
  const markdown = makeMarkdown(task);
  // 非编程题/选择题（rejected）不进入产物，这里只锁定「空段落不输出」的渲染行为。
  assert.ok(markdown.startsWith('## 第?关：流程说明\n\n- 关卡 id：L流程说明'), markdown);
  assert.ok(markdown.includes('- 题型：其它（rejected）'));
  assert.ok(!markdown.includes('只有正文。'), 'rejected 关卡的正文不进入小节（不落盘）');
  assert.ok(!markdown.includes('### 任务描述'));
  assert.ok(!markdown.includes('### 编程要求'));
  assert.ok(!markdown.includes('### 选择题'));
  assert.ok(!markdown.includes('### 选项'));
  assert.ok(!markdown.includes('### 初始代码'));
  assert.ok(!markdown.includes('### 作答格式'), 'rejected 不给作答规范');
});

test('makeMarkdown：<p><img></p> 与裸 <img> 都按 imageMap 转成本地路径', () => {
  // 用 code 题承载图片渲染：非编程题/选择题的关卡会被白名单抛弃，不渲染正文。
  const task = taskFromApi({
    challenge: {
      subject: '图片题',
      with_code_file: true,
      path: 'main.py',
      task_pass: [
        '### 任务描述',
        '',
        '<p><img src="https://cdn.educoder.net/a.png" alt="图一"></p>',
        '',
        '下面是行内图片：<img src="https://cdn.educoder.net/b.png" width="200">',
        '',
        '没下载成功的：<img src="https://cdn.educoder.net/missing.png">'
      ].join('\n')
    }
  }, COURSE, EXPERIMENT, SOURCE);
  task.imageMap = {
    'https://cdn.educoder.net/a.png': 'assets/image-1.png',
    'https://cdn.educoder.net/b.png': 'assets/image-2.jpg'
  };

  const markdown = makeMarkdown(task);
  assert.ok(markdown.includes('![题目图片](assets/image-1.png)'), markdown);
  assert.ok(markdown.includes('![题目图片](assets/image-2.jpg)'), markdown);
  assert.ok(markdown.includes('![题目图片](https://cdn.educoder.net/missing.png)'), '未命中时应保留原地址');
  assert.ok(!markdown.includes('<img'), '所有 <img> 都必须转成 Markdown');
  assert.ok(!markdown.includes('<p>'), '<p><img></p> 的外层 <p> 不应残留');
});

test('makeMarkdown：图片内置（EDUCODER_INLINE_IMAGES）时 data URI 原样保留', () => {
  const task = taskFromApi({
    challenge: {
      subject: '图片题',
      with_code_file: true,
      path: 'main.py',
      task_pass: ['### 任务描述', '', '<img src="https://cdn.educoder.net/a.png" alt="图一">'].join('\n')
    }
  }, COURSE, EXPERIMENT, SOURCE);
  task.imageMap = { 'https://cdn.educoder.net/a.png': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' };
  const markdown = makeMarkdown(task);
  assert.ok(markdown.includes('![题目图片](data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==)'), markdown);
});

test('makeMarkdown：单引号 src、<p> 内换行 与 Markdown 图片语法都按 imageMap 替换', () => {
  const task = taskFromApi({
    challenge: {
      subject: '混合图片',
      with_code_file: true,
      path: 'main.c',
      task_pass: [
        '### 任务描述',
        '',
        "<p>\n  <img src='https://cdn.educoder.net/c.png'>\n</p>",
        '',
        '![自有说明](https://cdn.educoder.net/d.png)',
        '',
        '![](https://cdn.educoder.net/e.png)',
        '',
        '![未命中](https://cdn.educoder.net/f.png)'
      ].join('\n')
    }
  }, COURSE, EXPERIMENT, SOURCE);
  task.imageMap = {
    'https://cdn.educoder.net/c.png': 'assets/image-1.webp',
    'https://cdn.educoder.net/d.png': 'assets/image-2.png',
    'https://cdn.educoder.net/e.png': 'assets/image-3.gif'
  };

  const markdown = makeMarkdown(task);
  assert.ok(markdown.includes('![题目图片](assets/image-1.webp)'), markdown);
  assert.ok(markdown.includes('![自有说明](assets/image-2.png)'), markdown);
  assert.ok(markdown.includes('![题目图片](assets/image-3.gif)'), '空 alt 应回退为「题目图片」');
  assert.ok(markdown.includes('![未命中](https://cdn.educoder.net/f.png)'), '未命中时保留原地址与 alt');
  assert.ok(!markdown.includes('<img'));
});

test('makeMarkdown：选择题题干/选项里的图片也会被替换', () => {
  const task = taskFromApi({
    chooses: [
      {
        subject: '看图判断',
        challenge_question: [
          { option_name: '<p><img src="https://cdn.educoder.net/q1.png"></p>' },
          { option_name: '![示意图](https://cdn.educoder.net/q2.png)' }
        ]
      }
    ],
    challenge: { subject: '图片选择', with_code_file: false, task_pass: '' }
  }, COURSE, EXPERIMENT, SOURCE);
  task.imageMap = {
    'https://cdn.educoder.net/q1.png': 'assets/image-1.png',
    'https://cdn.educoder.net/q2.png': 'assets/image-2.png'
  };

  const markdown = makeMarkdown(task);
  assert.ok(markdown.includes('   A. ![题目图片](assets/image-1.png)'), markdown);
  assert.ok(markdown.includes('   B. ![示意图](assets/image-2.png)'), markdown);
});

test('makeMarkdown：imageMap 缺失时不抛错并保留原始地址', () => {
  const task = taskFromApi(codePayload, COURSE, EXPERIMENT, SOURCE);
  assert.equal(task.imageMap, undefined, 'taskFromApi 不负责填 imageMap（由引擎 attachImages 填充）');
  task.taskDescription = '<img src="https://cdn.educoder.net/x.png">';
  const markdown = makeMarkdown(task);
  assert.ok(markdown.includes('![题目图片](https://cdn.educoder.net/x.png)'), markdown);
});

// ------------------------------------------- 题型白名单 / 实验文件 / 作答格式

test('classifyTask：只有「有代码文件路径的编程题」与「有题干选项的选择题」被接受', () => {
  const code = taskFromApi(codePayload, COURSE, EXPERIMENT, SOURCE);
  assert.equal(classifyTask(code).kind, 'code');

  const choice = taskFromApi({
    chooses: [{ subject: '题', challenge_question: [{ option_name: '甲' }, { option_name: '乙' }] }],
    challenge: { subject: '选择', with_code_file: true, path: null, task_pass: '### 任务描述\nx' }
  }, COURSE, EXPERIMENT, SOURCE);
  assert.equal(classifyTask(choice).kind, 'choice');

  // 虚拟机/图形化形态：标记为代码题但没有代码文件路径 → 抛弃
  const vm = taskFromApi({
    challenge: { subject: '虚拟机实操', with_code_file: true, path: null, task_pass: '### 任务描述\n在虚拟机里启动服务。' }
  }, COURSE, EXPERIMENT, SOURCE);
  assert.equal(classifyTask(vm).kind, 'rejected');
  assert.match(vm.dropReason, /没有代码文件路径/);

  // 既无代码也无选题的纯文本关卡 → 抛弃
  const text = taskFromApi({
    challenge: { subject: '阅读', with_code_file: false, path: '', task_pass: '一段说明。' }
  }, COURSE, EXPERIMENT, SOURCE);
  assert.equal(classifyTask(text).kind, 'rejected');

  // 空壳关卡（没有任何正文）→ 抛弃
  const empty = taskFromApi({ challenge: {} }, COURSE, EXPERIMENT, SOURCE);
  assert.equal(classifyTask(empty).kind, 'rejected');
  assert.match(empty.dropReason, /没有可解答的题目正文/);
});

test('classifyTask：图形化/虚拟机题必须被抛弃（学画用例图、绘制程序流程图的真实形态）', () => {
  // 实测特征：with_code_file=true，但 code_editor 是**空对象**（没有代码环境），
  // path 指向「学员任务文件」这类工作目录而非源代码，mirror_name 是图形化工具。
  const useCaseDiagram = taskFromApi({
    mirror_name: ['Logisim/StarUML/VNC'],
    code_editor: {},
    challenge: {
      subject: '请根据系统案例分析来画出客户这个参与者',
      with_code_file: true,
      path: '学员任务文件/s；',
      homework_challenge_index: 1,
      task_pass: '### 任务描述\n请画出用例图。'
    }
  }, COURSE, EXPERIMENT, SOURCE);
  assert.equal(useCaseDiagram.exportKind, 'rejected', '不能当成编程题抓到产物里');
  assert.equal(useCaseDiagram.type, 'rejected');
  assert.match(useCaseDiagram.dropReason, /图形化\/虚拟机题/);
  assert.match(useCaseDiagram.dropReason, /StarUML/, '原因里要写明是什么环境，便于人工核对');

  // 另一种实测形态：path 是「工作目录/.gitkeep」（点文件，没有源代码扩展名）
  const flowChart = taskFromApi({
    mirror_name: ['Logisim/StarUML/VNC'],
    code_editor: {},
    challenge: {
      subject: '绘制程序流程图-认识StarUML',
      with_code_file: true,
      path: '程序流程图/学员任务文件/.gitkeep',
      homework_challenge_index: 1,
      task_pass: '### 任务描述\n绘制流程图。'
    }
  }, COURSE, EXPERIMENT, SOURCE);
  assert.equal(flowChart.exportKind, 'rejected');
  assert.match(flowChart.dropReason, /图形化\/虚拟机题/);
});

test('classifyTask：真编程题不受影响；缺 code_editor 字段不等于空环境', () => {
  const code = taskFromApi({
    code_editor: { shixun_environment_id: 1700583, name: 'Python3-torch1.4.0' },
    challenge: {
      subject: '卷积', with_code_file: true, path: 'padding/padding.py；',
      homework_challenge_index: 1, task_pass: '### 任务描述\nx'
    }
  }, COURSE, EXPERIMENT, SOURCE);
  assert.equal(code.exportKind, 'code');
  assert.equal(code.codeEditorEmpty, false);

  // 没给 code_editor 字段（undefined）时应按路径判定，不能被误伤
  const noEditorField = taskFromApi({
    challenge: {
      subject: '单元测试', with_code_file: true, path: 'src/step1/CalculatorTest.java',
      homework_challenge_index: 1, task_pass: '### 任务描述\nx'
    }
  }, COURSE, EXPERIMENT, SOURCE);
  assert.equal(noEditorField.codeEditorEmpty, false, '缺字段不等于空对象');
  assert.equal(noEditorField.exportKind, 'code');
});

test('classifyTask：有代码环境但 path 不是源文件（工作目录）同样抛弃', () => {
  const task = taskFromApi({
    code_editor: { name: 'Python3' },
    challenge: {
      subject: '画图', with_code_file: true, path: '某任务目录/answer',
      homework_challenge_index: 1, task_pass: '### 任务描述\nx'
    }
  }, COURSE, EXPERIMENT, SOURCE);
  assert.equal(task.exportKind, 'rejected');
  assert.match(task.dropReason, /不是源文件/);
});

test('taskFromApi：只保留 任务描述/编程要求/测试说明/作答要求，丢弃相关知识等教学铺垫', () => {
  const task = taskFromApi({
    challenge: {
      subject: '小节白名单',
      with_code_file: true,
      path: 'main.py',
      task_pass: [
        '### 任务描述',
        '做这件事。',
        '### 相关知识',
        '这一大段教学铺垫不应进入产物。',
        '#### 延伸阅读',
        '也不应进入。',
        '### 编程要求',
        '按格式输出。',
        '### 测试说明',
        '样例一。',
        '### 作答要求',
        '不要使用第三方库。'
      ].join('\n\n')
    }
  }, COURSE, EXPERIMENT, SOURCE);

  assert.equal(task.taskDescription, '做这件事。');
  assert.equal(task.programmingRequirements, '按格式输出。');
  assert.equal(task.testDescription, '样例一。');
  assert.equal(task.extraRequirements, '不要使用第三方库。');

  const markdown = makeMarkdown(task);
  assert.ok(markdown.includes('### 测试说明\n\n样例一。'), markdown);
  assert.ok(markdown.includes('### 作答要求\n\n不要使用第三方库。'), markdown);
  assert.ok(!markdown.includes('教学铺垫'), '相关知识必须被丢弃');
  assert.ok(!markdown.includes('延伸阅读'));
});

test('makeExperimentDocument：frontmatter + 逐关小节 + --- 分隔', () => {
  const first = taskFromApi(codePayload, COURSE, EXPERIMENT, 'https://www.educoder.net/tasks/a');
  const second = taskFromApi({
    chooses: [{ subject: '选一选', challenge_question: [{ option_name: '甲' }, { option_name: '乙' }] }],
    challenge: { subject: '选择题', homework_challenge_index: 3, with_code_file: false, path: '', task_pass: '' }
  }, COURSE, EXPERIMENT, 'https://www.educoder.net/tasks/b');
  const document = makeExperimentDocument({
    course: 'Python 程序设计',
    experiment: '实验一',
    generatedAt: '2026-09-25T00:00:00.000Z',
    levels: [first, second]
  });

  assert.ok(document.startsWith([
    '---',
    'course: Python 程序设计',
    'experiment: 实验一',
    'levels: 2',
    'generated_at: 2026-09-25T00:00:00.000Z',
    'answer_file: answers/Python 程序设计__实验一.answers.json',
    '---',
    '',
    '# 实验一',
    ''
  ].join('\n')), document);
  assert.equal(document.match(/^## 第\d+关：/gm).length, 2, '两关各一节');
  assert.ok(document.includes('\n\n---\n\n'), '关卡之间用 --- 分隔');
  assert.ok(document.indexOf('## 第2关') < document.indexOf('## 第3关'), '顺序按传入顺序');
  assert.match(document, /answers\/Python 程序设计__实验一\.answers\.json/, '要明确告诉 AI 答案写哪个文件');
  assert.ok(document.endsWith('\n'));
});

test('makeExperimentDocument：允许传入已渲染的小节文本（增量合并时原样保留）', () => {
  const document = makeExperimentDocument({
    course: 'C',
    experiment: 'E',
    generatedAt: 'T',
    levels: ['## 第1关：旧关\n\n- 关卡 id：L001\n\n### 任务描述\n\n历史内容。']
  });
  assert.match(document, /^---\ncourse: C\nexperiment: E\nlevels: 1\ngenerated_at: T\nanswer_file: answers\/C__E\.answers\.json\n---/m);
  assert.ok(document.includes('历史内容。'));
});

test('answerFileName：课程与实验都写进文件名，非法字符被替换', () => {
  assert.equal(answerFileName('机器学习_2026年下半年', 'CNN'), '机器学习_2026年下半年__CNN');
  assert.equal(answerFileName('软件开发/导论', '单元:测试'), '软件开发～导论__单元～测试');
  assert.equal(answerFileName('', ''), 'untitled__untitled');
});

test('answerSpec：编程题给「关卡 id + 代码」，选择题给「关卡 id + 选项字母」，不要求理由', () => {
  const code = taskFromApi(codePayload, COURSE, EXPERIMENT, SOURCE);
  assert.equal(levelId(code), 'L002');
  const codeSpec = answerSpec(code);
  assert.ok(codeSpec.includes('"kind": "code"'));
  assert.ok(codeSpec.includes('"level_id": "L002"'));
  assert.ok(codeSpec.includes('"language": "python"'));
  assert.ok(!codeSpec.includes('explain'), '格式要最小化：不要理由字段');

  const choice = taskFromApi({
    chooses: [{ subject: '题', challenge_question: [{ option_name: '甲' }, { option_name: '乙' }] }],
    challenge: { subject: '选择', homework_challenge_index: 7, with_code_file: false, path: '', task_pass: '' }
  }, COURSE, EXPERIMENT, SOURCE);
  assert.equal(levelId(choice), 'L007');
  assert.equal(classifyTask(choice).kind, 'choice');
  const spec = answerSpec(choice);
  assert.ok(spec.includes('"kind": "choice"'));
  assert.ok(spec.includes('"answer": "A"'), '单选题直接给字母，不要数组和题号');
  assert.ok(!spec.includes('brief'), '格式要最小化：不要理由字段');

  // 多个小问时才要求题号（用 "1:A;2:B,D" 这种紧凑写法）
  const multi = taskFromApi({
    chooses: [
      { subject: '第一题？', challenge_question: [{ option_name: '甲' }, { option_name: '乙' }] },
      { subject: '第二题？', challenge_question: [{ option_name: '甲' }, { option_name: '乙' }] }
    ],
    challenge: { subject: '多问选择', homework_challenge_index: 8, with_code_file: false, path: '', task_pass: '' }
  }, COURSE, EXPERIMENT, SOURCE);
  const multiSpec = answerSpec(multi);
  assert.ok(multiSpec.includes('"answer": "1:A;2:B,D"'), multiSpec);
});

test('normalizeAnswer：把最简写法规范化成篡改猴可直接用的结构', () => {
  // 编程题
  const code = normalizeAnswer('L001', { kind: 'code', language: 'python', answer: 'print(1)' });
  assert.deepEqual(code, { level_id: 'L001', kind: 'code', source: '', language: 'python', answer: 'print(1)' });

  // 单选：直接给字母
  assert.deepEqual(normalizeAnswer('L002', { kind: 'choice', answer: 'B' }).answers, [{ question: 1, answer: ['B'] }]);
  // 多选：逗号分隔 + 连写 AB 也要能拆开
  assert.deepEqual(normalizeAnswer('L003', { kind: 'choice', answer: 'b,d' }).answers, [{ question: 1, answer: ['B', 'D'] }]);
  assert.deepEqual(normalizeAnswer('L004', { kind: 'choice', answer: 'AB' }).answers, [{ question: 1, answer: ['A', 'B'] }]);
  // 多小问：题号:选项，分号分隔
  assert.deepEqual(
    normalizeAnswer('L005', { kind: 'choice', answer: '1:A; 2:B,D' }).answers,
    [
      { question: 1, answer: ['A'] },
      { question: 2, answer: ['B', 'D'] }
    ]
  );
  // 只在答案里给字符串、没写 kind 时，靠 answers 字段/默认值判断
  assert.equal(normalizeAnswer('L006', { answer: 'x = 1' }).kind, 'code');
  assert.equal(normalizeAnswer('L007', { answers: [{ question: 1, answer: ['A'] }] }).kind, 'choice');
  // 详细写法仍然兼容
  assert.deepEqual(
    normalizeAnswer('L008', { kind: 'choice', answers: [{ question: 2, answer: ['C'] }] }).answers,
    [{ question: 2, answer: ['C'] }]
  );
});

test('demoteHeadings：正文里的 #/##/#### 统一降到 ###，代码围栏内不动', () => {
  const text = [
    '# 一级标题',
    '## 二级标题',
    '#### 四级标题',
    '',
    '```python',
    '# 这是代码里的注释，不是标题',
    '```'
  ].join('\n');
  const out = demoteHeadings(text);
  assert.ok(out.includes('### 一级标题'));
  assert.ok(out.includes('### 二级标题'));
  assert.ok(out.includes('### 四级标题'));
  assert.ok(out.includes('# 这是代码里的注释，不是标题'), '围栏内的 # 必须原样保留');
});

test('task-parser：导出结构与签名形状正确', () => {
  const taskParser = require('../extractor/lib/task-parser');
  assert.deepEqual(Object.keys(taskParser).sort(), [
    'KINDS',
    'answerDocumentSpec',
    'answerFileName',
    'answerSpec',
    'classifyTask',
    'demoteHeadings',
    'detectImageExtension',
    'kindLabel',
    'languageFromPath',
    'levelId',
    'makeExperimentDocument',
    'makeLevelSection',
    'makeMarkdown',
    'normalizeAnswer',
    'normalizeImageSource',
    'safeName',
    'stringifyAnswer',
    'taskFromApi'
  ]);
  for (const [name, value] of Object.entries(taskParser)) {
    if (name === 'KINDS') {
      assert.equal(typeof value, 'object');
      continue;
    }
    assert.equal(typeof value, 'function', `${name} 必须是函数`);
  }
  assert.equal(detectImageExtension('image/png', 'AAAA'), 'png');
  assert.equal(safeName(''), 'untitled');
  assert.equal(languageFromPath('a.py'), 'python');
});
