# 给 Agent 的实验作答说明

这份文档可以直接交给负责作答的 Agent。控制台负责抓取、整理和导出，项目不再调用模型接口。Agent 在本地读取题目、补全工作层答案，用户检查后自行决定如何使用。

## 1. 任务范围与输入

1. 阅读本说明及 [答案格式规范](AI-ANSWER-FORMAT.md)。格式以项目当前代码 `extractor/lib/answer-format.js`、`class-answers.js` 为准。
2. 按用户指定的课程、实验和关卡处理。用户没指定范围时，先列出本地待补全的实验，不默认修改整个答案库。
3. 每个实验先读 `exports/{课程}/{实验}/levels.jsonl` 与同目录的 `{实验}.md`。JSONL 同一关卡可能有多次记录，应以最后一条为准；可用 `level-store.readArchive` 与 `orderedLevels` 读取。
4. 需要图片时读取该实验的 `assets/`，不能凭未加载的图片猜题。
5. 优先处理缺答案及尚未验证的条目。已有 `verified: true` 答案应保留；用户明确要求修正时，说明原因并只修改对应条目。

控制台的“复制 Agent 任务”会提供当前范围与本地文件路径。工作答案路径也可从题目 Markdown 的 `answer_file` 读取，或使用 `archive-catalog.listTargets` 中的 `answerPath`，不要自行猜测课堂码。

### “只抓取已有答案”与“抓题后作答”的区别

- 默认抓取会保留题目存档和可取得的已有答案，适合后续交给 Agent 补全。
- “只抓取已有答案”只写答案文件，不创建 `levels.jsonl`、题目 Markdown 或图片。已有答案仍可直接汇总为班级文件。
- 如果某关没有题目且缺答案，先报告需要补抓的实验，不能编造题干或答案。只有答案文件时，格式校验不能证明题目覆盖度或答案正确性。
- 平台已有的选择题标准答案与已通过关卡的代码，可以作为已验证来源；未通过的编辑器草稿不能冒充标准答案。

## 2. 识别课程与关卡

身份必须同时核对：

| 层级 | 需要保留的字段 |
| --- | --- |
| 课堂 | `classroom.name`、`classroom.code`、已知时的 `classroom.id` |
| 实验 | `experiment.name`、`experiment.homework_id` |
| 关卡 | `level_id`、`task_identifier`、`title`、`kind` |

`level_id`（例如 `L001`）只在单个实验内唯一。课堂同名、实验同名时也不能混用答案；课堂码和作业号不同，应视为不同任务。如果当前存储路径发生身份冲突，停止合并并报告，不能覆盖另一份文件。

任务链接有单段与三段两种形式，`task_identifier` 都取 `/tasks/` 后的最后一段，不取课程码或作业号。

## 3. 写入实验工作答案

工作层位置：

```text
exports/answers/{课堂名称}（{课堂码}）/{实验名称}.answers.json
```

写入完整的 `schema_version: 2` 实验文档。以下示例仅说明结构，SQL 与选项应替换为当前题目的实际答案：

```json
{
  "schema_version": 2,
  "classroom": { "name": "示例课堂", "code": "DEMO001", "id": 0 },
  "experiment": { "name": "示例实验", "homework_id": 123 },
  "generated_at": "2026-10-25T00:00:00.000Z",
  "model": "external-agent",
  "answers": [
    {
      "level_id": "L001",
      "task_identifier": "example-code-task",
      "title": "示例代码题",
      "kind": "code",
      "source": "ai",
      "verified": false,
      "answer": { "language": "sql", "code": "SELECT 1;\n" }
    },
    {
      "level_id": "L002",
      "task_identifier": "example-choice-task",
      "title": "示例多问选择题",
      "kind": "choice",
      "source": "ai",
      "verified": false,
      "answer": {
        "questions": [
          { "number": 1, "selected": ["B"] },
          { "number": 2, "selected": ["A", "C"] }
        ]
      }
    }
  ],
  "unanswered": [
    { "level_id": "L003", "reason": "缺少题目依赖的图片，需要补抓后继续" }
  ]
}
```

- Agent 生成的答案使用 `source: "ai"`、`verified: false`；本地语法检查或格式校验通过也不能改为 `verified: true`。`model` 如实记录，不能冒称使用了未使用的模型。
- 编程题保存完整可执行代码，保留题目框架、文件路径约定及 Begin/End 标记；不要写省略号、伪代码或“此处填答案”等占位内容。SQL 实验也按原始文件和数据库要求作答。
- 选择题的每个小问分别写 `number` 与 `selected` 数组，单选也使用数组；多选字母去重并按升序排列，不能超出实际选项范围。
- 同一文件中一个 `level_id` 只出现一次。未解决的关卡写入 `unanswered` 并给具体原因；不要删除其他关卡的答案。
- 更新已有文件前先读旧内容，按关卡合并，保持来源、验证状态和身份元数据。推荐调用 `answer-store.mergeAnswers`（条目数组）或 `mergeAnswer`（单条），这些函数会保护已验证答案、检查身份冲突并原子写入。若返回 `ok: false`，必须处理错误。
- 损坏 JSON、未来版本文档和身份冲突不能通过覆盖原文件“修复”；保留原文件并报告。

## 4. 校验并汇报

在项目根目录运行：

```powershell
# 可限定为当前处理的课程与实验，避免把其他未完成实验算进本次任务
node tools/validate-answers.js "课程名称" "实验名称"
npm run check-fit
```

`validate-answers` 检查结构、题型、覆盖度、选项和框架等能从本地资料确定的内容；`check-fit` 核对关卡和选择题分组。没有题目时不能进行完整的内容适配校验，要在报告里说明。另按题目语言做适用的编译、语法或本地测试，不能将格式校验结果称为平台通过。

汇报内容至少包含：修改了哪些文件、完成与未完成的关卡、保留了哪些已验证答案、运行了哪些检查、仍缺少哪些上下文。

## 5. 导出给篡改猴的班级文件

工作层实验答案与脚本分发文件是两种不同的 v2：

| 用途 | 顶层结构 | 位置 |
| --- | --- | --- |
| Agent/抓取器写入的实验工作答案 | `schema_version: 2`、`classroom`、`experiment`、`answers` | `exports/answers/{课堂}（{码}）/{实验}.answers.json` |
| 汇总后给脚本导入的班级文件 | `version: 2`、`kind: "class-answers"`、`class`、`classrooms` | `exports/answers/{年级}-{班级}.answers.json` |

在控制台“导出班级答案”填写年级、班级，或运行：

```powershell
npm run build-class-answers -- --grade="2024级" --class="示例班级"
```

已有班级文件时命令可沿用其中的年级、班级信息；首次导出要使用用户给出的真实班级名，不能随意替用户决定。仅答案实验也会参与汇总，不要求补造题目存档。

输出的班级文件交给用户审查、再导入篡改猴。Agent 的本轮任务默认到本地文件与验证报告为止，不自动登录平台、点击评测、提交或修改课程进度。

## 6. 处理范围

工作文件仅承载受支持的代码与选择题结构。需要专用文件格式或外部执行环境的内容应列入未处理项，注明所需材料与验证条件，不转换为伪造的 `answer.code`。
保留已有通过记录；没有执行结果时不能将本地检查标记为平台验证通过。不要打开平台参考答案或检索现成作业答案。
