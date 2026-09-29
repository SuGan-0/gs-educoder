# 接口契约（冻结版）

本文件是并行开发的唯一事实来源。**任何模块不得修改本文件定义的签名**；如需变更，
先通知 Lead。所有文件为 CommonJS（`require` / `module.exports`），Node 22。

## 0. 目录与职责

```text
extractor/
  run.js                  # 薄 CLI 外壳：终端模式 + --ui 模式
  lib/task-parser.js      # 纯函数：解析 payload → task、渲染实验单文件（无 IO、无网络）
  lib/level-store.js      # 关卡存档（levels.jsonl，追加式）
  lib/answer-store.js     # 答案文件落盘/合并（exports/answers/，抓取端与控制台共用）
  lib/answer-validator.js # 校验答案（覆盖度/题型/选项字母/占位代码）
  lib/answerer.js         # AI 作答：读存档 → 调模型 → 写集中答案目录 → 自校验
  lib/educoder-sign.js    # 纯函数：Educoder 请求签名（-102 的真正修复点，见 0.1）
  lib/educoder-api.js     # 数据访问层：带签名头的只读请求，走浏览器上下文
  lib/extract-engine.js   # 状态机引擎：编排 + 事件 + 控制钩子
  ui/server.js            # 本地控制台 HTTP 服务（零新增依赖）
  ui/public/index.html    # 控制台前端（单文件，无构建）
test/                     # node:test 离线测试（不需要账号、不联网）
tools/                    # 真实环境探针 + build-exports.js / validate-answers.js
                          #   probe-signature.js：区分「会话失效」与「签名失效」
docs/ARCHITECTURE.md      # 本文件
docs/AI-ANSWER-FORMAT.md  # 提取产物 + AI 答案文件的格式规范
docs/STORAGE.md           # 存储结构、IO 量级、数据流
docs/OPTIMIZATION-PLAN.md # 基于 -102 根因的优化方案（删除/简化/借鉴/保留四类清单）
```

硬约束：

- **不新增 npm 依赖**，只用 Node 内置模块 + 已装的 `playwright`。
- `lib/task-parser.js` 与 `lib/educoder-sign.js` 必须**纯函数**
  （无 fs / 无网络 / 无 playwright），否则无法离线测试。
- `lib/educoder-api.js` 只允许 require 同目录的 `./educoder-sign`。
  所有 Educoder 请求必须带签名头（见 0.1），并仍从**浏览器上下文**发出
  ——这样会话 cookie 由浏览器维护，登录流程与数据层共用同一份会话。
  （注意：签名头才是接口能通的原因，不是「必须在浏览器里发」。）
- 只读抓取：不答题、不填入、不提交。不要调用任何 `*_delete.json`、`update_file.json`、
  `session_report.json` 之类有副作用的接口。

## 0.1 头歌 -102：真正的根因是**缺签名头**（务必先读）

接口被拒时的响应，文案是误导性的：

```json
HTTP 200  {"status":-102,"message":"服务器时间与您的设备时间不匹配，请检查您的设备时间设置并重新加载页面。"}
```

**这条文案与系统时间没有任何关系。** 真实原因是请求没有带 Educoder 前端的签名头。
本项目早期把它当成「环境限制」，并据此建了整套「页面自身请求优先 + 响应截获」的架构
——那是不必要的，代价是大量导航等待、`captureOwnResponse` 的 15 秒超时，以及
「签名坏了」被静默伪装成「你有 0 门课」。

实测（账号 p8sxailt2，2026-09-27）：

| 证据 | 结果 |
|---|---|
| 网络日志中同一路径 `/api/courses/HCEAP94S/homework_commons.json` | 页面自身请求成功 **2442** 次；本工具自身请求 `-102` 仅 **2** 次 |
| 7 个接口逐个对照（只切换是否带签名头） | 除 `get_user_info.json` 外，无签名全部 `-102`，**带签名全部成功** |
| 执行环境 | `request.newContext()`——**不是浏览器上下文**，所以下面那条硬约束同样不成立 |

### 最小必需请求头（逐个剔除实测）

```text
X-EDU-Timestamp: <当前毫秒时间戳>
X-EDU-Signature: md5( base64( "method=GET&ak=<AK>&sk=<SK>&time=<同一个时间戳>" ) )
Cookie:          <会话 cookie，如 _educoder_session=...>
X-EDU-Type:      pc        ← 必须精确为 pc，写成 web 会失败
```

- AK/SK 是**双重 base64 编码的公开客户端常量**（不是用户凭据），
  出处 `https://www-cdn.educoder.net/umi.<hash>.js` 的 `setHeader` / `getKey`。
  网站改版会换掉它们，因此 `lib/educoder-sign.js` 带 `SIGNING_VERSION`，
  失效时据此判断「算法变了」而不是「你会话掉了」。实现与测试向量见该文件。
