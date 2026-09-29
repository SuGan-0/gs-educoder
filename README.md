# 头歌课程实验提取器

基于 Playwright 的本地头歌资料提取工具。首次运行时打开有头 Chromium，手动登录头歌；
登录状态保存在本地浏览器目录，之后可以选择课程、课堂实验和关卡，把题目正文、选项、
初始代码和图片导出到本地。

只读抓取：不自动作答、不自动填入、不自动提交。

## 功能

- 列出当前账号的教学课程并选择课程（单选）
- 列出课程中的课堂实验，支持选择一个、多个或全部实验
- **课堂实验下的「子标签实验」也会被列出**（例如软件工程导论里某个课堂实验下面挂的
  「软件工程初体验」，URL 形如 `/classrooms/{课程}/shixun_homework/{homework_id}?tabs=0`）：
  这类子项没有实训标识，工具会按 `homework_id` 打开它的作业页再沿关卡链定位
- 列出实验中的关卡并标注题型，支持选择任意多个关卡（接口没返回关卡列表时按关卡链遍历全部）
- 按真实关卡顺序提取每道题
- 编程题保存任务描述、完整编程要求和初始代码
- 选择题保存题干和选项，不保存答案
- 只保留编程题与选择题，其余题型（虚拟机/图形化、纯问答等）一律抛弃并说明原因
- 每个实验输出**一个 AI 友好的 Markdown 文件**（含全部关卡）+ 一个结构化 metadata.json
- 下载题目中的图片到实验目录的 `assets/`，并在 Markdown 中使用相对路径
- 不保存测试说明以外的教学铺垫，不自动作答、不自动填入、不自动提交
- 提供终端交互与本地 Web 控制台两种使用方式，共用同一个抓取引擎

## 安装

```powershell
npm install
```

依赖只有 `playwright`（Node 22，CommonJS）。

## 使用方式一：终端交互

```powershell
npm run extract
```

首次运行时在打开的浏览器窗口中完成登录，然后按提示依次选择：

1. 课程编号（单选）
2. 实验编号（多个用逗号分隔，或输入 `all` 抓取全部实验）
3. 关卡编号（多个用逗号分隔，直接回车抓取全部关卡）

也可以用环境变量做可重复运行：

```powershell
$env:EDUCODER_COURSE='1'          # 课程编号，从 1 开始
$env:EDUCODER_EXPERIMENTS='all'   # all 或逗号分隔的编号，如 '1,3'
npm run extract
```

环境变量只覆盖课程与实验，关卡仍在终端里确认（回车 = 全部）；传入无效值会自动回退到
手动选择。两种模式都支持追加 `--headless`（默认有头；无头窗口无法手动登录，只适合本地
已有登录态时），例如 `npm run extract -- --headless`。

## 使用方式二：本地 Web 控制台

```powershell
npm run ui
```

启动一个只监听 `127.0.0.1` 的本地服务，并自动用系统默认浏览器打开控制台页面（终端会
打印带 token 的完整地址；没有自动打开时，手动复制该地址访问）。控制台可以：

- 实时显示登录状态（账号）与当前阶段：启动浏览器、检查登录、等待登录、读取课程/实验/
  关卡、抓取中、正在停止、已完成、出错
- 三级选择：课程（单选）→ 实验（多选，支持全选/反选/清空）→ 关卡（多选，支持全选/反选/清空）

  关卡区会**一次列出全部勾选实验的关卡**，每条标出所属实验，并在下方显示
  「共 N 关，来自 M 个实验：X 关、Y 关」，不会出现「只看到第一个实验的关卡」。
- 实时进度：进度条、已保存/跳过/失败计数、最近保存列表和日志流
- 「停止」按钮：引擎存活期间（等待登录、等待选择、读课程/实验/关卡、抓取中）都可请求停止，
  已抓取的部分结果保留
