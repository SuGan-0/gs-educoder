# AI 答案格式规范

本文件定义两件事，必须成对使用：

1. **题目产物**（抓取工具写出）怎么组织，让模型能稳定读懂；
2. **答案文件**（AI 产出）长什么样 —— **所有实验的答案集中放一个文件夹**，文件名标清课程与实验。

---

## 1. 抓取产物的位置

```text
exports/
├── answers/                                       ★ 答案集中在这里，**按班级分目录**
│   ├── 机器学习_2026年下半年（HCEAP94S）/
│   │   ├── CNN.answers.json
│   │   └── 模型评估与选择.answers.json
│   └── 软件工程导论2026年下半年（2i6ng7vp）/
│       └── [1、软件工程初体验] 制定进度计划.answers.json
└── 机器学习_2026年下半年/              # 题目：一个班级一个文件夹
    └── CNN/                                       # 一个课堂实验一个文件夹
        ├── levels.jsonl                           # 关卡存档（唯一事实来源，每关一行）
        ├── CNN.md                                 ★ 题目正文，读它来作答
        ├── CNN.metadata.json                      # 结构化版本
        └── assets/L001-image-1.png                # 图片（文件名带关卡号）
```

**为什么按班级分目录**：班级边界因此是**结构性**的，而不是靠文件名里的一段字符串。
一个班几十个实验全平铺在 `answers/` 下会有几百个文件，也没法看。

目录名里的 `（HCEAP94S）` 是**课堂码**。旧位置
（`answers/{班级}__{实验}.answers.json`）仍然只读兼容，读到就升级。

`CNN.md` 的 frontmatter 里直接写了该实验对应的答案文件路径：

```yaml
---
course: 机器学习_2026年下半年
experiment: CNN
levels: 5
generated_at: 2026-10-01T08:00:00.000Z
answer_file: exports/answers/机器学习_2026年下半年（HCEAP94S）/CNN.answers.json
---
```

### 题目正文的结构（AI 的输入）

````markdown
# CNN

> 作答：把这一份文件的答案写成 `answers/示例课程B__CNN.answers.json`（格式见每关的「作答格式」）。
## 第1关：conv
- 关卡 id：L001
- 题型：编程题（code）
- 来源：https://www.educoder.net/tasks/zq2a7dad921e

### 任务描述 …
### 编程要求 …
### 初始代码
```python
def corr2d(X, K):
    ########## begin ##########
    ########## end ##########
    return Y
```
### 作答格式
```json
{ "level_id": "L001", "kind": "code", "language": "python", "answer": "完整代码（保留题目给的框架与 begin/end 标记）" }
```

---

## 第2关：欠拟合与过拟合
- 关卡 id：L002
- 题型：选择题（choice）

### 选择题
1. 下列说法正确的是？
   A. 甲
   B. 乙
   C. 丙
### 作答格式
```json
{ "level_id": "L002", "kind": "choice", "answer": "A" }
```
````

| 元素 | 约定 |
| --- | --- |
| `## 第N关：名称` | 一个关卡一节，N 是站点上的真实关卡号 |
| `- 关卡 id：Lxxx` | 答案用它指回关卡（`L001`、`L002`…） |
| `- 题型：` | `编程题（code）` 或 `选择题（choice）`，决定答案写法 |
| `### 任务描述 / ### 编程要求 / ### 初始代码 / ### 测试说明 / ### 作答要求` | 只有原文存在的才输出 |
| `### 选择题` | `N. 题干` + 三空格缩进 `A. / B. / C. …`（多小问按 1、2、3 编号） |
| `### 作答格式` | 该关的答案模板，照抄结构即可 |

产物**只包含编程题与选择题**：虚拟机/图形化实操、纯问答、阅读材料、空壳关卡一律丢弃，
并在日志与界面上记 `dropped` 计数（判据见 `docs/ARCHITECTURE.md`）。

正文只抽取 `任务描述 / 编程要求 / 测试说明 / 作答要求` 四类小节；`相关知识` 等教学铺垫被丢弃；
正文里原有的 `#`/`##` 标题会统一降到 `###`，不破坏关卡层级。

---

## 2. 答案格式：一关一条，只要「关卡题号 + 答案」

### 2.1 编程题：关卡题号 + 代码

```json
{ "level_id": "L001", "kind": "code", "language": "python", "answer": "def corr2d(X, K):\n    ...\n    return Y" }
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `level_id` | 是 | 与 md 里 `- 关卡 id：` 一致 |
| `kind` | 是 | 固定 `"code"` |
| `language` | 是 | 与 `### 初始代码` 的围栏语言一致（`python`/`java`/…） |
| `answer` | 是 | **完整代码**：保留题目给的框架与 `########## begin/end ##########` 标记，只补需要补的部分 |