- `X-Request-Id` / `Referer` / `Origin` / `X-Original-*` 均**非必需**（保留仅为排查方便）。
- 签名里的 `method` **必须与实际 HTTP 方法一致**。
- 例外：`GET /api/users/get_user_info.json?school=1` **无签名也能通**，
  因此它是「会话是否存活」最干净的探针，也是 `login`（账号）的唯一来源
  ——**不要硬编码账号**。

### 现在的取数方式：直接调接口

`lib/educoder-api.js` 的 `apiGet` 为每个请求注入上述签名头；页面仍需要
（会话 cookie 由浏览器维护、登录走持久化 profile），但**不再有任何响应截获**：
`watchResponses` / `captureOwnResponse` / `cachedResponse` / `coursesFromPage`
已删除，`fetchTask` / `captureLevel` 直接取接口，不再逐关导航。

自带诊断：控制台「诊断」按钮会跑一次**签名自检**（用一个必须签名的接口验证，
身份接口免签名所以证明不了签名是否有效）；命令行用 `node tools/probe-signature.js`，
它会区分「会话失效」与「签名失效」并给出对应处置。

**关卡链必须用 `next_game` 正向遍历**：入口（第 1 关）的 `prev_game` 为 `null`、
`next_game` 才有值；末关的 `next_game` 为 `null`。用 `prev_game` 会在第一关就终止，
只能抓到 1 关（旧实现即如此，已修复）。

**入口必须精确定位到第 1 关，否则会整段丢关卡**。实测：实训页 `a[href*="/tasks/"]` 经常
只有 0~1 个链接，且 `shixun_exec` 给的 `game_identifier` 指向「**上次停留的关卡**」。
这不是偶发——实测 6 个实验里 5 个的 `game_identifier` 都不是第 1 关：

| 实验 | 实训上下文（错误起点） | 实际入口 |
|---|---|---|
| CNN | 第 5 关 padding | 第 1 关 conv |
| 模型评估与选择 | 第 3 关 F1值 | 第 1 关 欠拟合与过拟合 |
| 机器学习 --- 神经网络 | 第 4 关 pytorch | 第 1 关 神经网络基本概念 |
| KNN案例--红酒分类 | 第 3 关 kNN预测 | 第 1 关 分析红酒数据 |
| 面向对象分析与设计 | 第 5 关 顺序图和通信图 | 第 1 关 面向对象技术的基本概念 |

因此**入口一律要确认是链首**（`resolveEntry`）：

1. 若页面链接/关卡列表里明确存在**序号为 1** 的关卡，直接采用（省一次导航）；
2. 否则以「链接中序号最小者 → 列表中序号最小者 → 列表首项 → `game_identifier`」为**起点**，
   沿 `prev_game` **回溯到 `prev_game === null`** 的那一关（`findChainStart`，最多 30 步并防环）。
   **回溯是唯一硬证据**：第 1 关的 `prev_game` 恒为 `null`。
3. 回溯若中途读取失败，返回 `{ exact: false }` 并记 warn，提示产物可能与实际第 1 关不一致
   ——不允许静默假装成功。

回溯结果与候选不一致时记日志（`入口定位：第N关 …；已从 xxx 回溯到链首`），界面上可见。
**入口不能只依赖 `game_identifier`**：该字段由 `openExperiment` 点击「开始学习」时截获
`shixun_exec.json` 得到，未必总能拿到；因此 `openExperiment` 还有两层兜底（当前页面 URL 里的
关卡标识 → 页面链接/页面数据里的关卡标识），否则入口将无从定位。

关卡列表的两个真实端点信息量不同，必须合并使用：

| 端点 | 内容 |
|---|---|
| `/api/shixuns/{shixun_identifier}/challenges.json` | `{ challenge_list: [{ name, position, challenge_id }] }`，**有名称、无关卡标识**；一定拿得到（导航到 `/shixuns/{id}/challenges` 即触发） |
| `/api/myshixuns/{myshixun_identifier}/challenges.json` | 含 `identifier`，可直接选关；但不一定被页面请求 |

因此 `levelsFromCache` 优先采用**带 identifier** 的那份；只有名称时也能显示关卡名，
此时入口交给 `findChainStart` 回溯。注意响应缓存必须**按路径名匹配**：页面真实请求
带查询串（如 `?id=ob8xcwt9`），用整串 `includes` 会永远匹配不上（曾导致关卡列表恒为空）。

诊断入口：控制台右上角「诊断」按钮（`engine.diagnose()`）会在**已打开的浏览器**里检查
cookie、登录接口原文、页面 DOM 与时间偏差，无需关窗口；真实环境探针见 `tools/`。

**关卡 URL 有两种形态，标识永远在最后一段**（`ExtractEngine.identifierFromTaskUrl`）：

| 形态 | 例子 | 标识 |
|---|---|---|
| 旧 | `/tasks/vrtbzlmexi3f?homework_common_id=3965745` | `vrtbzlmexi3f` |
| 三段式（实测 igoyjkcv） | `/tasks/2i6ng7vp/4157470/fru3ys8acf6n` | `fru3ys8acf6n` |

