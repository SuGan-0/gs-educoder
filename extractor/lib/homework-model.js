'use strict';

/**
 * 作业模型（纯函数）：把 Educoder 课堂作业接口的原始行解析成稳定结构，
 * 并给出「提醒状态」判定。
 *
 * 硬约束（与 lib/task-parser.js、lib/educoder-sign.js 同口径）：
 * **无 fs / 无网络 / 无 playwright**，`now` 一律由调用方注入，保证离线可测。
 *
 * ## 身份约定（本次重构的核心）
 *
 * 一个作业由四元组唯一确定：
 *
 *     accountId + classroomCode + kind + homeworkId
 *
 * 名称（课堂名 / 作业名）**只用于展示，不参与身份**。
 * 历史实现把「课程名 + 实验名」当目录名和文件名，同名课堂或平台重新发布作业时
 * 会互相覆盖；新模型不再允许这种情况。
 *
 * ## 「班级」是什么
 *
 * 本模块把「班级」定义为**平台课堂（classroom）**：
 * `classroomCode` 取自课程行的 `first_category_url`（形如
 * `/classrooms/{code}/...`），是平台侧稳定的机器标识；`classroomName` 是显示名。
 * 如果将来要支持「课堂内分组」，必须另找可信字段，**不得用课堂名冒充组名**。
 */

/** 两类作业：`type=4` 课堂实验、`type=1` 图文作业（与平台接口取值一致）。 */
const KINDS = {
  4: { key: 4, name: '课堂实验', slug: 'shixun_homework' },
  1: { key: 1, name: '图文作业', slug: 'common_homework' }
};

/**
 * 采集顺序：课堂实验在前、图文作业在后。
 *
 * 显式声明而不是 `Object.keys(KINDS)`——对象的整数键会被 JS 自动升序排列，
 * 那样顺序就变成 1→4，与这里的意图不一致，也容易在后续改动里被悄悄改掉。
 */
const KIND_ORDER = [4, 1];

const SITE_ORIGIN = 'https://www.educoder.net';

/** 北京时间固定 +08:00。不用 Intl/时区库：平台返回的就是北京时间墙上时间。 */
const BEIJING_OFFSET_MINUTES = 8 * 60;

/** 列表里「未发布」的标记文案。 */
const UNPUBLISHED_MARK = '未发布';

/** 解析失败一律抛这个，调用方据此**整批失败**而不是静默存半份。 */
class HomeworkError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HomeworkError';
  }
}

function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