- 结束后展示已保存/跳过/失败汇总与 `exports` 导出目录（可一键复制）
- **「AI 作答」面板**：选课程（单选）→ 实验（多选）→ 关卡（多选），填模型接口/模型/API Key，
  一键让模型按规范产出答案到 `exports/answers/`，并在面板里显示每个实验的覆盖度与待修问题；
  篡改猴再点「从本地拉答案」即可自动作答并提交（详见下方「AI 作答与自动提交」）

如果某门课程**没有课堂实验**（例如纯作业课、或当前视图下没有任何作业），控制台会说明
「该课程没有可提取的课堂实验，已结束」并结束本次任务——这是正常结果，不是故障。
换一门有课堂实验的课程重新点「开始提取」即可（一个进程只允许启动一次抓取）。

抓取用的 Chromium 由页面上的「开始提取」按钮启动，是独立于控制台页面的窗口，首次需要在
该窗口完成登录。

**可以反复提取，不是一次性的**：一轮任务结束后（完成、出错或被停止）浏览器窗口会**保持打开**，
可以直接再选课程/实验继续抓，不需要重启进程、也不需要重新登录。
只有「停止」按钮在引擎空闲时、或关闭控制台进程时才会关闭浏览器。

**已存在的关卡不会被重复抓取**：默认检查该实验的 `实验名.md` 里是否已有这一关、且内容指纹
（题目/要求/初始代码/选项/图片）与线上一致，一致就跳过，并在界面上显示
「已存在 N 关，未重复抓取」。若内容变了（题目被改、或上次缺图/缺初始代码），只重写那一关的小节。
需要强制覆盖时，勾选「重新下载已存在的关卡」再开始。

## 离线测试

```powershell
npm test
```

`npm test` 执行 `node --test --test-concurrency=1 "test/**/*.test.js"`：7 个测试文件，全部离线运行
——用假 Playwright 替换浏览器层，不联网、不需要头歌账号，覆盖纯函数解析与 Markdown 渲染、
题型白名单、实验单文件渲染与增量合并、数据访问层契约（分页、字段映射、错误降级）、引擎完整
流水线，以及 `run.js --ui` 的 HTTP + SSE 端到端流程（含 `diagnose` 动作）。

另有一个人工运行的界面实测脚本（不在 `npm test` 的 glob 内，会启动真实无头 Chromium）：

```powershell
node test/ui-visual-check.js
```

它用真实浏览器点击驱动完整流程（选课程 → 选实验 → 全选关卡 → 抓取完成），校验界面渲染、
按钮可用性、已选计数与浏览器控制台无报错，并把截图写到系统临时目录。

`EDUCODER_EXPORT_ROOT` 可覆盖导出目录（默认是仓库根下的 `exports\`），两种模式都生效；
测试用它把产物写到临时目录，避免污染 `exports\`：

```powershell
$env:EDUCODER_EXPORT_ROOT='D:\tmp\touge-out'
npm run extract
```

`EDUCODER_NETWORK_LOG` 控制抓取时的响应日志（**默认关闭**：它是这套工具最大的 IO 来源，
20MB 级别；只在排查接口时才需要）：

```powershell
$env:EDUCODER_NETWORK_LOG='1'                 # 开启，写到 .educoder-network.jsonl
$env:EDUCODER_NETWORK_LOG='D:\tmp\x.jsonl'    # 写到别处
$env:EDUCODER_NETWORK_LOG='0'                 # 显式关闭（等同不设置）
```

## 输出结构

```text
exports\
└── 课程名\                      # 一门课一个文件夹
    └── 实验名\                  # 一个课堂实验一个文件夹
        ├── levels.jsonl         # ★ 关卡存档：每关一行、只追加（唯一事实来源）
        ├── 实验名.md            # ★ 该实验的全部关卡都在这一个文件里（视图）
        ├── 实验名.metadata.json  # 同内容的机器可读版（视图）
        └── assets\
            ├── L001-image-1.png  # 文件名带关卡号，同实验内不会撞名
            └── L003-image-1.png