三段式里第一段是**课程码**、第二段是**作业 ID**，只有最后一段才是关卡标识。
早期用 `/tasks/([^/?#]+)` 只取第一段，会得到课程码 `2i6ng7vp`，导致后续所有
`/api/tasks/{id}.json` 请求 404。所有解析点都必须走 `identifierFromTaskUrl`。

**实训关卡页没有关卡链接时，入口靠「查看实战」**：实测 `igoyjkcv`
（集成测试和确认测试，2 关）的 `/shixuns/{id}/challenges` 页面上
**没有任何 `/tasks/` 链接**，`challenge_list` 也只有 `name`/`position`/`challenge_id`、
没有标识，`shixun_exec` 也不一定被触发。此时唯一途径是：

1. 点击页面上的**「查看实战」**控件 → 打开 `/tasks/{courseCode}/{homeworkId}/{identifier}`；
2. 取 URL **最后一段**作标识，并从三段式 URL 反推 `homeworkId`（第二段）；
3. **注意「查看实战」进入的不是第 1 关**（实测进的是第 2 关「确认测试」），
   必须再沿 `prev_game` 回溯到链首（`enterFirstLevel` → `findChainStart`）。

## 1. `lib/task-parser.js`

```js
module.exports = {
  safeName,               // (value: string) => string
  languageFromPath,       // (filePath: string) => string
  makeMarkdown,           // (task: Task) => string   -- 单关小节（历史 API）
  makeLevelSection,       // (task: Task) => string   -- 一个 `## 第N关` 小节
  makeExperimentDocument, // ({course, experiment, generatedAt, levels}) => string  -- 实验单文件
  classifyTask,           // (task: Task) => { kind: 'code'|'choice'|'rejected', reason: string }
  kindLabel,              // (task: Task) => string   -- 「编程题（code）」等
  levelId,                // (task: Task) => string   -- 'L001'
  answerSpec,             // (task: Task) => string   -- 该关的答案 JSON 模板
  demoteHeadings,         // (text: string) => string
  taskFromApi,            // (payload, course, experiment, source) => Task
  detectImageExtension,   // (contentType: string, base64: string) => string
  KINDS                   // { CODE: 'code', CHOICE: 'choice', REJECTED: 'rejected' }
};
```

### 题型白名单（产物只有两种题型）

`classifyTask(task)` 的判定顺序（**未命中即抛弃**，`reason` 会给人类可读原因）：

1. `choiceQuestions` 非空 → `choice`；
2. `withCodeFile === true` 且 `codePath` 非空，且**确实是编程题** → `code`；
   判定「确实是编程题」有两条独立判据，任一命中就抛弃（详见下节）：
   - `codeEditorEmpty`（`code_editor` 是**空对象**，没有代码环境）；
   - `codePath` 末段不像源文件（没有扩展名，或 `.gitkeep` 这类点文件）。
3. 无 `withCodeFile` 且无 `codePath` 但有 `choices` → `choice`（旧的正文行首枚举格式）；
4. `withCodeFile === true` 但没有 `codePath` → `rejected`（**虚拟机/图形化等实测形态**）；
5. 其余 → `rejected`（纯问答/阅读材料/空壳关卡）。

真实样本统计（5020 条关卡）只有两种形态：`with_code_file=true` + `path` 非空（4987 条）、
`chooses` 非空（33 条），因此白名单不会误伤正常题目。

### 图形化/虚拟机题的判据（实测，2026-09-27）

**光看「有 `with_code_file` 且有 `path`」不够**：软件工程导论的「学画用例图」「绘制程序流程图」
两个系列既有 `with_code_file=true`，`path` 也非空，但完全是图形化作图题。三者实测对比：

| 形态 | `path` | `chooses` | `code_editor` | `mirror_name` |
|---|---|---|---|---|
| 编程题 | `src/step1/source.java` | 0 | **有** `shixun_environment_id`/`name` | `["Python3.6"]` |
| 选择题 | `""` | >0 | 字段缺失 | 空 |
| **图形化/虚拟机** | `学员任务文件/s`、`程序流程图/学员任务文件/.gitkeep` | 0 | **空对象 `{}`** | `["Logisim/StarUML/VNC"]` |

因此用两条**互相独立**的判据（任一命中即抛弃，宁可漏判也不误伤编程题）：

- `codeEditorEmpty`：`code_editor` 存在但是空对象。缺字段（`undefined`）**不算**空环境，
  避免把没给这个字段的正常编程题误伤；
- `path 不像源文件`：末段没有扩展名，或以 `.` 开头（点文件）。

抛弃原因会带上 `mirror_name`（如 `环境：Logisim/StarUML/VNC`），便于人工核对
——这条判据是形态归纳而非平台声明的类型字段，写明环境才好复核。

### 正文小节白名单

`taskFromApi` 只抽取 `任务描述`、`编程要求`、`测试说明`、`作答要求` 四类小节（按正文出现顺序，
重名去重）；`相关知识` 等教学铺垫丢弃。小节正则的结尾前瞻必须是 `(?![\\s\\S])`（不能用 `$`：
带 `m` 标志时 `$` 匹配行尾，会把内容截断在第一个换行处）。

两个**实测变体**必须容忍（2026-09-28，软件工程导论「编程风格 / 高质量的代码」等实验）：
标题可能带序号（`#### 1 任务描述`），实际任务写在 `#### 3 闯关要求` 里——`闯关要求` 是
`编程要求` 的别名，归到 `programmingRequirements`。旧正则只认 `### 任务描述`，
这些实验的题干与要求会整段丢失。

