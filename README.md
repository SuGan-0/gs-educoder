# 头歌课程数据工作台

基于 Node.js 与 Playwright 的课程实验资料归档与本地管理项目。围绕课程、实验、关卡三级结构，提供资料采集、结构化存储、内容校验、格式转换及浏览器端集成。

核心流程：**采集 → 归档 → 整理 → 校验 → 导出**。运行状态通过本地 HTTP 与 SSE 同步；数据处理与平台会话解耦，不依赖内置模型服务。

## 系统组成

| 模块 | 职责 |
| --- | --- |
| 采集引擎 | 课程与实验枚举、关卡解析、资源归档、增量复用及任务状态管理 |
| 本地控制台 | 范围选择、实时进度、产物索引、文档交接及格式导出 |
| 数据处理层 | 实验工作文件规范化、身份校验、原子写入与分层合并 |
| 浏览器端集成 | 本地数据导入、编辑器交互、会话进度管理与粘贴辅助 |
| 作业提醒 | 作业快照、截止时间计算、投递去重与本地记账 |

技术栈：Node.js 22.16+、CommonJS、Playwright、原生 HTML/CSS/JavaScript。控制台不需要前端构建步骤。

## 环境与启动

```powershell
npm ci
npx playwright install chromium
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm run ui
```

配置入口为 [.env.example](.env.example)。平台访问需要有效登录会话及 `EDUCODER_AK`、`EDUCODER_SK`；签名常量使用双 base64 编码值，也可从本地 `.educoder-keys.json` 兼容读取。环境变量优先于 `.env`。

控制台默认监听 `127.0.0.1:43127`，访问地址由终端输出。凭据首次生成后保存在本地配置中；端口冲突时另行分配并提示。首次采集需在 Playwright 打开的 Chromium 中完成登录，后续复用 `.educoder-browser/` 会话。

终端交互入口为 `npm run extract`。控制台与提醒程序使用同一浏览器配置时，应分别运行，避免配置目录被重复占用。

## 采集与归档

控制台按课程、实验、关卡逐级确定范围。实验和关卡支持多选；搜索保留原始索引，批量操作仅作用于当前搜索结果。多实验清单保留所属实验信息，不以相同关卡序号合并身份。

| 模式 | 输出 |
| --- | --- |
| 完整采集 | 关卡 JSONL、Markdown 视图、元数据、初始代码、图片及可取得的已有记录 |
| 只抓取已有答案 | 仅更新实验工作文件，不生成题目视图和资源目录 |

关卡清单最多并发读取 3 份，合并顺序与输入一致；浏览器导航及实际采集保持串行。API GET 默认 20 秒超时。停止后保留已写入的数据；重新运行可复用已有归档，指定重读时更新目标范围。

工作文件记录内容来源与验证状态。未通过的编辑器草稿不作为已验证记录；缺少原始题目时，校验结果仅覆盖可检查的结构与身份信息。

## 数据模型

| 层级 | 关键字段 | 用途 |
| --- | --- | --- |
| 关卡归档 | `levels.jsonl` | 追加式原始记录，同一关最后一条有效 |
| 实验工作层 | `schema_version: 2`、`classroom`、`experiment`、`answers` | 单实验内容、来源及验证状态 |
| 班级汇总层 | `version: 2`、`kind: "class-answers"`、`classrooms` | 跨实验交换与浏览器端导入 |

`L001` 等编号仅在实验内唯一。课堂码、作业号与平台关卡标识共同约束数据归属；同名课程或实验不能作为覆盖依据。合并时保留范围外记录，损坏文件、未知版本及冲突身份会中止写入。

产物结构：

```text
exports/
  {课程}/{实验}/
    levels.jsonl
    {实验}.md
    {实验}.metadata.json
    assets/
  answers/
    {课堂}（{课堂码}）/{实验}.answers.json
    {年级}-{班级}.answers.json
  logs/
```

工作文件位置以 Markdown 的 `answer_file` 或产物索引的 `answerPath` 为准。Markdown 与 metadata 可由归档重新生成；完整字段定义见 [数据格式规范](docs/AI-ANSWER-FORMAT.md) 和 [存储设计](docs/STORAGE.md)。

## 处理与导出

控制台“资料与答案”工作区提供本地目录、处理说明、上下文复制和班级汇总入口。外部 Agent 的文件范围、来源标记与校验要求见 [Agent 处理规范](docs/AGENT-ANSWERING.md)。