### 2.2 选择题：关卡题号 + 选项字母

```json
{ "level_id": "L002", "kind": "choice", "answer": "B" }
```

| 写法 | 用于 | 例子 |
| --- | --- | --- |
| `"A"` | 单选题、单小问 | `"answer": "B"` |
| `"A,C"` | 多选（字母升序） | `"answer": "A,C"` |
| `"1:A;2:B,D"` | 一关有多个小问（题号从 1 开始，分号分隔） | `"answer": "1:C;2:A,B"` |

> 只有多个小问时才需要写题号；单一小问直接给字母即可。字母必须落在该题的选项范围内
> （校验脚本会检查，`A`–`H` 有效）。

### 2.3 完整答案文件（落盘格式 v2）

**注意区分两件事**：模型只输出 2.1 / 2.2 的最简写法；**落盘**是这个结构化格式。
转换由代码完成（`extractor/lib/answer-format.js`），不交给模型。

```json
{
  "schema_version": 2,
  "classroom": { "name": "机器学习_2026年下半年", "code": "HCEAP94S", "id": 120386 },
  "experiment": { "name": "CNN", "homework_id": 3965745 },
  "generated_at": "2026-10-01T08:00:00.000Z",
  "model": "deepseek-chat",
  "answers": [
    {
      "level_id": "L001",
      "task_identifier": "vrtbzlmexi3f",
      "title": "conv",
      "kind": "code",
      "source": "ai",
      "verified": false,
      "answer": { "language": "python", "code": "def corr2d(X, K):\n    ...\n    return Y" }
    },
    {
      "level_id": "L002",
      "task_identifier": "glz47yx2f8vb",
      "title": "欠拟合与过拟合",
      "kind": "choice",
      "source": "platform",
      "verified": true,
      "answer": { "questions": [{ "number": 1, "selected": ["B"] }] }
    }
  ],
  "unanswered": [
    { "level_id": "L005", "reason": "题干依赖图片，图未下载成功" }
  ]
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `schema_version` | 是 | 当前为 `2`。读到**更大**的版本会拒绝解析，不猜未来格式 |
| `classroom.name` / `classroom.code` | 是 | `code` 是平台课堂码（`course_identifier`）。**篡改猴靠它核对班级** |
| `experiment.name` / `experiment.homework_id` | 是 | `homework_id` 即 `homework_common_id` |
| `answers[]` | 是 | 一关一条，字段见下表 |
| `generated_at` / `model` | 建议 | 便于判断新鲜度与来源 |
| `unanswered[]` | 可选 | 无法作答的关卡必须显式列出并给 `reason`，**不允许静默跳过** |

每条答案：

| 字段 | 说明 |
| --- | --- |
| `level_id` | `L001`，文件内的关卡序号 |
| `task_identifier` | **平台关卡标识**（任务 URL 最后一段）。答案与关卡之间最稳的对应关系 |
| `title` | 关卡名，供按内容兜底匹配 |
| `kind` | `code` / `choice` |
| `source` | `ai` / `manual` / `platform` / `export` / `unknown` |
| `verified` | 平台是否确认这条答案能过。抓取端导出与篡改猴回传默认 `true`，AI 产出默认 `false` |
| `answer` | 编程题 `{ language, code }`；选择题 `{ questions: [{ number, selected: ["A","C"] }] }` |

**选择题为什么不再用 `"1:A;2:B,D"` 字符串**：那种写法在答案文件、控制台、篡改猴里
各有一套解析，改一处要三处一起改，改漏就静默出错。现在是结构化数组，只有一处定义。

**v1 仍然能读**（自动升级），但只写 v2。

### 2.4 人可读版（可选）

同名 `.answers.md`，便于快速复核：

````markdown
---
course: 示例课程B
experiment: CNN
answered: 3
generated_at: 2026-09-25T04:00:00.000Z
---

# CNN 参考答案

## 第1关：conv（L001，编程题）
```python
def corr2d(X, K):
    ...