### `taskFromApi(payload, course, experiment, source)`

`payload` 是 `/api/tasks/{id}.json` 的完整响应。返回 `Task`：

```js
{
  title,                    // challenge.subject || homework_common_name || '未命名关卡'
  level,                    // `第${homework_challenge_index || ''}关_${subject}`
  type,                     // 'code' | 'choice' | 'rejected'
  exportKind,               // 同上（classifyTask 的结论，落盘判据）
  dropReason,               // 被抛弃时的原因，否则 ''
  taskDescription,          // 编程题取「任务描述」；选择题为 ''；否则整段 task_pass
  programmingRequirements,  // 编程题取「编程要求」
  testDescription,          // 编程题取「测试说明」
  extraRequirements,        // 编程题取「作答要求」
  starterCode: '',          // 由引擎的 attachStarterCode 填充
  codeLanguage,             // languageFromPath(codePath)
  choices: [],              // 旧的、从正文行首枚举出的选项
  choiceQuestions: [],      // [{ subject, options: string[] }]
  withCodeFile, codePath,   // 白名单判据（来自 challenge.with_code_file / challenge.path）
  codeEditorEmpty,          // payload.code_editor 是否为空对象 → 图形化/虚拟机题判据之一
  mirrorNames,              // payload.mirror_name 归一成的字符串数组，只用于把抛弃原因写清楚
  course, experiment, source, taskIndex,
  imageMap: {}              // 由引擎的 attachImages 填充：原始 src → 'assets/Lxxx-image-N.ext'
}
```

### `makeLevelSection(task)` / `makeExperimentDocument({course, experiment, generatedAt, levels})`

单关输出 `## 第N关：名称` + `- 关卡 id / - 题型 / - 来源` + 小节（`### 任务描述` /
`### 编程要求` / `### 初始代码` / `### 选择题`（或 `### 选项`）/ `### 测试说明` /
`### 作答要求`）+ `### 作答格式`。选择题**不输出初始代码**，被抛弃的题型只输出标题与元信息。

`makeExperimentDocument` 把它们拼成实验单文件：frontmatter（`course`/`experiment`/`levels`/
`generated_at`）→ `# 实验名` → 各关小节之间用 `\n\n---\n\n` 分隔。`levels` 既接受 task 对象，
也接受已渲染好的小节字符串（增量合并时用来原样保留历史关卡）。

`render(value)` 在渲染任何文本时把图片转成本地路径，顺序为：`<p><img src="X"></p>` →
其余 `<img src="X">` → `![alt](X)`，其中 `X' = task.imageMap?.[X] || X`；最后统一走
`demoteHeadings` 把正文里的 `#`/`##`/`####` 降到 `###`（代码围栏内不动）。

### `safeName(value)`
把任意字符串转成安全的目录/文件名：非法字符 `\ / : * ? " < > |` 替换为空格，连续空白
压成单空格，首尾去空白。**假值**（`undefined`/`null`/`''`）返回 `'untitled'`；
纯空白字符串（如 `'   '`）是 truthy，按现有实现返回空串（已在测试中锁定，不影响产物，
因为关卡/实验/课程名不会纯空白）。

### `languageFromPath(filePath)`
按扩展名返回 Markdown 代码块语言；未知返回 `''`。映射（**必须与现有实现完全一致**）：
`.py→python`、`.java→java`、`.c→c`、`.cc/.cpp/.cxx→cpp`、`.cs→csharp`、`.go→go`、
`.js→javascript`、`.ts→typescript`、`.jsx→jsx`、`.tsx→tsx`、`.php→php`、`.rb→ruby`、
`.rs→rust`、`.sql→sql`。

### `detectImageExtension(contentType, base64)`
返回 `'png' | 'jpg' | 'gif' | 'webp' | 'bin'`。规则顺序：
1. `contentType` 含 `png` 或 base64 以 `iVBOR` 开头 → `png`
2. `contentType` 含 `jpeg` → `jpg`
3. `contentType` 含 `gif` → `gif`
4. `contentType` 含 `webp` → `webp`
5. 否则 `bin`

### `taskFromApi` 的判定规则（必须严格保持，这是已修复过的历史 bug）

- `choiceQuestions` 源自 `payload.chooses`（数组）：
  `subject = String(q.subject || '').trim()`，
  `options = q.challenge_question`（数组）里 `option_name` 非空的字符串。
  只有 `subject` 与 `options.length` 都非空的问题才保留。
- **`chooses` 存在即判定为选择题**，即使 `with_code_file=true`。此时
  `taskDescription` 与 `programmingRequirements` 必须为 `''`（选择题只保存题干和选项）。
