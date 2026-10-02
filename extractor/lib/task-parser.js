'use strict';

// 纯函数模块：解析 payload → task、渲染 Markdown。
// 硬约束（见 docs/ARCHITECTURE.md 第 1 节）：无 fs / 无网络 / 无 playwright，可离线测试。
// 本文件由 extractor/run.js 的既有实现原样抽取而来，行为与抽取前完全一致。

const path = require('node:path');

const fmt = require('./answer-format');

function safeName(value) {
  return String(value || 'untitled')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function languageFromPath(filePath) {
  const extension = path.extname(filePath || '').toLowerCase();
  return {
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
  }[extension] || '';
}

/**
 * 把 markdown 图片括号里的内容解析成纯 URL。
 *
 * 平台正文里的图片常常带标题，形如：
 *   `![ 酒店页面 ]( /api/attachments/88000003 "酒店页面" )`
 * 早期直接把括号里的整串当成 URL，于是请求变成
 * `/api/attachments/88000003 "酒店页面"` → 服务端返回 `{"status":-1,"message":"文件不存在"}`，
 * 那个错误 JSON 又被当成图片存成 `.bin`（BUG-034）。
 *
 * 需要处理的形式：`<url>` 尖括号包裹、`url "title"`、`url 'title'`、`url (title)`、首尾空白。
 */
function normalizeImageSource(raw) {
  let text = String(raw || '').trim();
  if (!text) return '';
  // `![alt](<url> "title")`
  const angle = text.match(/^<([^>]+)>/);
  if (angle) return angle[1].trim();
  // `url "title"` / `url 'title'` / `url (title)`：标题前一定有空白分隔
  text = text.replace(/\s+["'(][\s\S]*$/, '').trim();
  // 有些正文会把引号写在 URL 里（如 /api/attachments/88000003"酒店页面"），去掉 URL 后的引号段
  text = text.replace(/["'][^"']*["'].*$/, '').trim();
  return text;
}

/**
 * 依据「magic bytes → content-type」判断图片扩展名。
 *
 * 只认真正的图片签名：**认不出来就返回空串**，调用方据此判定「这不是图片」。
 * 这样 HTML 错误页、`{"status":-1,"message":"文件不存在"}` 这类 JSON 就不会被写成 `.bin` 假图片
 * （早期 `detectImageExtension` 兜底返回 `'bin'`，把 41 字节的错误 JSON 当图片存了下来）。
 */
function detectImageExtension(contentType = '', base64 = '') {
  let head = '';
  try {
    head = Buffer.from(String(base64).slice(0, 32), 'base64').subarray(0, 12).toString('latin1');
  } catch {
    head = '';
  }
  const bytes = [...head].map((char) => char.charCodeAt(0));
  const startsWith = (...signature) => signature.every((byte, index) => bytes[index] === byte);
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return 'png';
  if (startsWith(0xff, 0xd8, 0xff)) return 'jpg';
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return 'gif';
  if (startsWith(0x42, 0x4d)) return 'bmp';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'webp';
  if (startsWith(0x3c, 0x3f, 0x78, 0x6d, 0x6c) || head.startsWith('<?xml')) {
    // SVG 是文本，只有 content-type 明确时才认
    return contentType.includes('svg') ? 'svg' : '';
  }
  // 没有可识别的签名：退回 content-type（但绝不默认 bin）
  const type = String(contentType || '').toLowerCase();
  if (type.includes('image/png')) return 'png';
  if (type.includes('image/jpeg') || type.includes('image/jpg')) return 'jpg';
  if (type.includes('image/gif')) return 'gif';
  if (type.includes('image/webp')) return 'webp';
  if (type.includes('image/bmp')) return 'bmp';
  if (type.includes('image/svg')) return 'svg';
  return '';
}

/**
 * 题型白名单：产物只保留「编程题」和「选择题」两类，其余（虚拟机、图形化、
 * 纯问答、空壳关卡等）一律抛弃。
 *
 * 判据来自真实 payload 统计（5020 条关卡样本，只出现两种形态）：
 *   - 编程题：`challenge.with_code_file === true` 且 `challenge.path` 非空；
 *   - 选择题：`payload.chooses` 非空且至少一题「题干 + 选项」都非空。
 * 其余组合（with_code_file=true 但无 path、既无 path 又无 chooses 等）都不是
 * 这两种可解答题型——实测的虚拟机/图形化关卡正是这种形态，直接丢弃。
 */
const KINDS = {
  CODE: 'code',
  CHOICE: 'choice',
  REJECTED: 'rejected'
};

function meaningful(text) {
  // 去掉空白、图片、标点、不可见字符后还有没有实义内容：用于判定「是不是只有一张图」。
  return String(text || '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .length > 0;
}

/** 是不是一个「存在但没有任何键」的普通对象。
 *  区分于 `undefined`：缺字段不算空对象，只有显式给了 `{}` 才算。 */
function isPlainEmptyObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === 0;
}

/**
 * 路径末段是否是「文件名 + 扩展名」形态。
 *
 * 源代码文件必然长这样；图形化/虚拟机题的 path 指向的是工作目录，实测有
 * `学员任务文件/s`（没有扩展名）与 `程序流程图/学员任务文件/.gitkeep`（点文件）两种。
 */
function looksLikeSourceFile(filePath) {
  const name = String(filePath || '').trim().split(/[\\/]/).pop() || '';
  if (!name || name.startsWith('.')) return false;
  return /\.[A-Za-z0-9]{1,8}$/.test(name);
}

function classifyTask(task) {
  if (!task || typeof task !== 'object') {
    return { kind: KINDS.REJECTED, reason: '任务为空' };
  }
  if (Array.isArray(task.choiceQuestions) && task.choiceQuestions.length) {
    return { kind: KINDS.CHOICE, reason: '有题干与选项' };
  }
  const hasFile = Boolean(task.withCodeFile);
  const hasPath = Boolean(String(task.codePath || '').trim());
  const mirrors = Array.isArray(task.mirrorNames) && task.mirrorNames.length
    ? `，环境：${task.mirrorNames.join(' / ')}`
    : '';
  if (hasFile && hasPath) {
    // 图形化/虚拟机题的两条独立判据（实测样本见 test/task-parser.test.js）：
    // ① 没有代码环境：真实编程题的 `code_editor` 是含 shixun_environment_id / name
    //    的对象，而 StarUML / Logisim / VNC 这类关卡给的是**空对象 `{}`**；
    // ② path 不像源文件：指向「学员任务文件」这类工作目录，没有源代码扩展名。
    if (task.codeEditorEmpty) {
      return {
        kind: KINDS.REJECTED,
        reason: `图形化/虚拟机题（无代码环境${mirrors}），不可自动解答`
      };
    }
    if (!looksLikeSourceFile(task.codePath)) {
      return {
        kind: KINDS.REJECTED,
        reason: `图形化/虚拟机题（代码文件路径不是源文件：${task.codePath}${mirrors}），不可自动解答`
      };
    }
    return { kind: KINDS.CODE, reason: '编程题（有代码文件路径）' };
  }
  if (!hasFile && !hasPath && (task.choices || []).length) {
    return { kind: KINDS.CHOICE, reason: '正文里枚举出的选项' };
  }
  if (hasFile && !hasPath) {
    return {
      kind: KINDS.REJECTED,
      reason: `图形化/虚拟机题：标记为代码题但没有代码文件路径${mirrors}，不可自动解答`
    };
  }
  const body = task.taskDescription || task.programmingRequirements || '';
  return {
    kind: KINDS.REJECTED,
    reason: meaningful(body)
      ? '既非编程题也非选择题（如虚拟机、图形化、纯问答关卡）'
      : '没有可解答的题目正文'
  };
}

/** 题目正文里的标题统一降到 ###，避免破坏「## 第N关」的层级；围栏内原样保留。 */
function demoteHeadings(text) {
  let inFence = false;
  return String(text || '')
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      const match = /^(\s*)(#{1,6})\s*(\S.*)$/.exec(line);
      if (!match) return line;
      return `${match[1]}### ${match[3]}`;
    })
    .join('\n');
}

function normalizeSpacing(text) {
  return String(text || '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 生成「正文渲染器」：把正文里的图片标记换成本地相对路径。
 *
 * 关键：markdown 图片括号里可能是 ` /api/attachments/88000003 "酒店页面" `（带标题），
 * 直接拿整串查 `imageMap` 会查不到（键是规范化后的 URL），于是产物里留着远程地址、
 * 明明本地已经有图却引用不到。所以这里一律先 `normalizeImageSource` 再查表，
 * 并用规范化后的 URL 作为兜底（保留远程地址时也不会带上标题）。
 */
function makeRender(task) {
  const replaceImage = (source) => {
    const url = normalizeImageSource(source);
    const mapped = task.imageMap?.[url] || task.imageMap?.[String(source || '').trim()];
    return mapped || url || source;
  };
  return (value) => demoteHeadings(String(value || '')
    .replace(
      /<p\b[^>]*>\s*<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/p>/gi,
      (_match, source) => `![题目图片](${replaceImage(source)})`
    )
    .replace(
      /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi,
      (_match, source) => `![题目图片](${replaceImage(source)})`
    )
    .replace(
      /!\[([^\]]*)\]\(([^)]+)\)/g,
      (_match, alt, source) => {
        // 真实 payload 里题干图片常写成 ![,]（alt 只有标点），标注为空才回退到「题目图片」，
        // 否则产物里会出现难看的 ![,](assets/image-1.png)。
        const label = /[\p{L}\p{N}]/u.test(alt || '') ? alt.trim() : '题目图片';
        return `![${label}](${replaceImage(source)})`;
      }
    ));
}

/** 题型显示名：给 AI 读者一眼看出该按哪种格式作答。 */
function kindLabel(task) {
  const { kind } = classifyTask(task);
  if (kind === KINDS.CHOICE) return '选择题（choice）';
  if (kind === KINDS.CODE) return '编程题（code）';
  return '其它（rejected）';
}

/** 关卡 id：文件内稳定、可被答案文件引用（第 3 关 → L003）。 */
function levelId(task) {
  const index = Number(task?.taskIndex);
  return Number.isFinite(index) && index > 0
    ? `L${String(index).padStart(3, '0')}`
    : `L${String(task?.title || 'x').slice(0, 8)}`;
}

/**
 * 答案文件的相对路径。
 *
 * 具体位置与命名由 `answer-format.js` 定义（v2：按班级分目录、班级码进目录名），
 * 这里只是给 md 的 frontmatter 提供「答案该写到哪」的说明文字。
 */
function answerRelativePath(course, experiment) {
  return path.relative(path.join(__dirname, '..', '..'), fmt.answerPathFor(
    path.join(__dirname, '..', '..', 'exports'),
    { name: course },
    { name: experiment }
  )).split(path.sep).join('/');
}

/**
 * 答案文件的输出规范：随每个关卡写进 md，AI 按这个结构产出答案即可。
 *
 * 格式刻意做到最小——一关一条，只要「关卡题号 + 答案」：
 * - 选择题：`level_id` + `kind` + `answer`（选项字母；多小问用 `"1:A;2:B,D"`）
 * - 编程题：`level_id` + `kind` + `language` + `answer`（完整代码）
 */
function answerSpec(task) {
  const { kind } = classifyTask(task);
  if (kind === KINDS.CHOICE) {
    const multiple = (task?.choiceQuestions || []).length > 1;
    return [
      '```json',
      '{',
      `  "level_id": "${levelId(task)}",`,
      '  "kind": "choice",',
      `  "answer": "${multiple ? '1:A;2:B,D' : 'A'}"`,
      '}',
      '```',
      multiple
        ? '本题有多个小问：`answer` 写成 `题号:选项`，分号分隔；多选题字母升序（如 `2:B,D`）。'
        : '选择题只填选项字母（多选写成 `A,C`，升序）。'
    ].filter(Boolean).join('\n');
  }
  return [
    '```json',
    '{',
    `  "level_id": "${levelId(task)}",`,
    '  "kind": "code",',
    `  "language": "${task?.codeLanguage || ''}",`,
    '  "answer": "完整代码（保留题目给的框架与 begin/end 标记）"',
    '}',
    '```'
  ].join('\n');
}



/**
 * 把一关渲染成实验文件里的一节（`## 第N关：x`）。
 *
 * 结构固定为：标题 → 元信息（id/题型/来源）→ ### 任务描述 / ### 编程要求 /
 * ### 初始代码 / ### 选择题 / ### 测试说明 → ### 作答格式（AI 输出规范）。
 * 空小节不输出。此函数是纯函数（无 IO）。
 */
function makeLevelSection(task) {
  const render = makeRender(task);
  const { kind } = classifyTask(task);
  const isChoice = kind === KINDS.CHOICE;
  const heading = `## 第${task?.taskIndex || '?'}关：${task?.title || '未命名关卡'}`;
  const meta = [
    `- 关卡 id：${levelId(task)}`,
    `- 题型：${kindLabel(task)}`,
    task?.source ? `- 来源：${task.source}` : ''
  ].filter(Boolean);
  const codeFence = (code, language) => (language
    ? `\`\`\`${language}\n${code}\n\`\`\``
    : `\`\`\`\n${code}\n\`\`\``);
  const parts = [
    heading,
    '',
    meta.join('\n'),
    // 被抛弃的题型只渲染标题与元信息（用于诊断），不输出正文与作答规范。
    kind === KINDS.REJECTED ? '' : (task?.taskDescription ? `### 任务描述\n\n${render(task.taskDescription)}` : ''),
    kind === KINDS.REJECTED ? '' : (task?.programmingRequirements ? `### 编程要求\n\n${render(task.programmingRequirements)}` : ''),
    // 选择题不输出任何代码（避免给 AI 错误信号），只给题干与选项。
    !isChoice && task?.starterCode ? `### 初始代码\n\n${codeFence(task.starterCode, task.codeLanguage)}` : '',
    task?.choiceQuestions?.length
      ? `### 选择题\n\n${task.choiceQuestions.map((question, questionIndex) => [
        `${questionIndex + 1}. ${render(question.subject)}`,
        ...question.options.map((option, optionIndex) => `   ${String.fromCharCode(65 + optionIndex)}. ${render(option)}`)
      ].join('\n')).join('\n\n')}`
      : task?.choices?.length
        ? `### 选项\n\n${task.choices.map((item, i) => `${i + 1}. ${render(item)}`).join('\n')}`
        : '',
    task?.testDescription ? `### 测试说明\n\n${render(task.testDescription)}` : '',
    task?.extraRequirements ? `### 作答要求\n\n${render(task.extraRequirements)}` : '',
    // 被抛弃的题型不给作答规范：它们不会进入产物。
    kind === KINDS.REJECTED ? '' : `### 作答格式\n\n${answerSpec(task)}`
  ];
  return `${parts.filter(Boolean).join('\n\n')}\n`;
}

/**
 * 把整个实验的关卡拼成一个 AI 友好的单文件（frontmatter + 每关一节）。
 * `levels` 可以是 task（会自动渲染）或已渲染好的字符串（增量合并时复用原样文本）。
 */
function makeExperimentDocument({ course = '', experiment = '', generatedAt = '', levels = [] } = {}) {
  const sections = levels
    .map((item) => (typeof item === 'string' ? item.trim() : String(makeLevelSection(item) || '').trim()))
    .filter(Boolean);
  const count = sections.length;
  // 答案路径由 answer-format 决定（按班级分目录、班级码进目录名）。
  const answerFile = answerRelativePath(course, experiment);
  const frontmatter = [
    '---',
    `course: ${course}`,
    `experiment: ${experiment}`,
    `levels: ${count}`,
    `generated_at: ${generatedAt}`,
    // 明确告诉 AI 答案写到哪里。
    `answer_file: ${answerFile}`,
    '---'
  ].join('\n');
  const body = sections.length
    ? sections.join('\n\n---\n\n')
    : '> 本实验没有可提取的编程题或选择题。';
  const hint = count
    ? `> 作答：把这一份文件的答案写成 \`${answerFile}\`（格式见每关的「作答格式」，整体结构见 \`docs/AI-ANSWER-FORMAT.md\`）。`
    : '';
  return `${frontmatter}\n\n# ${experiment}\n\n${[hint, body].filter(Boolean).join('\n\n')}\n`;
}

/**
 * 单关片段：`.md` 里的一个 `## 第N关` 一节（历史 API，测试与 tools/probe-*.js 仍在用）。
 */
function makeMarkdown(task) {
  return makeLevelSection(task);
}

function taskFromApi(payload, course, experiment, source) {
  const challenge = payload.challenge || {};
  const text = String(challenge.task_pass || '').replace(/\r\n/g, '\n').trim();
  // 只保留「能用来解题」的正文小节：任务描述 / 编程要求 / 测试说明 / 作答要求。
  // 「相关知识」等教学铺垫属于背景阅读，单文件要装整个实验，必须控制体量；
  // 四类小节是白名单，其它（含 #### 级小标题）直接丢弃。顺序按正文出现顺序，去重。
  //
  // 两个真实变体必须容忍（2026-09-28 实测，示例课程A的多个实验）：
  // - 标题带序号：`#### 1 任务描述`、`#### 3 闯关要求`（不带序号的老写法 `### 任务描述` 同样支持）；
  // - 名字不同：`闯关要求` 就是这些关卡的「编程要求」（正文是「**题目**：请修改…」），
  //   归到 programmingRequirements，否则 md 里这一关等于没有任何可解的信息。
  const KEEP_SECTIONS = ['任务描述', '编程要求', '测试说明', '作答要求'];
  const SECTION_ALIASES = { 闯关要求: '编程要求' };
  const sectionNames = [...KEEP_SECTIONS, ...Object.keys(SECTION_ALIASES)].join('|');
  const sections = () => {
    const found = new Map();
    const pattern = new RegExp(
      `^#{3,}\\s*(?:\\d+(?:\\.\\d+)*\\s*[、.．)）]?\\s*)?(${sectionNames})\\s*\\n([\\s\\S]*?)(?=^#{3,}\\s*|^---\\s*$|(?![\\s\\S]))`,
      'gm'
    );
    for (const match of text.matchAll(pattern)) {
      const rawName = match[1].trim();
      const name = SECTION_ALIASES[rawName] || rawName;
      const body = match[2].trim();
      if (body && !found.has(name)) found.set(name, body);
    }
    return found;
  };
  const bodies = sections();
  const section = (name) => bodies.get(name) || '';
  const choices = text.split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(?:[A-H][.、:：]|[（(][A-H][）)]|\d+[.、:：])\s*/.test(line));
  const choiceQuestions = Array.isArray(payload.chooses)
    ? payload.chooses.map((question) => ({
      subject: String(question.subject || '').trim(),
      options: Array.isArray(question.challenge_question)
        ? question.challenge_question.map((option) => String(option.option_name || '').trim()).filter(Boolean)
        : []
    })).filter((question) => question.subject && question.options.length)
    : [];
  const isCode = Boolean(challenge.with_code_file) && choiceQuestions.length === 0;
  // 代码语言只依赖文件路径，不依赖初始代码是否取到：取初始代码失败时也要给围栏标注语言。
  // 真实 payload 的 path 形如 `conv/conv.py；`（可能带全角分号等尾随符号）。
  const codePath = String(challenge.path || '').replace(/[；;\s]+$/, '');
  const codeLanguage = languageFromPath(codePath);
  // 图形化/虚拟机题的判据（见 classifyTask）：
  // 正常编程题的 `code_editor` 是含 shixun_environment_id/name 的对象；
  // StarUML / Logisim / VNC 这类关卡给的是**空对象 `{}`**，没有可编辑的代码环境。
  const codeEditorEmpty = isPlainEmptyObject(payload.code_editor);
  // `mirror_name` 只用于把抛弃原因写清楚（如 Logisim/StarUML/VNC），不参与判定。
  const mirrorNames = Array.isArray(payload.mirror_name)
    ? payload.mirror_name.map((item) => String(item || '').trim()).filter(Boolean)
    : typeof payload.mirror_name === 'string' && payload.mirror_name.trim()
      ? [payload.mirror_name.trim()]
      : [];
  const task = {
    title: challenge.subject || payload.homework_common_name || '未命名关卡',
    level: `第${challenge.homework_challenge_index || ''}关_${challenge.subject || '未命名'}`,
    type: choiceQuestions.length ? 'choice' : isCode ? 'code' : choices.length ? 'choice' : 'text',
    taskDescription: choiceQuestions.length ? '' : isCode ? section('任务描述') : text,
    programmingRequirements: isCode ? section('编程要求') : '',
    testDescription: isCode ? section('测试说明') : '',
    extraRequirements: isCode ? section('作答要求') : '',
    starterCode: '',
    codeLanguage,
    choices,
    choiceQuestions,
    // 题型白名单的判据字段：落盘与自动化都要靠它们。
    withCodeFile: Boolean(challenge.with_code_file),
    codePath,
    codeEditorEmpty,
    mirrorNames,
    course: course.name,
    // 课堂码（平台 `course_identifier`）：班级的机器身份。
    // 关卡存档、答案目录名、篡改猴核对班级都要用它——名称会重名，码不会。
    classroomCode: course.classroomCode || '',
    experiment: experiment.name,
    experimentHomeworkId: experiment.homeworkId || 0,
    source,
    taskIndex: challenge.homework_challenge_index || 0
  };
  // 白名单：只接受编程题与选择题，其余（虚拟机/图形化/纯问答）带原因标记为 rejected。
  const verdict = classifyTask(task);
  task.exportKind = verdict.kind;
  task.dropReason = verdict.kind === KINDS.REJECTED ? verdict.reason : '';
  if (verdict.kind === KINDS.REJECTED) task.type = 'rejected';
  return task;
}

/** 答案文件的整体结构（v2）：班级带课堂码，每条答案带平台关卡标识与来源。 */
function answerDocumentSpec(course, experiment) {
  return [
    '```json',
    '{',
    '  "schema_version": 2,',
    `  "classroom": { "name": "${course || '班级名'}", "code": "课堂码" },`,
    `  "experiment": { "name": "${experiment || '实验名'}", "homework_id": 0 },`,
    '  "answers": [',
    '    { "level_id": "L001", "task_identifier": "平台关卡标识", "kind": "code",',
    '      "answer": { "language": "python", "code": "完整代码" }, "source": "ai" },',
    '    { "level_id": "L002", "task_identifier": "平台关卡标识", "kind": "choice",',
    '      "answer": { "questions": [{ "number": 1, "selected": ["B"] }] }, "source": "ai" }',
    '  ]',
    '}',
    '```',
    `文件位置：\`${answerRelativePath(course, experiment)}\`（答案按班级分目录）。`
  ].join('\n');
}

module.exports = {
  safeName,
  languageFromPath,
  makeMarkdown,
  makeLevelSection,
  makeExperimentDocument,
  classifyTask,
  kindLabel,
  levelId,
  answerSpec,
  answerRelativePath,
  answerDocumentSpec,
  demoteHeadings,
  taskFromApi,
  detectImageExtension,
  normalizeImageSource,
  KINDS
};