```powershell
node tools/validate-answers.js "课程名称" "实验名称"
npm run check-fit
npm run build-class-answers -- --grade="2024级" --class="示例班级"
```

校验分别检查结构、归属、可用题目覆盖度及内容适配；结构检查不等同于运行结果确认。已有班级文件采用合并语义，本轮未获取的记录保留。

| 命令 | 用途 |
| --- | --- |
| `node tools/build-exports.js` | 从 JSONL 重建派生视图 |
| `npm run merge-class-answers -- --from="D:/archive/class.answers.json" --dry-run` | 预览外部汇总文件合并 |
| `npm run migrate-answers -- --dry-run` | 预览旧目录结构迁移 |

## 浏览器端集成

[主脚本](userscript/educoder-autosubmit.user.js) 通过 Tampermonkey 安装，支持本地文件导入与控制台连接。连接凭据可由控制台复制；离线导入不要求本地服务常驻。会话进度、身份映射、日志和偏好保存在 GM 存储中。

仅需编辑器粘贴支持时，可使用 [独立粘贴辅助脚本](userscript/educoder-paste-unlock.user.js)，无需本地服务。Monaco 交互保留光标、选区及撤销记录；只读或禁用输入区域维持原有状态。

安装、交互行为及异常处理见 [浏览器端说明](docs/USERSCRIPT-ONLY.md)。

## 作业提醒

提醒模块独立运行，采集作业快照并按截止时间生成本地待办或发送配置的通知。

```powershell
npm run reminder -- check
npm run reminder -- auth-check
npm run reminder -- sync
npm run reminder -- status
npm run reminder -- preview
npm run reminder -- run
```

未配置远端通道时使用本地输出。通知通道、去重、额度策略及状态说明见 [提醒模块文档](docs/REMINDER.md)。

## 主要配置

| 配置 | 说明 |
| --- | --- |
| `EDUCODER_AK` / `EDUCODER_SK` | 平台请求签名常量 |
| `EDUCODER_UI_PORT` / `EDUCODER_UI_TOKEN` | 本地监听端口与访问凭据 |
| `EDUCODER_EXPORT_ROOT` | 归档根目录，默认 `exports/` |
| `EDUCODER_NETWORK_LOG` | 可选网络诊断输出，默认关闭 |
| `EDUCODER_COURSE` / `EDUCODER_EXPERIMENTS` | CLI 预选范围 |
| `REMINDER_CHANNEL` / `SERVERCHAN_SENDKEY` | 提醒通道配置 |
| `EDUCODER_DATA_DIR` / `EDUCODER_PROFILE_DIR` | 提醒数据与浏览器配置目录 |

其他提醒策略与时间参数以配置模板为准。

## 虚拟环境扩展：设计思路

虚拟环境的文件交付可作为独立适配层：解析题目要求的目标目录和文件名，建立任务身份与本地最终文件的映射，通过上传通道传输，完成内容摘要校验后以要求的名称放入目标目录。需要结果确认时，应关联本次界面操作与新的评测状态，并保留互斥、停止、超时及失败中止机制。

上述内容仅描述设计方向。相关执行器、图形生成工具、实验文件、配置清单、探针、测试及过程文档仅保留在本地，已从仓库分发范围排除；当前仓库版本不提供虚拟环境提交入口。

## 开发与验证

```powershell
npm run check
npm test
npm run test:ui
npm run test:browser
npm run build:userscripts
```

离线测试使用合成数据与测试签名，无需真实账号。控制台浏览器测试覆盖选择范围、事件同步、数据处理入口、导出及响应式布局；粘贴测试覆盖选区、撤销与子框架。`EDUCODER_MONACO_ASSETS` 可指定本地 Monaco 资源以增加真实编辑器验证。

模块边界与 HTTP 接口见 [架构说明](docs/ARCHITECTURE.md)。用户脚本共享模块修改后需重新生成安装文件。

## 仓库范围

仓库仅包含通用实现、维护文档、配置模板及合成测试。`.env`、签名常量、浏览器会话、Cookie、`exports/`、`data/`、截图、诊断日志和本地实验版本均不纳入 Git 跟踪。

资料采集以当前账号的访问权限为边界。真实凭据、个人课程内容及实验产物不应进入测试夹具或提交记录。