- `type = choiceQuestions.length ? 'choice' : isCode ? 'code' : choices.length ? 'choice' : 'text'`，
  之后再按题型白名单归一：`code`/`choice` 之外的一切都改为 `'rejected'` 并填 `dropReason`。
- `codePath = challenge.path` 去掉尾随的全角分号/空白（真实值形如 `conv/conv.py；`）；
  `codeLanguage` 只依赖 `codePath`，不依赖初始代码是否取到。
- `task_pass` 先 `replace(/\r\n/g,'\n')` 再 `trim()`；小节用
  `^#{3,}\s*{name}\s*\n([\s\S]*?)(?=^#{3,}\s*|^---\s*$|(?![\s\S]))` 多行匹配后 `trim()`。

## 2. `lib/educoder-api.js`

```js
module.exports = {
  AUTH_USER,       // 'p8sxailt2' —— 仅兜底；运行时应以 checkLogin().user 为准（见 0.1）
  apiGet,          // (page, url, opts?) => Promise<{ok, status, text, json}>  -- 带签名头的浏览器内 fetch
  checkLogin,      // (page) => Promise<{loggedIn, user?, status?, reason, preview, signatureRejected?}>
  probeLogin,      // checkLogin 的底层：只调身份接口，不抛异常
  classifyResponse,// (status, text) => {ok, kind, reason, status, preview}
                   //   kind: ok | auth(401) | signature(-102) | empty | html | api
  listCourses,     // (page, {user?, perPage?}) => Promise<Array<Course>>   —— 含分页三道闸
  listExperiments, // (page, course, {user?}) => Promise<Array<Experiment>>
  listChallenges,  // (page, experiment, {user?}) => Promise<Array<Challenge>>
                   //   Challenge 含 position：关卡顺序以它为准
  ApiError, AuthExpiredError, SignatureRejectedError
};
```

错误分层的用途：**权限/签名失败不得触发重新登录**（会白烧登录次数，还会把
「算法变了」误报成「你密码过期了」）。`-102` 一律归为 `signature`，
`checkLogin` 会把它翻译成「请检查 educoder-sign.js 的常量与 SIGNING_VERSION」。

### `apiGet(page, url)`
在页面里 `fetch(url, { credentials: 'include' })`，返回
`{ ok, status, text, json }`；`json` 是惰性解析函数（`() => parsed`）。
`text` 为空时抛出 `接口返回空响应：{url}`。空响应/网络异常必须抛出，由调用方决定降级。

### `checkLogin(page)`
用 `GET https://data.educoder.net/api/users/{AUTH_USER}/courses.json?per_page=1`
判定：HTTP 200 且能解析出 `courses` 数组 → `{loggedIn: true, user: AUTH_USER, status: 200}`；
401/403 → `{loggedIn: false, status}`；其他异常不得抛出，返回 `{loggedIn: false}`。

### `listCourses(page, opts)`
真实接口（已从网络日志确认）：
```text
GET https://data.educoder.net/api/users/p8sxailt2/courses.json
    ?category=&status=processing&page={n}&per_page={per_page}&sort_by=updated_at&sort_direction=desc&username=p8sxailt2
```
响应形如 `{ count, courses: [...] }`。`opts = { perPage = 100 }`。
**必须分页拉全量**：循环 `page=1..`，累加 `courses`，直到累计数 ≥ `count` 或本次返回为空；
设置安全上限（如 20 页）防止死循环。返回 `Course[]`：

```js
{ id, name, school, visits, membersCount, homeworkCommonsCount,
  classroomCode,        // first_category_url 的 /classrooms/{code}/ 段
  classroomUrl,         // new URL(first_category_url, 'https://www.educoder.net').href
  isEnd }               // 可选，来自 is_end
```
`name` 需做空白归一化；缺少 `name` 或 `first_category_url` 的条目丢弃。

### `listExperiments(page, course)`
```text
GET https://data.educoder.net/api/courses/{course.classroomCode}/homework_commons.json
    ?limit=100&status=0&id={classroomCode}&type=4&order=0&zzud=p8sxailt2
```
查询参数取自网络日志中浏览器发出的真实请求（原始形式为 `limit=20`）。**必须显式带参数**：
不带查询参数的裸 URL 可能被服务端按默认 limit 截断（真实日志只见过 `limit=20` 与 `limit=100`），
这里取 `limit=100` 以保证实验数不被截断。只保留 `item.is_shixun` 为真的条目。返回：

```js
{ name, homeworkId, shixunIdentifier, myshixunIdentifier, taskCount }
// 映射：name ← item.name；homeworkId ← item.homework_id；
// shixunIdentifier ← item.shixun_identifier；myshixunIdentifier ← item.myshixun_identifier；
// taskCount ← item.challenge_count || 0
```
`payload.status` 非 0 时抛出 `读取课程实验失败：{message}`。
**注意：不要用 `homework_commons_count`（41）当实验数**，那是作业总数，不是可提取的实训数。