```

**存档与视图分离**：抓取时每关只往 `levels.jsonl` 追加一行（一次写入，不读回、不重写整份文档）；
`实验名.md` / `.metadata.json` 是由存档生成的视图，整轮结束时写一次。
视图可以随时删掉重建（断电、格式升级、手改坏了都不怕）：

```powershell
node tools/build-exports.js           # 重建全部视图（幂等）
node tools/build-exports.js --check   # 只检查哪些实验需要重建
```

同一关再次捕获时追加新行，读取时**最后一行生效**，因此补抓不会丢别的关卡。
结构与 IO 设计的完整说明（含实测体量、写放大对比）见 [docs/STORAGE.md](docs/STORAGE.md)。

`实验名.md` 是 **AI 友好**的单文件：YAML frontmatter（课程/实验/关卡数/生成时间）+
每个关卡一节 `## 第N关：关卡名`，节内按题型给固定小节：

- 编程题：`### 任务描述` + `### 编程要求` + `### 初始代码`（带语言围栏）+ `### 测试说明`
- 选择题：`### 选择题`（`N. 题干` + 三空格缩进 `A. / B. / C. …`）
- 每关末尾都带 `### 作答格式`：该关的答案 JSON 模板

**只保留编程题与选择题**，其余题型（虚拟机/图形化实操、纯问答、阅读材料、空壳关卡）一律抛弃，
并在日志与界面上说明「抛弃 N 关非编程题/选择题」。

判据来自真实关卡样本：编程题是「`with_code_file=true` 且 `path` 指向源代码文件」，
选择题是「`chooses` 非空」。**光有 `path` 还不够**——图形化题（如「学画用例图」
「绘制程序流程图」）同样带 `with_code_file=true` 和非空 `path`，但 `path` 指向的是
「学员任务文件」这类工作目录，且 `code_editor` 是空对象（没有代码环境）。
这两条**互相独立**的判据任一命中就抛弃，抛弃原因会写明环境
（如 `环境：Logisim/StarUML/VNC`），便于人工核对。
详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)「图形化/虚拟机题的判据」。

正文只抽取 `任务描述 / 编程要求 / 测试说明 / 作答要求` 四类小节，`相关知识` 等教学铺垫丢弃
（单文件要装整个实验，必须控制体量）；正文里原有的 `#`/`##` 标题统一降到 `###`，不破坏关卡层级。

`实验名.metadata.json` 含该实验所有关卡的结构化字段（`title`/`type`/`taskDescription`/
`programmingRequirements`/`starterCode`/`choiceQuestions`/`images`/`source`/`contentHash`）。

**题目内容变了会自动更新**：每关带内容指纹（`contentHash`），重跑时内容一致才判为「已存在」跳过；
题目被改动、或上次缺图/缺初始代码，则只重写那一关的小节，同实验其它关卡原样保留。

AI 答案文件的格式规范（输入结构 + 输出 JSON/Markdown 结构 + 校验规则 + 提示词）见
[docs/AI-ANSWER-FORMAT.md](docs/AI-ANSWER-FORMAT.md)。

编程题的初始代码直接嵌入 md 的代码块，代码块语言按文件扩展名识别，支持 Python、
Java、C/C++、Go、JavaScript、TypeScript、C#、Rust 和 SQL 等常见语言。

## AI 作答与自动提交

控制台右下方的 **「AI 作答」面板**把「出答案 → 交给篡改猴提交」这条链也管起来了：

1. 抓完题目后点「刷新产物」，面板会列出 `exports/` 下所有可作答的课程/实验/关卡
   （来自关卡存档 `levels.jsonl`，并显示每个实验「已有答案几关」）；
2. 选课程（单选）→ 实验（多选）→ 关卡（多选，默认全部），填模型接口 / 模型 / API Key；
3. 点「开始 AI 作答」：逐个实验把 `实验.md` 交给模型，答案写到
   `exports/answers/{课程}__{实验}.answers.json`，并立刻自校验
   （覆盖度、题型、选项字母越界、占位代码），结果逐条显示在面板里。