```

## 第2关：欠拟合与过拟合（L002，选择题）
1. **B**
````

### 2.5 校验

```powershell
node tools/validate-answers.js               # 校验全部实验
node tools/validate-answers.js 示例课程B CNN
```

检查：① 每关都有答案；② 题型与存档一致；③ 选择题字母不越界、小问不缺；
④ 编程题不是占位文本、保留了题目框架标记；⑤ 班级名/实验名与目录一致。
退出码 0 通过、1 有问题。

### 2.6 班级：为什么答案里必须有课堂码

同一个实验（同名、同关卡名）可能**同时存在于多个班级**里。旧实现只按平台关卡标识、
或退一步按「实验名__关卡名」匹配——标识对不上时就靠名字兜底，于是可能把**别的班**的
答案填进来。按名字兜底本身是必要的（平台重新发布实验会换掉一整组标识），
但兜底之后必须再确认「这份答案确实属于当前班级」。

因此答案里带 `classroom.code`（平台课堂码），三处都会核对：

| 位置 | 核对什么 |
| --- | --- |
| 落盘（`answer-store.mergeAnswers`） | 文件里已有课堂码且与本次不同 → **拒绝写入**（说明文件被放错了目录） |
| 控制台（`POST /api/answer/save`） | 脚本报的课堂码与关卡存档里的不一致 → **拒收** |
| 篡改猴（作答前） | 答案的 `classroomCode` 与当前页面 `course_identifier` 不一致 → **拒绝作答** |

**班级从哪来**：关卡页 URL（`/tasks/{课程码}/{作业ID}/{关卡标识}`）里**没有**班级码，
只有关卡数据里有 —— `tasks/{id}.json` 的 `course_identifier` 就是课堂码。
所以脚本要先读到关卡数据才能核对；还没读到时不拦（只记提示），否则页面刚打开就没法用。

另外两条「不拦只提示」的情况：答案是老答案库（没有班级码）、以及这一关本来就没答案。

---

## 3. 生成答案的提示词（可直接复制）

```text
你是头歌（Educoder）实验题的解题助手。

输入：一个实验的题目文件（frontmatter + 每关一节，含 关卡 id / 题型 / 任务描述 / 编程要求 /
初始代码 / 选择题 / 作答格式）。

输出：只输出一个 JSON 文件，写到 frontmatter 里 answer_file 指定的路径（answers/{课程}__{实验}.answers.json）：

{
  "course": "<frontmatter 里的 course>",
  "experiment": "<frontmatter 里的 experiment>",
  "answers": [
    { "level_id": "L001", "kind": "code", "language": "python", "answer": "完整代码" },
    { "level_id": "L002", "kind": "choice", "answer": "B" }
  ]
}

规则：
1. 一关一条，level_id 必须与题目里的关卡 id 完全一致；
2. 编程题：给可运行的完整代码，保留题目框架与 begin/end 标记，不要改动无关代码；
3. 选择题：只给选项字母；多选写成 "A,C"（升序）；一关多小问写成 "1:A;2:B,D"；
4. 无法确定的关卡写进 unanswered 并说明原因，禁止编造题干、选项或评测结果；
5. 不要输出理由、讲解或题目重述。
```

## 4. 从答案到自动提交

```text
题目 CNN.md  ──►  AI  ──►  answers/{班级}（{课堂码}）/{实验}.answers.json
                                    │
                    GET /api/answers?token=...（本地控制台，只读汇总）
                                    ▼
     篡改猴：核对班级 → 按 level_id 取答案 → 填答 → 提交 → 下一关
```

答案文件除了「AI 作答」，还有两条**平台侧自动产生**的路径（都写同一个规范文件，合并规则一致：
同一 `level_id` 覆盖并保持顺序，其它关卡原样保留）：

1. **抓取端**：关卡「已通过测评」（`game.final_score >= challenge.score`）时，抓取时顺手把
   提交的代码（`rep_content.json`，带签名请求）或所选项
   （`choose_test_cases.test_sets[].actual_output`）导成答案，不用打开关卡页、也不用重新提交；
2. **篡改猴**：提交通过后自动把答案回传控制台（`POST /api/answer/save`），选择题优先取平台
   标准答案（`standard_answer`），编程题取刚提交的编辑器内容。该实验必须先在控制台抓取过
   （否则控制台不知道关卡属于哪个课程/实验，会明确报错而不猜目录）。

`GET /api/answers` 返回 `{ ok, answers: { 班级__实验__L001: {...} }, experiments, blueprints, files, answerDir }`；
`answers` 里的每条都是**与磁盘一致的 v2 结构**（`answer: { language, code }` /
`answer: { questions: [...] }`），并额外带 `course` / `classroomName` / `classroomCode` / `experiment`，
脚本靠 `classroomCode` 核对班级、确认没拿错实验或班级的答案。

> 键为什么是 `班级__实验__L001` 而不是 `L001`：`level_id` 只在单个实验内唯一，
> 多个实验聚合到同一个对象时会互相覆盖（实测两个实验的 L001 打架，用户在关卡页上
> 拿到的是别实验的答案）。