### `listChallenges(page, experiment)`
```text
GET https://data.educoder.net/api/myshixuns/{myshixunIdentifier}/challenges.json?homework_common_id={homeworkId}&zzud=p8sxailt2
```
响应可能是数组，或 `{data:[...]}` / `{challenges:[...]}`。返回：

```js
{ identifier, name, index, type }   // type: 'code' | 'choice' | 'unknown'
```
- `identifier ← item.identifier`（缺失则丢弃该条）
- `name ← item.subject || item.name || ''`
- `index ← item.homework_challenge_index ?? item.index ?? 0`
- `type`：`Array.isArray(item.chooses) && item.chooses.length` → `'choice'`；
  否则 `item.with_code_file` 为真 → `'code'`；否则 `'unknown'`。
- 接口失败时返回 `[]`（不抛出），引擎会退化为按 `next_game` 链遍历（入口关的 prev_game 为 null，正/反向不能搞反）。

## 3. `lib/extract-engine.js`（Lead 负责）

```js
const { ExtractEngine } = require('./lib/extract-engine');
const engine = new ExtractEngine({
  headless: false,
  exportRoot,                 // 默认 <repo>/exports
  profileDir,                 // 默认 <repo>/.educoder-browser
  skipExisting: true,         // 默认跳过本地内容未变的关卡
  onEvent(evt),               // 见事件协议
  control: {                  // 由外壳实现；全部返回 Promise
    waitForCourse(courses),           //  resolve 选中的 Course
    waitForExperiments(experiments),  //  resolve Experiment[]（可多选）
    waitForLevels(levels),            //  resolve Challenge[] | null（null = 全部）
    waitForAllLevels(levels),         //  多实验合并列表，一次选完；缺省回退 waitForLevels
    shouldStop()                      //  resolve boolean
  }
});
await engine.run();      // 跑到结束或停止（没有 start() 方法）
await engine.resetRun(); // 「重新开始」：清空列表与选择状态（运行中抛错），并发 reset 事件
await engine.stop();     // 请求停止并关闭浏览器上下文（幂等）
await engine.diagnose(); // 现场诊断：cookie / 登录接口原文 / DOM / 时间偏差 → { ok, lines }
```

事件协议（`onEvent` 收到的对象，`type` 字段区分）：

| type | 载荷 |
|---|---|
| `status` | `{ phase, message, user?, loggedIn? }`；phase ∈ `starting\|browser\|login\|waiting-login\|courses\|waiting-course\|waiting-experiments\|levels\|waiting-levels\|running\|stopping\|done\|error` |
| `courses` | `{ courses: Course[] }` |
| `experiments` | `{ course, experiments: Experiment[] }` |
| `levels` | `{ levels: Challenge[], multi?: boolean, experimentNames?: string[] }`。**多实验统一选择时只发一次**，且必须带全量合并列表（每条含 `experimentName`）——逐个实验各发一次会让界面只剩最后一个实验的关卡 |
| `progress` | `{ saved, skipped, failed, existing, dropped, current, total, experimentName, courseName, levelName, levelType }` |
| `saved` | `{ path, directory, metadataPath, title, taskType, level, levelCount, images }`。`path` 指向**实验 md**（一个实验一个文件），`levelCount` 是该文件里已有的关卡数。**题目类型必须放在 `taskType`**，不能放在 `type`——`type` 已被事件判别字段占用，同名会吞掉整条事件 |
| `reused` | `{ path, directory, title, level, taskType, reason }`。本地该关内容指纹一致，未重复抓取 |
| `dropped` | `{ source, title, level, reason }`。题型白名单命中之外的关卡（虚拟机/图形化/纯问答）被抛弃 |
| `reset` | `{}`。外壳「开始提取（清空重来）」时发出 |
| `log` | `{ level: 'info'\|'warn'\|'error', message }` |
| `done` | `{ saved, skipped, failed, existing, dropped, stopped, exportRoot }` |
| `error` | `{ message }` |

注意：

- 引擎**没有 `start()`**；「启动一次抓取」由外壳（`run.js`）自己用标志位保证幂等。
- `run()` 在提前退出（未登录、停止请求、没读到课程、未选课程）时**也必须发 `done`**，
  否则界面会永远停在中间阶段（例如 `waiting-login`），启动按钮再也点不动。
- `emit(evt)` 的返回值可忽略。

### 落盘布局与增量合并

```text
<exportRoot>/<课程>/<实验>/
  <实验>.md              # 全部关卡一个文件（见 docs/AI-ANSWER-FORMAT.md）
  <实验>.metadata.json   # { course, experiment, generatedAt, levelCount, kinds, levels[] }
  assets/                # 本实验全部图片，文件名形如 L001-image-1.png
```

- `experimentPaths(course, experiment)` 统一算路径，禁止各处自己 `path.join`。
- 同一 `taskIndex`（= `homework_challenge_index`）视为同一关：`saveExperimentLevel` 先读回已有
  md + metadata，**内容指纹一致（`contentHash` 相同）才判为 `reused` 并跳过**；否则只重写该关
  小节，同实验其它关卡原样保留（增量合并，补抓单关不会抹掉已有内容）。
