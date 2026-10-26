# Agent 答案格式规范

本文件规定题目存档、工作答案和篡改猴导入文件之间的契约。控制台负责抓取、整理和发布；Agent 读取题目后在本地生成答案，不需要控制台调用模型 API。

完整操作步骤和可复制的 Agent 指令见 [Agent 作答指南](AGENT-ANSWERING.md)。

## 文件组织

```text
exports/
├── 数据库系统原理-软工24级/
│   └── MySQL-数据的插入、修改与删除(Insert,Update,Delete)/
│       ├── levels.jsonl                 # 题目存档，每关一行
│       ├── 实验名.md                    # Agent 阅读的题目视图
│       ├── 实验名.metadata.json
│       └── assets/
└── answers/
    ├── 数据库系统原理-软工24级（D9Z6O8GR）/
    │   └── 实验名.answers.json          # 工作答案 schema_version: 2
    └── 2024级-软工24-15、16班.answers.json # 发布文件 version: 2, kind: class-answers
```

两个版本号属于不同文件类型。Agent 编辑每实验的工作答案；篡改猴导入一个班级的发布文件。文件名里的课堂码是平台 `course_identifier`；作业号对应 `homework_common_id`。

题目 Markdown 的 frontmatter 包含 `answer_file`。以该路径为准，不重新拼接文件名；旧的 `answers/{课堂}__{实验}.answers.json` 位置只读兼容。目录名或实验名里的非法字符会安全化，写入时还会核对正文身份，防止不同名称落到同一个路径后互相覆盖。

## 只提取答案

“只提取答案”读取已通过测评的提交结果，生成同样的工作答案 v2。通过判据是 `game.final_score >= challenge.score` 且满分大于零；未通过、无答案、非编程/选择题都会跳过。

- 编程题取用户仓库里的已提交完整代码；只有已通过的编程题需要额外读取文件。
- 选择题取 `choose_test_cases.test_sets`，按 `position` 保留每个小问；优先采用非空 `standard_answer`，否则采用 `actual_output`。多选连写如 `CA` 归一化为 `["A", "C"]`。
- 该模式不生成 `levels.jsonl`、题目 Markdown、metadata 或图片。发布扫描直接识别工作答案目录，关卡身份、标题、题型和作业号从答案文档补齐，不依赖题目存档。
- 未通过的关卡不会因此获得答案；需要 Agent 解答时，先正常抓取题目。

## Agent 读取与作答

1. 阅读实验的 Markdown，并按需检查 `levels.jsonl`、初始代码、测试说明和 `assets/` 图片。
2. 使用原始 `level_id`、`task_identifier`、标题、课堂码和作业号。`L001` 只在当前实验里唯一，不能跨实验单独用它匹配。
3. 编程题给完整可运行代码，保留题目框架和 begin/end 标记；选择题按原题号逐问回答，所有多选选项都要保留。
4. 无法确定的关卡写入 `unanswered` 并说明原因。没有平台通过证据时，`verified` 必须为 `false`。
5. 合并到已有工作文件，保留未处理关卡、人工改过的元信息和平台验证通过的答案；校验后重新导出班级文件供脚本导入。

工作文件的每条答案均使用下面的 v2 结构。程序内部用扁平 `code/language` 或 `questions`；经过 `answer-format.stringifyDocument()` 落盘后才变成嵌套 `answer`，不要把内部结构直接写成发布文件。

## 工作答案 v2

```json
{
  "schema_version": 2,
  "classroom": { "name": "数据库系统原理-软工24级", "code": "D9Z6O8GR", "id": 0 },
  "experiment": { "name": "MySQL练习", "homework_id": 3962949 },
  "generated_at": "2026-10-25T00:00:00.000Z",
  "model": "",
  "answers": [
    {
      "level_id": "L001",
      "task_identifier": "任务URL最后一段",
      "title": "插入数据",
      "kind": "code",
      "source": "ai",
      "verified": false,
      "answer": { "language": "sql", "code": "INSERT INTO customers (id) VALUES (1);" }
    },
    {
      "level_id": "L002",
      "task_identifier": "另一关标识",
      "title": "选择题",
      "kind": "choice",
      "source": "export",
      "verified": true,
      "answer": {
        "questions": [
          { "number": 1, "selected": ["A", "C"] },
          { "number": 2, "selected": ["B"] }
        ]
      }
    }
  ],
  "unanswered": [{ "level_id": "L003", "reason": "题目依赖的图片缺失，无法确认" }]
}
```

