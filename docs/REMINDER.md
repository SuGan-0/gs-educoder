# 作业提醒：数据契约与设计

本文件说明「作业提醒」这条链路的**数据契约、状态语义与边界**，
面向要改它的人。用法见 [README「作业提醒」](../README.md#作业提醒每天自动抓取--截止时间推送)。

参考实现是 `ppxxforever/fuck-educoder`（Python + uv + Playwright + SQLite）。
本模块**移植的是它的采集语义与提醒策略，不是代码**：本项目保持 Node 单栈，
并复用已有的签名请求层与浏览器登录态。

---

## 1. 模块划分

```text
extractor/
  reminder.js                    # CLI：check / auth-check / sync / preview / once / run / test / test-upcoming
  lib/homework-model.js          # 纯函数：身份、时间解析、提醒状态判定
  lib/homework-collector.js      # 采集：课堂发现 + 两类作业分页（传输层注入）
  lib/reminder-store.js          # SQLite：作业快照 + 推送记账
  lib/reminder-plan.js           # 纯函数：筛选、去重退避、渲染、分批
  lib/push-serverchan.js         # Server 酱通道（Turbo / SC3）
  lib/notify-local.js            # 本地通道：待办视图 + 提醒流水（不发手机）
  lib/process-lock.js            # 单实例进程锁（PID 感知）
```

分层原则与项目其余部分一致：**能离线测的必须是纯函数**。
`homework-collector.js` 的传输层是注入的（`get(path, params)`），
所以分页完整性、状态判定、归档过滤这些最容易出错的逻辑全部可离线回归。

### 命令与依赖

| 命令 | 需要登录态 | 需要 SendKey | 联网 | 投递 |
| --- | --- | --- | --- | --- |
| `check` | 否 | 仅微信通道 | 否 | 否 |
| `auth-check` | 是 | 否 | 是 | 否 |
| `sync` | 是 | 否 | 是 | 否 |
| `status` | 否 | 否 | 否 | 否 |
| `preview` | 否 | 否 | 否 | 否 |
| `once` / `run` | 是 | 仅微信通道 | 是 | 是 |
| `test` | 否 | 仅微信通道 | 否（本地通道） | 是 |
| `test-upcoming [--days=N]` | 视有无快照 | 仅微信通道 | 视有无快照 | 是 |

`auth-check` / `sync` / `status` / `preview` **完全不需要 SendKey**：
采集链路、本地视图和推送配置是三件事，不该互相阻塞。

### 投递通道

| 通道 | `REMINDER_CHANNEL` | 产物 / 行为 |
| --- | --- | --- |
| 本地 | `local`（无 SendKey 时的默认） | `data/pending-reminders.md`（重写）＋ `data/reminders.log`（追加） |
| 微信 | `serverchan` | POST 到 Server 酱 Turbo / ³ |

**两个通道共用同一套 `push_attempts` / `push_events` 记账**，所以通道可以随时切换、
数据不用迁移；「同一截止时间、同一阶段只提醒一次」的语义也完全一致。

本地通道下 `data/pending-reminders.md` 是「当前全部待办」（按紧急程度分档），
`reminders.log` 是「已触发的提醒流水」——前者答「还剩什么没做」，后者答「什么时候提醒过什么」。

本地通道**不会主动叫人**：1 小时提醒只是往 `reminders.log` 追加一段。
要「到点就响」必须用推送通道。

### 浏览器启动

无头模式显式使用 `channel: 'chromium'`。Playwright 的 `headless: true` 默认去找
`chrome-headless-shell`，而多数环境只装了完整 chromium，会报「Executable doesn't exist」。
`profileDir` 被占用（控制台还开着、或上次崩溃残留）时重试 3 次，仍失败就给可操作的提示。
详见 `reminder.js` 的 `launchContext()`。

---

## 2. 身份：一个作业由什么唯一确定

```text
accountId + classroomCode + kind + homeworkId
```

- `accountId`：`get_user_info.json` 返回的 `login`，**不硬编码**；
- `classroomCode`：课堂（班级）的机器标识，取自课程行的 `first_category_url`
  （形如 `/classrooms/{code}/...`）；
- `kind`：`4` 课堂实验 / `1` 图文作业；
- `homeworkId`：平台作业主键。

名称（课堂名、作业名）**只用于展示，不参与身份**。
历史实现把「课程名 + 实验名」当目录名和文件名，同名课堂或平台重新发布作业时会互相覆盖。

> **「班级」的定义**：本模块把班级定义为**平台课堂**（`classroomName` + `classroomCode`）。
> 如果将来要支持「课堂内分组」，必须另找可信字段，**不得用课堂名冒充组名**。

---

## 3. 时间语义

平台给的是**北京时间墙上时间**（如 `2026-09-25 12:00:30`）。解析规则：

1. 带时区后缀（`Z` / `+08:00`）→ 按原时区解释；
2. 不带 → 按 `+08:00` 解释；
3. 空值 / `--` → `null`；
4. **解析不出来 → 抛错**。

第 4 条是刻意的：把「老师写了句中文当截止时间」当成「没有截止时间」，
会直接导致漏提醒。宁可整批失败，也不静默降级。

截止时间字段优先级：**`end_time_s`（精确的个人/分组截止）→ `end_time`**。
补交时间 `late_time` **不参与**。

---

## 4. 提醒状态

`reminderState(homework, nowMs)` 的顺序即优先级，每一条对应一个「不提醒」的理由：

| 顺序 | 状态 | 含义 | 是否提醒 |
| --- | --- | --- | --- |
| 1 | `archived` | 已归档 | 否 |
| 2 | `completed` | 已完成 | 否 |
| 3 | `unknown_completion` | 完成状态无法识别 | 否（**不推断为未完成**） |
| 4 | `unpublished` | 状态文案含「未发布」，或发布时间在未来 | 否 |
| 5 | `unknown_publication` | 拿不到发布时间 | 否 |
| 6 | `no_deadline` | 未设置截止时间 | 是（单独一档） |
| 7 | `overdue` | 已过截止时间 | 否 |
| 8 | `pending` | 未截止且未完成 | 看窗口 |

`pending` **只表示「尚未截止且未完成」，不表示现在就该发提醒**。
是否进入 24 小时 / 1 小时窗口，由 `reminder-plan.js` 按当时时间重新计算。

完成状态字段：课堂实验看 `shixun_finished_status`，图文作业看 `un_commit_work`。
两者都只在能明确判断时给布尔值，否则 `null`。

---

## 5. 三阶段提醒与去重

| 阶段 | 触发条件 | 说明 |
| --- | --- | --- |
| `1h` | 剩余 ≤ 1 小时 | 进入该窗口后**只发紧急阶段**，不再叠加 `24h` |
| `24h` | 1 小时 < 剩余 ≤ 24 小时 | — |
| `undated` | 无截止时间 | 按 `once`（每阶段一次）或 `daily`（每天一次）分桶 |

**事件键**（去重单位）是以下字段的 sha256：

```text
accountId, classroomCode, kind, homeworkId,
deadline,            ← 延期会改变它
revision,            ← 截止时间被修改的次数，双保险
stage, bucket
```

因此**老师延期后会重新提醒**，而同一截止时间、同一阶段只会发一次。

**退避**：失败后第 1 次等 5 分钟、第 2 次等 30 分钟；单事件最多尝试 3 次。
`sent` / `skipped` / 尝试满 3 次的事件不再进入候选。

---

## 6. 快照一致性

`saveSnapshot(accountId, homeworks, nowIso, { scopes })` 全程在一个事务里：

1. 把该账号（或 `scopes` 指定范围）的 `present` 置 0；
2. 逐条 upsert，`present = 1`；
3. 截止时间与旧值不同 → 写一条 `deadline_changes`；
4. 更新 `sync_state`。

失败整体回滚，**旧快照与去重记录原样保留**。

`scopes` 的用途是「发送前复核」：只刷新本次真要提醒的
`(classroomCode, kind)`，不为了发一条提醒全量重抓。
传入范围外的作业会**抛错回滚**，避免把别的课堂误标为消失。

分页完整性（`homework-collector.js`）三道闸 + 重复检测，任一命中即整批失败：
`count` 变化、跨页重复、累计超过 `count`、提前遇到空页、超出安全页数。

---

## 7. 过滤规则

- **归档作业**：只计入分页数量，不解析内容、不入库、不提醒。
  （实测：列表接口在「已截止」筛选下仍会附带归档记录。）
- **逾期超过 `REMINDER_CUTOFF_DAYS`（默认 5 天）**：在读截止时间后就跳过，不再解析其余字段。
  设为 `0` 即关闭。**它只影响提醒视图**——题目存档不受影响。
- **不可访问的课堂**（`can_visited !== true`）：不采集，明确报错。

---

## 8. 单实例与进程锁

常驻服务由 systemd 拉起，用户也可能手工跑一条 `once`；两个进程同时跑会**重复推送**并白烧额度。
`lib/process-lock.js` 用锁文件挡住第二种情况。

判据是**进程是否还活着**（`process.kill(pid, 0)`），文件年龄（默认 6 小时）只作兜底：

- 只看年龄的话，进程被强杀（Ctrl+C、OOM、`kill -9`）后锁会一直留着，期间谁也别想启动；
- 反过来，一个跑了两小时的健康进程会被误判为陈旧而遭抢锁。

PID 复用会让「活着」不等于「就是那个进程」，此时结果是「多等一会儿」而不是「重复推送」，
方向是安全的。`SIGINT` / `SIGTERM` 也会释放锁，避免 systemd stop 后下次启动白等。

---

## 9. 安全

- SendKey 只用于计算接收方哈希（`sha256`）与发起推送，**不进日志、不进错误信息**；
  库中只存哈希。本地通道完全不接触任何密钥。
- 本地待办文件与流水写在 `data/` 下（已 gitignore）。它们含有作业名与课堂名，
  但**不含任何凭据**；分享给他人前仍应自行确认内容。
- 登录态复用 `.educoder-browser`，本链路不读取、不打印任何账号密码。
- 推送通道可注入（`transport`），离线测试不联网、不读环境变量。
- 只有服务端明确 `code === 0` 才算「已被接受」；网络异常一律记为「送达状态未知」并进入退避重试。

---

## 10. 与抓题链路的关系

| | 抓题（extractor） | 提醒（reminder） |
| --- | --- | --- |
| 范围 | 课程 → 实验 → 关卡正文 | 课堂 → 作业列表（元数据） |
| 写入 | `exports/`（题目、图片、答案） | `data/reminder.sqlite3` |
| 副作用 | 无（只读接口） | 推送通知 |
| 依赖 | Playwright 会话 + 签名头 | 同上 |

两者**互不写入对方的数据**。提醒链路不打开关卡、不写题目存档、不碰答案。
