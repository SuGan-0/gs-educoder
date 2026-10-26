# 本地存储与数据流

## 文件布局

```text
exports/
  {课程}/{实验}/
    levels.jsonl                     # 追加式题目存档，同一关最后一条有效
    {实验}.md                        # 由存档生成，供外部 Agent 阅读
    {实验}.metadata.json
    assets/
  answers/
    {课堂}（{课堂码}）/{实验}.answers.json # schema_version:2 工作答案
    {年级}-{班级}.answers.json         # version:2 / class-answers 发布文件
  logs/                              # 用户脚本回传日志

data/
  ...                                # 作业提醒数据，参见 REMINDER.md
```

题目根目录可由 `EDUCODER_EXPORT_ROOT` 指定，默认为项目 `exports/`。题目 Markdown 的 `answer_file` 与产物目录的 `answerPath` 是工作答案定位依据，不要凭名称猜课堂码。

只抓已有答案时仅写工作答案，不生成题目 JSONL、Markdown、metadata 或图片。`archive-catalog` 会统一发现两类实验；仅答案文档也能汇总发布，不需要伪造存档。缺少题目时只能做有限结构检查，不能证明内容覆盖度。

## 写入和合并

`level-store` 对关卡存档追加；派生 Markdown 和 metadata 可用 `node tools/build-exports.js` 重建。答案通过 `answer-store` 串行化同文件操作，以临时文件原子替换，保留其他关卡和来源信息；已验证答案受保护。

班级发布由 `class-answers` 构建、校验和合并；本轮未获取的旧答案保留。损坏旧文件或未知未来版本时拒绝覆盖。不同课堂码、作业号应隔离，不能仅凭相同课程/实验名合并。

## 工作流

1. 抓取器保存题目与可取得的已有答案。
2. 用户将控制台复制的范围和 [Agent 作答说明](AGENT-ANSWERING.md) 交给外部 Agent。
3. Agent 合并工作答案，运行适用的本地检查并报告未完成项。
4. 控制台或 CLI 导出班级发布文件，篡改猴导入或通过 `/api/answers` 拉取。
5. 浏览器端脚本按当前任务身份使用本地记录并同步处理结果。

项目不再保存或使用 `submit.blueprint.json`，也不再有内置模型作答。用户脚本 GM 存储保留导入答案、身份映射、队列、签名、日志和面板偏好；导出全部答案可用于迁移。

## 私有状态

`.env`、`.educoder-keys.json`、`.educoder-browser/` 与 Cookie 备份包含配置或登录信息；`exports/`、`data/`、`.shots/` 和诊断日志均属于本地产物，已忽略。不要把真实凭据或个人课程数据加入测试。

`EDUCODER_NETWORK_LOG` 默认关闭，开启后可能记录私有请求/响应，分享前需检查。不要在控制台或提醒程序仍占用时删除浏览器配置；换环境后应重新登录。本文不要求删除任何现有数据。
