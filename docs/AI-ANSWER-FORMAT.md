# AI 答案格式规范

本文件定义两件事，必须成对使用：

1. **题目产物**（抓取工具写出）怎么组织，让模型能稳定读懂；
2. **答案文件**（AI 产出）长什么样 —— **所有实验的答案集中放一个文件夹**，文件名标清课程与实验。

---

## 1. 抓取产物的位置

```text
exports/
├── answers/                                  ★ 所有答案集中在这里
│   ├── 机器学习_2026年下半年__CNN.answers.json
│   ├── 机器学习_2026年下半年__CNN.answers.md
│   └── 软件工程导论2026年下半年__单元测试.answers.json
└── 机器学习_2026年下半年/                     # 题目：一门课一个文件夹
    └── CNN/                                   # 一个课堂实验一个文件夹
        ├── levels.jsonl                       # 关卡存档（唯一事实来源，每关一行）
        ├── CNN.md                             ★ 题目正文，读它来作答
        ├── CNN.metadata.json                  # 结构化版本
        └── assets/L001-image-1.png            # 图片（文件名带关卡号）
```

**答案文件命名**：`{课程}__{实验}.answers.json`（双下划线分隔，非法字符替换为 `～`）。
`CNN.md` 的 frontmatter 里直接写了该实验对应的答案文件名：

```yaml
---
course: 机器学习_2026年下半年
experiment: CNN
levels: 5
generated_at: 2026-09-25T03:00:00.000Z
answer_file: answers/机器学习_2026年下半年__CNN.answers.json
---
```

### 题目正文的结构（AI 的输入）

````markdown
# CNN

> 作答：把这一份文件的答案写成 `answers/机器学习_2026年下半年__CNN.answers.json`（格式见每关的「作答格式」）。
## 第1关：conv
- 关卡 id：L001
- 题型：编程题（code）
- 来源：https://www.educoder.net/tasks/vrtbzlmexi3f

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

### 2.3 完整答案文件

```json
{
  "course": "机器学习_2026年下半年",
  "experiment": "CNN",
  "generated_at": "2026-09-25T04:00:00.000Z",
  "model": "MODEL_ID",
  "answers": [
    { "level_id": "L001", "kind": "code", "language": "python", "answer": "def corr2d(X, K):\n    ...\n    return Y" },
    { "level_id": "L002", "kind": "choice", "answer": "B" },
    { "level_id": "L003", "kind": "choice", "answer": "1:A;2:B,D" }
  ],
  "unanswered": [
    { "level_id": "L005", "reason": "题干依赖图片，图未下载成功" }
  ]
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `course` / `experiment` | 是 | 必须与 `answers/` 文件名及题目目录一致（校验脚本会比对） |
| `answers[]` | 是 | 一关一条，字段见 2.1 / 2.2 |
| `generated_at` / `model` | 建议 | 便于判断新鲜度与来源 |
| `unanswered[]` | 可选 | 无法作答的关卡必须显式列出并给 `reason`，**不允许静默跳过** |

也兼容以关卡 id 为键的写法（`{ "L001": {...}, "L002": {...} }`），但推荐用上面的数组形式。

### 2.4 人可读版（可选）

同名 `.answers.md`，便于快速复核：

````markdown
---
course: 机器学习_2026年下半年
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
node tools/validate-answers.js 机器学习_2026年下半年 CNN
```

检查：① 每关都有答案；② 题型与存档一致；③ 选择题字母不越界、小问不缺；
④ 编程题不是占位文本、保留了题目框架标记；⑤ `course`/`experiment` 与目录一致。
退出码 0 通过、1 有问题。

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
题目 CNN.md  ──►  AI  ──►  answers/课程__实验.answers.json
                                    │
                    GET /api/answers?token=...（本地控制台，只读汇总）
                                    ▼
                       篡改猴：按 level_id 取答案 → 填答 → 提交 → 下一关
```

答案文件除了「AI 作答」，还有两条**平台侧自动产生**的路径（都写同一个规范文件，合并规则一致：
同一 `level_id` 覆盖并保持顺序，其它关卡原样保留）：

1. **抓取端**：关卡「已通过测评」（`game.final_score >= challenge.score`）时，抓取时顺手把
   提交的代码（`rep_content.json`，带签名请求）或所选项
   （`choose_test_cases.test_sets[].actual_output`）导成答案，不用打开关卡页、也不用重新提交；
2. **篡改猴**：提交通过后自动把答案回传控制台（`POST /api/answer/save`），选择题优先取平台
   标准答案（`standard_answer`），编程题取刚提交的编辑器内容。该实验必须先在控制台抓取过
   （否则控制台不知道关卡属于哪个课程/实验，会明确报错而不猜目录）。

`GET /api/answers` 返回 `{ ok, answers: { L001: {...} }, experiments, blueprints, files, answerDir }`；
`answers` 里的每条都带 `course` / `experiment`，方便脚本确认没拿错实验的答案。