| 字段 | 含义 |
| --- | --- |
| `schema_version` | 固定为 `2`；更高版本拒绝写入覆盖 |
| `classroom.name/code/id` | 平台课堂名称、课堂码和数字 id；没有数字 id 时为 `0` |
| `experiment.name/homework_id` | 实验名称和作业号；已有非零作业号不得替换成另一个作业号 |
| `task_identifier` | 任务 URL 最后一段；三段式 `/tasks/{课程}/{作业}/{标识}` 也只取最后一段 |
| `kind` | 每关独立选择 `code` 或 `choice`，同一实验允许混合 |
| `source` | `ai`（含 Agent 生成）、`manual`、`platform`、`export` 或兼容旧数据的 `unknown` |
| `verified` | 真正通过平台测评才写 `true`；Agent 推理或本地测试通过不能代替平台测评 |
| `model` | 可选的历史来源记录，不配置模型也能使用；不是验证通过的凭据 |
| `unanswered` | 无法解答的关卡和原因，不能悄悄删去关卡 |

选择题规范落盘使用 `answer.questions`。输入解析仍兼容 `"A"`、`"A,C"`、`"1:A;2:B,D"`，但 Agent 直接编辑文件时应使用上面的结构化数组。题号从 1 开始，每题选项大写、去重并升序排列。

旧 v1 工作文件仍能读入并升级到 v2；目录/存档提供的课堂码和作业号可以补齐旧文件缺少的字段。

## 班级发布文件 v2

发布时把多个实验汇总成一个文件。示例：

```json
{
  "version": 2,
  "kind": "class-answers",
  "class": { "grade": "2024级", "name": "软工24-15、16班" },
  "classrooms": [
    {
      "name": "数据库系统原理-软工24级",
      "code": "D9Z6O8GR",
      "experiments": [
        {
          "name": "MySQL练习",
          "chapter": "",
          "homework_id": 3962949,
          "levels": [
            {
              "level_id": "L002",
              "position": 2,
              "title": "选择题",
              "kind": "choice",
              "identifiers": ["另一关标识"],
              "answered": true,
              "source": "export",
              "verified": true,
              "answer": [{ "number": 1, "selected": ["A", "C"] }, { "number": 2, "selected": ["B"] }]
            }
          ]
        }
      ]
    }
  ]
}
```

编程关的发布答案仍为 `{ "language": "sql", "code": "完整代码" }`；选择关发布答案是上面展示的数组。发布工具负责转换，Agent 不需要再手工维护一份班级文件。`source/verified`、课堂码、作业号和所有关卡标识都会保留。

```powershell
npm run build-class-answers -- --grade=2024级 --class=软工24-15、16班
```

也可以使用控制台的“导出班级答案文件”。导出后在篡改猴导入生成的 `kind: class-answers` 文件；脚本根据课堂码、作业号和关卡标识定位答案。

## 合并与校验

- 工作文件按当前实验的 `level_id` 合并并按序号保存，不清空其它关卡。缺失的关卡标识、标题和代码语言沿用已有值。
- 未验证答案默认不能覆盖平台验证通过的答案；明确需要替换时，程序调用 `mergeAnswers({ ..., overwriteVerified: true })`。
- 相同路径的写入排队合并，再用临时文件替换，避免并发回传丢掉关卡；内容未变时不重写时间戳和文件。
- 既有 JSON 损坏、版本过新、课堂身份或作业号冲突时返回错误并保留原文件。不要删掉错误文件后重新运行来绕过身份检查。
- 班级重新导出时，整关、整实验或整课堂暂时没抓到也保留旧内容。两边课堂码或非零作业号不同时不能仅凭同名套用答案；缺码的旧数据只有唯一同名候选时才兜底。

```powershell
node tools/validate-answers.js
node tools/validate-answers.js 数据库系统原理-软工24级 "MySQL-数据的插入、修改与删除(Insert,Update,Delete)"
```

校验检查题型、覆盖度、小问题号、选项范围和占位代码；未提供题目存档的仅答案产物无法完成依赖原题的检查，但仍能发布和导入。校验通过不等于平台测评通过。