API Key 只存在控制台进程内存里，不落盘、不进日志、不回传前端。

### 篡改猴脚本

| 步骤 | 操作 |
| --- | --- |
| 1 | 装 Tampermonkey，新建脚本粘贴 [userscript/educoder-autosubmit.user.js](userscript/educoder-autosubmit.user.js) |
| 2 | 打开任意关卡页**手动提交一次**：脚本会记住提交接口，并**自动回传**给控制台落盘成 `submit.blueprint.json`（录制一次，之后不必再录） |
| 3 | 点「设置本地地址」→ 粘控制台的完整地址（用控制台上的**「复制控制台地址」**按钮最省事，含 token）→ 点「从本地拉答案」 |
| 4 | 点「一键作答并提交」：按关卡取答案 → 写入编辑器 / 勾选选项 → 点页面提交 → 等评测结论 → 自动「下一关」 |

**答案是怎么对上的**：答案文件按 `L001` 这类 `level_id` 存，而关卡页上只能拿到 URL 里的
平台关卡标识（如 `conv`、三段式 URL 的最后一段）。控制台在 `/api/answers` 里一并返回
`levelIds` 映射（来自关卡存档的 `source` 字段），脚本据此折算——
**没有这张表会出现「答案拉到了却一关都用不上」**。

**安全默认**：只有拿到明确的「通过」才进入下一关；「未通过」停在本题；
拿不到结论时也**不**往下走（可关掉「判定通过才进入下一关」强制跳关）。
原来固定等 3 秒、不看结果就点下一关，提交失败时会带着错答案一路跳下去。

三个开关存在脚本存储里，刷新页面保留：

- **连续作答**：本关通过后自动处理下一关，直到没有「下一关」或出错
- **判定通过才进入下一关**（默认开）
- **自动点「下一关」**（默认开）

选择题：先按标准分组容器（`ant-radio-group` / `role=radiogroup`）找题目，找不到再退回
「裸 input 按顺序切分」；**页面题目数与答案题数不一致就整体放弃**，单选给了多个字母、
答案字母越界、勾选后页面没保留，都会明确报错而不是照常提交。

提交优先点**页面自己的按钮**（不受接口变动影响），找不到按钮才重放录制到的接口。

### 命令行等价物（离线）

```powershell
node tools/build-exports.js                  # 从存档重建题目视图
node tools/validate-answers.js               # 校验答案：覆盖度/题型/选项字母/占位代码
```

格式规范见 [docs/AI-ANSWER-FORMAT.md](docs/AI-ANSWER-FORMAT.md)，存储与 IO 设计见
[docs/STORAGE.md](docs/STORAGE.md)。