- `contentHash` 覆盖 title/type/source/taskIndex/正文各小节/starterCode/选项/图片映射，
  由 `taskContentHash(task)` 计算，写在 `metadata.levels[].contentHash`。
- 图片文件名由 `attachImages` 生成，带关卡号前缀（`L{index}-image-N.ext`），避免同实验内撞名。

## 4. `extractor/ui/server.js`

```js
module.exports = { startUiServer };
async function startUiServer({ port = 0, onControl, open = true })
//   => { url, port, close(), emit(evt), getSnapshot(), setSnapshot(patch) }
```

- `port: 0` 时由系统分配空闲端口，`url` 形如 `http://127.0.0.1:PORT/?token=...`。
- **只绑 `127.0.0.1`**。所有 `/api/*` 请求必须校验 `Origin` 为同源（或缺失）且
  `token` 正确，否则 403。静态页 `/` 允许带 token 访问。
- token 可来自 `?token=`、`x-ui-token` 头、`Authorization: Bearer` 或 POST body 的
  `token` 字段（四种取其一即可）。
- `open: true` 时用系统默认浏览器打开 `url`（Windows 用 `start`，跨平台容错）。
- `emit(evt)`：把引擎事件推给所有 SSE 订阅者，并更新内存快照。
- **SSE 帧形**：只发 `data: {json}\n\n`，**不带 `event:` 字段**；接收方按 `data.type` 判别。
  前端必须用 `onmessage`（而非 `addEventListener('status'…)`）接收。
- `onControl(action, payload)`：动作 `select-course` / `select-experiments` / `select-levels` /
  `start` / `reset` / `stop` / `diagnose` → 由外壳转成控制钩子的 resolve。
  **新增动作必须同时加进 `server.js` 的 `ACTIONS` 白名单**，否则前端按钮永远返回「未知动作」
  （`diagnose` 曾因此整整不可用）。
- 外壳 `onControl` 的返回值会**合并进 HTTP 响应体**（`diagnose` 的结论行靠它回传前端）。
- 内存中最多保留最近 500 条日志，防止长任务吃内存。

**`select-levels` 空数组语义**：前端把勾选项以结构化 `{ levels: [...] }` 提交，并且**不允许提交空选择**
（界面上会提示「请至少勾选一个关卡」）。外壳对 `levels`/`identifiers` 都匹配不到任何关卡时按
「全部关卡」resolve（等价于 `null`），避免因标识缺失退化成「一个都不抓」。

### HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/` | 控制台页面 |
| `GET` | `/api/state` | 完整快照（首次加载用） |
| `GET` | `/api/events?token=` | SSE 流，推 `status/courses/experiments/levels/progress/saved/reused/dropped/reset/log/done/error/answer` |
| `POST` | `/api/action` | `{ action, token, ...payload }`。动作须在 `ACTIONS` 白名单里 |
| `GET` | `/api/answer/targets?token=` | 可作答的课程/实验/关卡（来自关卡存档） |
| `POST` | `/api/answer/run` | `{ course, experiments[], levels[]?, apiKey, baseUrl?, model? }` |
| `POST` | `/api/answer/stop` | 请求停止作答任务 |

