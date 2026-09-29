# 存储结构与 IO 设计

## 1. 先看量级（本仓库实测）

| 项 | 实测 | 结论 |
| --- | --- | --- |
| `exports/` 全部产物 | 0.39 MB / 76 文件 | 产物本身极小，单关 md 平均 **1.8 KB** |
| 抓一关的写入 | 旧实现：读回整个实验 md → 重渲染全部关卡 → 整份写 md + metadata | **N² 写放大**：N 关实验累计写入 ≈ N² × 1.8 KB / 2 |
| `.educoder-network.jsonl` | **20.12 MB** 单文件 / 2 万多行 | 真正的大头：每个 API 响应都 stringify 后追加一行 |
| `.educoder-browser/` | **135 MB / 1332 文件** | Chromium 自己的 profile（缓存 + 登录态），不是我们的 IO |

所以「IO 太大」的真实来源排序是：**网络日志 > Chromium profile > 产物写放大**。
产物的问题是**结构**（把数据库和视图混在一个文件里反复重写），不是体积。

## 2. 现在的结构：存档（一次写入）+ 视图（可重建）+ 集中的答案目录

```text
exports/
├── answers/                          ★ 所有实验的答案集中在这里
│   ├── {课程}__{实验}.answers.json     （机器可读，按 level_id 索引）
│   └── {课程}__{实验}.answers.md       （人可读，可选）
└── 课程/实验/
    ├── levels.jsonl                  ★ 存档：每关一行，只追加，永不读回（唯一事实来源）
    ├── 实验.md                        ← 视图：由存档生成，整轮结束时写一次
    ├── 实验.metadata.json             ← 视图：同上
    ├── assets/L00N-image-N.ext
    └── submit.blueprint.json         ★ 篡改猴的提交蓝图（从真实提交录制而来）
```

答案放在**一个文件夹**里（不在每个实验目录内），文件名用 `{课程}__{实验}` 标清归属；
`实验.md` 的 frontmatter 里写了 `answer_file: answers/{课程}__{实验}.answers.json`，
AI 照这个路径产出即可。格式规范见 [AI-ANSWER-FORMAT.md](AI-ANSWER-FORMAT.md)。
`submit.blueprint.json` 留在实验目录里（脚本按这个名字找）。

写入路径对比：

| | 旧实现 | 现在 |
| --- | --- | --- |
| 每关写入 | 读 md → 重渲染 N 关 → 写 md（整份）→ 写 metadata（整份） | **append 一行 `levels.jsonl`** |
| 写放大 | O(N²) | **O(N)** |
| 中断后果 | 可能留下半截 md | 存档完整，最坏丢最后一行（读取时只计数不报错） |
| 格式升级 | 必须重抓 | `node tools/build-exports.js` 重建视图 |
| 同关更新 | 就地覆盖小节 | 追加新行，**last-wins** |

`levels.jsonl` 每行的字段（见 `extractor/lib/level-store.js` 的 `toArchiveRecord`）：
`taskIndex / title / level / type / course / experiment / source / taskDescription /
programmingRequirements / testDescription / extraRequirements / starterCode / codeLanguage /
choices / choiceQuestions / withCodeFile / codePath / imageMap / images / contentHash / capturedAt`。

**注意**：图片 base64 不进存档（只存文件名），否则存档会膨胀几十倍。

## 3. 重建视图

```powershell
node tools/build-exports.js                  # 重建全部（幂等：内容没变就不写）
node tools/build-exports.js 课程名 实验名     # 只重建一个实验
node tools/build-exports.js --check           # 只检查：列出需要重建的实验（CI 可用）
```

它会顺带报告两类问题：存档里的**半截行**、以及**缺图片**的关卡。
`EDUCODER_EXPORT_ROOT` 一样生效。

## 4. 网络日志：默认关闭

`.educoder-network.jsonl` 是这套工具最大的 IO 来源（每个响应一次 stringify + append）。
现在**默认不写**，需要排查接口时才打开：

```powershell
$env:EDUCODER_NETWORK_LOG='1'                 # 写到 .educoder-network.jsonl
$env:EDUCODER_NETWORK_LOG='D:\tmp\x.jsonl'    # 写到别处
$env:EDUCODER_NETWORK_LOG='0'                 # 显式关闭（等同不设置）
```

已存在的 20MB 历史日志可以直接删：它只用于排查，不参与抓取、重建或作答。

`.educoder-browser/`（135MB）是登录态 + 浏览器缓存，删掉要重新登录；
想省空间就定期清理其中的缓存子目录，或把 profile 指到别处。

## 5. 从抓取到自动提交的数据流

```text
抓取      levels.jsonl  （每关一行，一次写入）
            │  node tools/build-exports.js / 整轮结束自动生成
            ▼
         实验.md                      ← 给 AI 看（frontmatter 里写明答案文件路径）
            │  控制台「AI 作答」面板：选课程/实验/关卡 → 模型出答案
            ▼
         answers/{课程}__{实验}.answers.json   ← 集中存放，按 level_id 索引
            │  GET /api/answers（本地控制台，带 token）
            ▼
         篡改猴：填答案 → 提交 → 下一关
            ▲
            └── submit.blueprint.json（真实提交录制一次，永久复用）

校验      node tools/validate-answers.js   （覆盖度 / 题型 / 选项字母 / 占位代码 / 课程实验一致性）
```

控制台新增的作答接口（都只动答案文件，不碰题目）：

| 接口 | 说明 |
| --- | --- |
| `GET /api/answer/targets?token=` | 列出可作答的课程/实验/关卡（来自关卡存档）+ 每个实验已有答案几关 |
| `POST /api/answer/run` | `{ course, experiments[], levels[]?, apiKey, baseUrl?, model? }` 启动作答任务 |
| `POST /api/answer/stop` | 请求停止作答任务 |
| `GET /api/state` | 快照里的 `answer` 字段 = 作答进度/结果（刷新页面可恢复） |
| `GET /api/answers?token=` | 优先读 `exports/answers/`，兼容实验目录内的早期产物 |

`API Key` 只存在控制台进程内存里，不写文件、不进日志、不回传前端。