- 所有 Educoder 请求都会带上签名头（`X-EDU-Timestamp` / `X-EDU-Signature` /
  `X-EDU-Type: pc`），实现见 `extractor/lib/educoder-sign.js`。
  **接口报的 `-102「服务器时间与您的设备时间不匹配」与系统时间无关，缺的就是这几个头**；
  补上之后接口直接可调，不需要任何页面截获。排查用 `node tools/probe-signature.js`，
  它会区分「会话失效」与「签名失效」并给出对应处置。
  细节与实测证据见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 第 0.1 节。
- 请求仍从浏览器上下文发出（页面内 `fetch`）：这样会话 cookie 由浏览器维护，
  登录流程与数据层共用同一份会话。
- 签名常量来自官网公开前端，网站改版会失效。失效时接口会重新返回 `-102`，
  报错会明确提示更新 `educoder-sign.js` 里的常量与 `SIGNING_VERSION`。
- 关卡链按 `next_game` 正向遍历（入口关的 `prev_game` 为 `null`，末关的 `next_game` 为 `null`）。
- **进入实验后一定从第 1 关开始**：头歌的实训页通常不提供关卡链接，而页面上下文给的
  `game_identifier` 指向「上次停留的关卡」。因此工具会用 `prev_game` 反向回溯到
  `prev_game === null` 的那一关再开始，界面上会打印
  `入口定位：第1关 xxx（来自 …）；已从 xxx 回溯到链首`。
  实测 6 个实验（含 11 关的 Java 实验）全部从第 1 关开始且序号连续无缺号。
- 只读抓取：不答题、不填入、不提交，也不调用任何有副作用的接口。
  自动作答与提交**不在抓取流程里**，由篡改猴脚本在页面内完成（见「AI 作答与自动提交」）。

## 排查问题

控制台右上角有「诊断」按钮：它会在**已经打开的抓取浏览器**里检查登录 cookie、
登录接口的原文响应、页面 DOM 特征以及本机与服务器的时间偏差，并把结论写进日志区。
抓不到数据时先点它，通常一眼能看出是登录态、接口被拒还是页面结构问题。

真实环境探针（需要已登录的 `.educoder-browser`；运行前请先关闭抓取浏览器窗口）：

```powershell
node tools/probe-real-flow.js            # 登录 → 课程 → 实验 → 关卡 全链路只读探测
node tools/probe-real-task.js            # 从 CNN 第 1 关沿 next_game 抓完整条链到临时目录，并做产物质量检查
node tools/probe-sub-experiments.js 软件工程   # 看某门课的课堂实验列表结构（含子标签），只读
node tools/probe-entry-distinct.js        # 连抓多个实验，校验「每个实验抓到的是自己的关卡」（防入口串台）
node tools/probe-recapture-experiment.js "设计友好的人机交互" 4000332 1586166 "1、软件工程初体验"
                                          # 单独重抓一个实验到临时目录，并校验图片签名与 md 引用
```

登录态自检（不看接口结论，直接看 cookie 与页面 DOM，能区分「会话失效」与「-102 误判」）：

```powershell
node tools/probe-login-state.js   # 打印 cookie 数量/有效期、跳转后的 URL 与是否有登录框
```

## 本地状态与隐私

以下文件只用于本地运行，已加入 `.gitignore`，不会提交到 Git：

| 路径 | 说明 |
| --- | --- |
| `.educoder-browser/` | Playwright 持久化登录状态与浏览器数据（默认 profile 目录） |
| `.educoder-cookie.json` | 早期方案留下的本地 Cookie 备份（如果存在） |
| `.educoder-browser-data.json` | 早期传统爬虫留存的实验 JSON（如果存在） |
| `.educoder-network.jsonl` | 抓取过程中记录的 Educoder API 响应日志 |
| `exports/` | 抓取的题目与图片（可用 `EDUCODER_EXPORT_ROOT` 改到别处；每门课一个文件夹、每个实验一个 md） |

## 备用脚本

早期方案仍保留，仅作备用与历史参考，与主流程存在重复实现：

| 脚本 | 入口 | 说明 |
| --- | --- | --- |
| `userscript/educoder-crawler.user.js` | 配合 `npm run crawler -- --server` | 油猴脚本把会话与页面接口响应发到 `127.0.0.1:43128` |
| `userscript/educoder-extractor.user.js` | 配合 `npm run writer` | 油猴脚本把解析结果发到 `127.0.0.1:43127/api/save-task` |
| `userscript/educoder-autosubmit.user.js` | 直接在头歌关卡页生效 | 自动作答并提交：录制一次真实提交学到接口，之后按答案库（`answers/*.answers.json`）填答提交并进入下一关；可从本地控制台 `GET /api/answers` 一键拉取答案与提交蓝图 |
| `extractor/writer-server.js` | `npm run writer` | 接收油猴脚本数据并写入 `exports\` |
| `extractor/traditional-crawler.js` | `npm run crawler` | 传统爬虫，用法见 [README-traditional.md](README-traditional.md) |

此外还有更早的浏览器控制台片段：`extractor/educoder_course_extractor.js`、
`extractor/extract-page.js`。

当前推荐入口是 `npm run extract`（终端交互）与 `npm run ui`（本地控制台）。