**给篡改猴用的端点**（浏览器扩展从 `educoder.net` 页面发起，Origin 不是本机地址，
因此**显式只校验 token**，不套同源白名单；安全性依据是 token 由 `npm run ui` 随机生成、
只出现在用户终端与本机 URL 里，且这些端点只读答案、或只往 `exports/` 下写蓝图与答案）：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/answers?token=` | 汇总答案 + 蓝图 + `levelIds` + `levelDirs` + 文件清单 |
| `POST` | `/api/blueprint?token=` | `{ levelId, url, method, body }` → 按关卡标识定位实验目录并合并写 `submit.blueprint.json` |
| `POST` | `/api/answer/save?token=` | `{ identifier, kind, answer, language? }` → 按关卡标识定位课程/实验，合并写 `exports/answers/{课程}__{实验}.answers.json`（篡改猴「提交通过后回传答案」用；关卡必须先被抓取过，否则 400 并说明原因） |

`levelIds` 是**必需**的：答案按 `L001`（`levels.jsonl` 的 `taskIndex`）汇总，而篡改猴在关卡页上
只能拿到 URL 里的平台关卡标识，两边不折算就永远对不上。映射来自关卡存档的 `source` 字段。

### 答案自动导出（已通过测评的关卡）

抓取链路里，关卡「已通过测评」时会把提交的代码 / 所选项当作答案写进
`exports/answers/{课程}__{实验}.answers.json`（`extract-engine` 的 `captureAnswer`，
落盘与合并走 `lib/answer-store.js`）。判据与真实字段（2026-09-28 实测）：

- **判据：`game.final_score >= challenge.score`**（`challenge.score` 是满分：编程题 100、
  选择题每题 10 分；未提交时 `final_score` 为 0）。别用 `test_sets[].output`——那是测试点的
  **期望输出**，未提交的关卡也可能是「通过」。
- 编程题答案 = `rep_content.json` 的内容（用户仓库里的那份文件：已提交就是提交的代码）。
  该接口**必须带签名**请求，否则一律 `-102`（旧实现用无签名的 `page.request.get` +
  「重载页面等页面自己请求」兜底，实测导致每个实验最多只有一关有初始代码）。
- 选择题答案 = `choose_test_cases.test_sets[].actual_output`（`standard_answer` 优先），
  按 `position` 排成 `1:A;2:B,C`。
- 合并规则：同一 `level_id` 覆盖并保持顺序，其它关卡与文件既有写法（AI 答案）原样保留。

**改动契约前先看 `test/ui-wiring.test.js`**：它会从后端源码里提取实际发出的所有事件类型，
断言前端 `EVENT_TYPES` 全覆盖——后端加了事件而忘改前端会直接红。

快照结构（`GET /api/state` 与 SSE 事件同构，前端只维护一份 state）：

```js
{
  phase,            // 引擎 phase
  message,          // 人类可读状态
  user,             // 登录用户名或 null
  loggedIn,         // boolean
  courses: [],      // Course[]（含 classroomCode）
  experiments: [],  // Experiment[]
  levels: [],       // Challenge[]；多实验时是合并列表（每条带 experimentName）
  levelsMulti: false,      // 该列表是否来自多个实验
  levelsExperiments: [],   // 合并列表涉及的实验名（界面用来显示分组统计）
  selectedCourse, selectedExperiments, selectedLevels,
  progress: { saved, skipped, failed, existing, dropped, current, total },
  extracted: [],    // 本次会话已提取内容（saved/reused 累积，reset 清空）
  answer: {         // AI 作答任务状态（/api/answer/* 驱动，刷新页面可恢复）
    running, stopped, course, experiment, done, total, message, results: [], log: []
  },
  logs: [],         // [{ time, level, message }]
  done: null        // 结束时为 done 事件载荷（含完整 extracted）
}
```

`POST /api/action` 请求体与响应：

| action | 请求 | 响应 |
|---|---|---|
| `select-course` | `{ courseId }` | `{ ok: true }` |
| `select-experiments` | `{ indices: number[] }` | `{ ok: true }` |
| `select-levels` | `{ levels: [{ identifier?, challengeId?, position? }] }` 或 `{ identifiers: string[] }` | `{ ok: true }` |
| `start` | `{ skipExisting?: boolean }` | `{ ok: true, skipExisting }` |
| `reset` | `{}` | `{ ok: true, reset: true }` |
| `stop` | `{}` | `{ ok: true, stopping? \| closed? }` |
| `diagnose` | `{}` | `{ ok: true, lines: string[] }` |
| `answer targets` | `GET /api/answer/targets?token=` | `{ ok: true, courses: [{ name, experiments: [{ name, levelCount, answered, levels[] }] }] }` |
| `answer run` | `POST /api/answer/run` `{ course, experiments[], levels[]?, apiKey, baseUrl?, model? }` | `{ ok: true, started: true }`；进度在快照 `answer` 字段与 SSE `answer` 事件里 |
| `answer stop` | `POST /api/answer/stop` | `{ ok: true, stopping: true }` |
| `answers` | `GET /api/answers?token=` | `{ ok: true, answers: { L001: {...course, experiment} }, experiments, blueprints, files, answerDir }` |

失败返回 4xx/5xx + `{ ok: false, error: string }`。

## 5. `extractor/ui/public/index.html`

单文件，内联 CSS/JS，**无外部 CDN**（离线可用）。要求：

1. 从 URL 取 `token`，`GET /api/state` 初始化，再连 `/api/events?token=`（`EventSource`）。
2. 三块区域：① 状态（浏览器/登录/阶段）② 三级选择（课程 → 实验 → 关卡，实验与关卡支持
   多选 + 全选/反选）③ 进度（进度条、`已保存/跳过/失败`、日志流、`开始`/`停止` 按钮）。
3. 阶段 → 按钮可用性：`waiting-course` 时课程区可用；`waiting-experiments` 实验区可用；
   `waiting-levels` 关卡区可用；`running` 时只有「停止」可用。其他阶段禁用并由 `message` 说明。
4. `waiting-login` 时醒目提示「请在弹出的浏览器窗口完成登录」，并提供轮询状态的手段
   （刷新按钮或自动重连 SSE 均可，断线要能自动重连并重新同步 `/api/state`）。
5. 结束后展示汇总（已保存/跳过/失败/抛弃）+ `exports` 目录路径；「已提取内容」面板按
   课程 › 实验 归组。
6. 中文界面；深色或浅色自选但需专业、克制、信息密度高；不引入任何构建步骤。
7. 事件白名单 `EVENT_TYPES` 必须覆盖引擎实际发出的全部 type（含 `reused`/`dropped`/`reset`）——
   前端在入口按白名单过滤，漏一个就等于静默丢弃该事件。