/** 毫秒时间戳 → 北京时间 ISO 串（`YYYY-MM-DDTHH:mm:ss+08:00`）。 */
function toBeijingIso(ms) {
  const shifted = new Date(ms + BEIJING_OFFSET_MINUTES * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
    + `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}+08:00`;
}

/** 北京时间墙上时间字符串 → 毫秒时间戳（反过来用）。 */
function fromBeijingIso(iso) {
  const ms = Date.parse(String(iso || ''));
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * 解析平台返回的时间字段。
 *
 * 平台给的是**北京时间墙上时间**（如 `2026-09-25 12:00:30`），偶尔带时区后缀。
 * 解析不出来时**抛错**而不是返回 null —— 把「老师写了句中文当截止时间」当成
 * 「没有截止时间」，会直接导致漏提醒。
 *
 * @param {unknown} value
 * @returns {{iso: string, ms: number}|null} 空值返回 null
 */
function parseBeijingTime(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new HomeworkError('作业时间格式异常。');
  const text = value.trim();
  if (!text || text === '--') return null;
  const withT = text.includes('T') ? text : text.replace(' ', 'T');
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(withT);
  const ms = Date.parse(hasZone ? withT : `${withT}+08:00`);
  if (!Number.isFinite(ms)) throw new HomeworkError('无法解析作业时间，不猜测截止日期。');
  return { iso: toBeijingIso(ms), ms };
}

/**
 * 读截止时间：**优先精确的个人/分组截止时间 `end_time_s`，其次 `end_time`**。
 *
 * 明确**不使用**补交时间 `late_time` —— 那是补交窗口，不是正常截止时间。
 */
function readDeadline(row) {
  const precise = row && row.end_time_s;
  if (precise !== null && precise !== undefined && String(precise).trim() && String(precise).trim() !== '--') {
    return parseBeijingTime(precise);
  }
  return parseBeijingTime(row && row.end_time);
}

function kindOf(kind) {
  const entry = KINDS[Number(kind)];
  if (!entry) throw new HomeworkError('仅支持课堂实验（type=4）和图文作业（type=1）。');
  return entry;
}

/** `/classrooms/{code}/...` → code；取不到返回空串。 */
function classroomCodeFromPath(path) {
  const match = /\/classrooms\/([A-Za-z0-9_-]+)/.exec(String(path || ''));
  return match ? match[1] : '';
}

/**
 * 解析课程行 → 课堂（班级）。
 *
 * 只接受结构完整的行：缺 id / 名称 / 链接格式不对时抛错，
 * 由调用方决定整批失败（参考实现的同款策略：宁可重来，不要静默少存）。
 */
function parseClassroom(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new HomeworkError('课堂数据格式异常。');
  }
  if (!Number.isInteger(row.id)) throw new HomeworkError('课堂 ID 格式异常。');
  if (typeof row.name !== 'string' || !row.name.trim()) throw new HomeworkError('课堂名称缺失。');
  if (typeof row.is_end !== 'boolean') throw new HomeworkError('课堂缺少明确的结束状态。');
  const code = classroomCodeFromPath(row.first_category_url);
  if (!code) throw new HomeworkError('课堂链接格式异常，取不到课堂标识。');
  return {
    id: row.id,
    name: row.name.trim(),
    code,
    url: `${SITE_ORIGIN}/classrooms/${code}/${KINDS[4].slug}`,
    canVisit: row.can_visited === true,
    isEnd: row.is_end
  };
}

/**
 * 解析作业行 → Homework。
 *
 * @param {object} row 接口原始行
 * @param {{id: number, name: string, code: string}} classroom
 * @param {number} kind 4 或 1
 * @param {string} accountId 登录账号标识（身份隔离用）
 */
function parseHomework(row, classroom, kind, accountId) {
  const kindInfo = kindOf(kind);
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new HomeworkError('作业数据格式异常。');
  }
  if (!Number.isInteger(row.homework_id)) throw new HomeworkError('作业 ID 格式异常。');
  if (typeof row.name !== 'string' || !row.name.trim()) throw new HomeworkError('作业名称缺失。');
  if (typeof row.is_archive !== 'boolean') throw new HomeworkError('作业归档状态缺失。');
  const status = row.status;
  if (!Array.isArray(status) || status.some((item) => typeof item !== 'string')) {
    throw new HomeworkError('作业发布状态格式异常。');
  }
  if (!classroom || !classroom.code) throw new HomeworkError('缺少课堂标识，无法归属作业。');

  // 完成状态：两类作业用的字段不同；无法识别时保持 null（「未知」），
  // **绝不推断为未完成**——否则会对已交作业反复提醒。
  let completed = null;
  if (Number(kind) === 4) {
    const value = row.shixun_finished_status;
    if (Number.isInteger(value) && (value === 0 || value === 1)) completed = value === 1;
  } else {
    const value = row.un_commit_work;
    if (typeof value === 'boolean') completed = !value;
  }

  const deadline = readDeadline(row);
  const publishAt = parseBeijingTime(row.publish_time);

  return {
    accountId: String(accountId || ''),
    classroomId: classroom.id,
    classroomName: classroom.name,
    classroomCode: classroom.code,
    kind: Number(kind),
    kindName: kindInfo.name,
    homeworkId: row.homework_id,
    name: row.name.trim(),
    deadline: deadline ? deadline.iso : null,
    publishAt: publishAt ? publishAt.iso : null,
    archived: row.is_archive,
    completed,
    status: status.slice(),
    url: `${SITE_ORIGIN}/classrooms/${classroom.code}/${kindInfo.slug}`
  };
}

/** 作业的稳定身份键（唯一索引口径，与数据库主键一致）。 */
function homeworkKey(homework) {
  return [
    String(homework.accountId || ''),
    String(homework.classroomCode || ''),
    String(Number(homework.kind) || 0),
    String(homework.homeworkId)
  ].join('|');
}

/**
 * 提醒状态判定（`nowMs` 由调用方注入，便于离线测试）。
 *
 * 顺序即优先级，逐条对应一个「不提醒」的理由：
 * 归档 → 已完成 → 完成状态未知 → 未发布（文案）→ 未发布（发布时间在未来）
 * → 无截止时间（单独提醒）→ 已逾期 → 待处理。
 *
 * 注意：`pending` 只表示「尚未截止且未完成」，**不表示现在就该发提醒**；
 * 是否进入 24 小时/1 小时窗口由 reminder-plan.js 按当时时间重新算。
 */
function reminderState(homework, nowMs) {
  if (!Number.isFinite(nowMs)) throw new HomeworkError('nowMs 必须是有效时间戳。');
  if (homework.archived) return 'archived';
  if (homework.completed === true) return 'completed';
  if (homework.completed === null) return 'unknown_completion';
  if (homework.status.includes(UNPUBLISHED_MARK)) return 'unpublished';
  if (!homework.publishAt) return 'unknown_publication';
  if (fromBeijingIso(homework.publishAt) > nowMs) return 'unpublished';
  if (!homework.deadline) return 'no_deadline';
  if (fromBeijingIso(homework.deadline) <= nowMs) return 'overdue';
  return 'pending';
}

/** 人类可读的一行摘要（日志/预览用）。 */
function describeHomework(homework) {
  return `${homework.classroomName}（${homework.classroomCode}） / ${homework.kindName} / ${homework.name}`;
}

module.exports = {
  KINDS,
  KIND_ORDER,
  SITE_ORIGIN,
  BEIJING_OFFSET_MINUTES,
  UNPUBLISHED_MARK,
  HomeworkError,
  toBeijingIso,
  fromBeijingIso,
  parseBeijingTime,
  readDeadline,
  kindOf,
  classroomCodeFromPath,
  parseClassroom,
  parseHomework,
  homeworkKey,
  reminderState,
  describeHomework
};
