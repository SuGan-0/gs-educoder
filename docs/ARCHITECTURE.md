# 项目架构与接口

当前工作流为：抓取本地资料 → 外部 Agent 作答 → 校验并发布 → 篡改猴使用。项目不再提供模型调用、模型配置或提交请求蓝图。

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `extractor/run.js` | CLI 与控制台入口，复用登录浏览器并协调抓取状态 |
| `extractor/lib/extract-engine.js` | 课程、实验、关卡选择及抓取状态机 |
| `async-pool.js` | 关卡清单的有界并发读取，保留输入顺序；停止后不再分配新请求 |
| `selection-model.js` | Node 与浏览器共享的搜索、稳定关卡键与选择解析；明确实验归属，拒绝歧义 |
| `educoder-api.js`、`educoder-sign.js` | 通过浏览器上下文发起带签名的读取请求；纯签名逻辑可离线测试 |
| `task-parser.js`、`level-store.js` | 解析任务、保存 JSONL 存档及派生 Markdown/metadata |
| `answer-format.js`、`answer-store.js` | 规范工作层 v2，保护已验证答案，同文件写入串行化和原子替换 |
| `archive-catalog.js` | 统一发现题目存档与仅答案文档，以课堂码、作业号隔离身份 |
| `class-answers.js` | 汇总、合并、验证班级发布文件 |
| `extractor/ui/server.js` | 本地 HTTP、SSE、产物与文件接口 |
| `extractor/ui/public/index.html`、`console.css`、`console.js` | 无构建步骤的控制台，按抓取、资料与答案划分工作区 |
| `userscript/educoder-autosubmit.user.js` | 答案导入、代码及选择题作答、队列、虚拟机题跳过与粘贴解锁 |
| `userscript/lib/paste-unlock.js` | 两份用户脚本共用的粘贴实现 |
| `userscript/lib/virtual-task.js` | Node 与用户脚本共用的 VNC 特征识别 |

Node.js 22.16+，CommonJS，不新增 npm 依赖；浏览器使用已有 Playwright。`npm run build:userscripts` 生成可安装脚本中的共享模块，`npm run check` 检查语法与生成块一致性。

## 抓取与答案

默认抓取保存题目、初始代码、图片与可取得的已有答案。仅答案模式只写实验工作答案，没有题目目录时也可发现、导出和导入。

实验关卡清单最多并发读取 3 份，按输入实验顺序合并；浏览器导航及实际抓取保持串行。浏览器上下文中的 API GET 默认 20 秒超时，覆盖响应体读取。停止不再分配新的清单读取，已发出的请求在完成或超时后收尾。

多实验关卡身份包含 `experimentIndex`，优先匹配 `identifier`，其次 `challengeId`，最后才使用序号。已提供的强身份不匹配时不得回退到序号；空选、无匹配或多重匹配返回错误，不能扩大为抓取全部。页面勾选、HTTP 校验与入口解析复用同一模块。搜索保留列表原始索引，批量选择仅操作可见结果。

编程题只有平台已通过代码可作为已验证来源；选择题收集各小问标准答案。未通过的代码草稿不当作标准答案。后续 Agent 读取 [作答说明](AGENT-ANSWERING.md)，生成内容保持 `source: "ai"`、`verified: false`。

工作层：`schema_version: 2`、`classroom`、`experiment`、`answers`。发布层：`version: 2`、`kind: "class-answers"`、`class`、`classrooms`。发布文件不要求旧的 `answered` 字段，按实际可解析内容判定。格式以 [答案规范](AI-ANSWER-FORMAT.md) 为准。

`L001` 仅在实验内唯一；课堂码、作业号、平台关卡标识参与归属判断。同名课堂或实验不能按名称覆盖。损坏 JSON、未来版本、冲突身份应报告并保留旧文件；不能以空文档替换。

## 控制台接口

控制台仅监听 `127.0.0.1`，默认端口 43127；token 首次生成后本地持久保存。下列接口均需 token。控制台读写控制接口还校验浏览器 Origin；用户脚本接口显式允许带凭据的 GM 请求。

页面及 `/assets/console.css`、`/assets/console.js`、`/assets/selection-model.js` 为固定白名单静态资源，仅支持 GET/HEAD，不提供任意文件访问。前端复用在途状态请求，SSE 重连后同步快照。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/state` | 抓取状态快照，不包含旧 AI 作答状态 |
| `GET /api/events` | SSE，发送 status/progress/saved/reused/dropped/reset/log 等事件 |
| `POST /api/action` | 选择、开始、停止、重置及导出班级答案 |
| `GET /api/agent/targets` | 本地课程、实验、题目与工作答案路径；包含仅答案文档 |
| `GET /api/agent/guide` | 下载 Agent 作答说明 |
| `GET /api/answers` | 给脚本读取答案与关卡/标题映射 |
| `POST /api/answer/save` | 按已知身份合并通过答案 |
| `GET/POST /api/missing` | 缺答案记录与重试清单 |
| `POST /api/log` | 脚本日志追加落盘 |
| `GET /api/signing-keys` | 给已连接的脚本同步本地签名常量 |

旧 `/api/answer/run`、`/stop`、`/config`、`/targets` 及 `/api/blueprint` 已删除，返回 404。`/api/answer/save` 仍用于答案落盘。

## 用户脚本执行

网络钩子只观察当前关卡的响应和选择题结果，不记录写请求体。批量回捞带独立标记，不污染当前关卡上下文。异步结果还要核对当前 URL，避免旧响应覆盖已切换的关卡。

代码与选择题通过页面现有按钮提交；通过后推进，明确失败或不明结果停队。选择题数据优先于实验环境标记，共用 VNC/Notebook 环境的选择题仍正常处理。代码答案缺失或不适配会记录并跳过；纯虚拟机操作题直接跳过，不调用虚拟任务接口；回捞仍扫描其前后关卡以查找其他选择题。其他页面未识别到可用编辑器或选择题时停队并保留现场信息。

停止状态覆盖旧异步副本，禁止其恢复队列或跳转。已送往平台的评测可能继续完成。

粘贴解锁在 `document-start` 安装，子框架只处理粘贴，不创建作答面板。Monaco 用 `executeEdits` 插入选区并维护撤销，避免平台 `onDidPaste` 删除文本；普通输入框保持原生输入行为。独立粘贴脚本无需控制台和签名。

## 验证

- `npm test`：离线单元与回归，假账号/假签名，不连接平台。
- `npm run test:ui`：真实本地服务与 Chromium，覆盖搜索后的选择归属与批量操作、抓取模式、Agent 文档和范围、发布，以及两个工作区的窄屏/深色布局。
- `npm run test:browser`：粘贴、光标、撤销、框架；配置 `EDUCODER_MONACO_ASSETS` 可测本地真实 Monaco。

真实密钥、Cookie、浏览器配置和课程产物仅存本地，不进入测试夹具。历史实施计划用于追溯，当前行为以代码、本文件及维护中的用户说明为准。
