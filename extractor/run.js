const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');

const { ExtractEngine, DEFAULT_EXPORT_ROOT, DEFAULT_PROFILE_DIR } = require('./lib/extract-engine');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_NETWORK_LOG = path.join(ROOT, '.educoder-network.jsonl');

/** 控制台默认端口。改这里要同步改篡改猴里的 DEFAULT_LOCAL。 */
const DEFAULT_UI_PORT = 43127;

/**
 * 网络日志路径。
 *
 * **默认关闭**：它只用于排查接口问题，而每个响应都要 stringify 一次并追加一行，
 * 长期跑会把文件撑到几十 MB（实测 20MB / 2 万多行），是这套工具最大的 IO 来源。
 *
 * 需要时用 `EDUCODER_NETWORK_LOG=1` 打开（写默认路径），或直接给一个文件路径：
 *   $env:EDUCODER_NETWORK_LOG='1'        # 写到 .educoder-network.jsonl
 *   $env:EDUCODER_NETWORK_LOG='D:\tmp\x.jsonl'
 *   $env:EDUCODER_NETWORK_LOG='0'        # 显式关闭（等同不设置）
 */
function networkLogPath() {
  const fromEnv = process.env.EDUCODER_NETWORK_LOG;
  if (fromEnv === undefined) return null;
  const value = fromEnv.trim();
  if (!value || value === '0' || value.toLowerCase() === 'off' || value.toLowerCase() === 'false') return null;
  if (value === '1' || value.toLowerCase() === 'on' || value.toLowerCase() === 'true') return DEFAULT_NETWORK_LOG;
  return value;
}

function outputRoot() {
  return process.env.EDUCODER_EXPORT_ROOT || DEFAULT_EXPORT_ROOT;
}

/**
 * 控制台监听的端口。
 *
 * **固定下来**（默认 43127）而不是 `port: 0`。原来每次启动由系统随机分配，
 * 端口一变，篡改猴里配好的控制台地址就失效，用户被迫每次重配一遍
 * ——「为什么每次都要设置本地地址」就是这么来的。
 *
 * 端口是公开信息（不是凭据），固定它没有安全代价。被占用时回退到系统分配，
 * 并在终端说明「地址变了、篡改猴要重配」，不静默换端口让用户对着报错猜。
 */
function resolveUiPort() {
  const fromEnv = Number(process.env.EDUCODER_UI_PORT);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_UI_PORT;
}

const ENV_FILE = path.join(ROOT, '.env');

/**
 * 加载 `.env`（Node 内置，零依赖；不做 shell 插值，密钥里的 `$` 不会被吃掉）。
 *
 * 与 `reminder.js` 同一套做法：**本地配置统一放 `.env`**，不再一个用途一个文件。
 * 已存在的环境变量优先，`.env` 只补空缺——这样 `EDUCODER_UI_PORT=5000 npm run ui`
 * 这种临时覆盖仍然有效。
 */
function loadEnvFile() {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch (error) {
    /* 没有 .env 就只用真实环境变量 */
  }
}

/**
 * 控制台的访问 token。
 *
 * 取值顺序：环境变量 / `.env` → 生成一个并**写回 `.env`** → 实在写不了才用本次随机的。
 *
 * 为什么必须稳定：token 变了，篡改猴里存的带 token 的地址就作废，
 * 用户被迫反复重配（「为什么每次都要设置本地地址」的另一半原因）。
 *
 * 为什么不能写死成源码常量：篡改猴用的那几个端点（`/api/answers` 等）**只校验 token**
 * 且带 `Access-Control-Allow-Origin: *`——token 一旦公开，任何网站都能读你的答案库。
 * 所以它只能「随机生成 + 存在本地」，不进仓库、不进日志。
 */
function resolveUiToken() {
  const fromEnv = String(process.env.EDUCODER_UI_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  const token = crypto.randomBytes(24).toString('hex');
  try {
    const existing = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
    const banner = existing.includes('EDUCODER_UI_TOKEN')
      ? ''
      : '\n# ---- 本地控制台（npm run ui）----\n'
        + '# 访问 token：随机生成后写在这里，重启不变，篡改猴只需配一次地址。\n'
        + '# 不要提交（.env 已 gitignore）；也不要贴给别人——它能读写你的答案库。\n';
    fs.appendFileSync(ENV_FILE, `${banner}EDUCODER_UI_TOKEN=${token}\n`, { mode: 0o600 });
  } catch (error) {
    /* 写不了就退回本次随机：功能不受影响，只是下次启动地址会变 */
  }
  return token;
}

function describeTaskCount(value) {
  return Number.isFinite(value) && value > 0 ? `${value} 个关卡` : '关卡数未知';
}

async function ask(prompt) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

function printEvent(event) {
  const prefix = new Date().toISOString().slice(11, 19);
  if (event.type === 'status') {
    console.log(`\n[${prefix}] ${event.message}`);
    return;
  }
  if (event.type === 'log') {
    const tag = event.level === 'error' ? '错误' : event.level === 'warn' ? '提示' : '日志';
    console.log(`[${prefix}] ${tag}：${event.message}`);
    return;
  }
  if (event.type === 'progress') {
    const total = event.total ? `/${event.total}` : '';
    const dropped = event.dropped ? `｜抛弃 ${event.dropped}` : '';
    console.log(
      `[${prefix}] 进度 ${event.current}${total} 关｜已保存 ${event.saved}｜跳过 ${event.skipped}｜失败 ${event.failed}${dropped}`
    );
    return;
  }
  if (event.type === 'saved') {
    const levels = event.levelCount ? `（本实验共 ${event.levelCount} 关）` : '';
    console.log(`[${prefix}] 已写入：${event.path}${levels}`);
    return;
  }
  if (event.type === 'dropped') {
    console.log(`[${prefix}] 抛弃：${event.title || event.level}（${event.reason || '非编程题/选择题'}）`);
  }
}

async function runTerminal(options = {}) {
  loadEnvFile(); // 与 runUi 同口径：本地配置统一放 .env
  const courseFromEnv = process.env.EDUCODER_COURSE;
  const experimentsFromEnv = process.env.EDUCODER_EXPERIMENTS;

  const engine = new ExtractEngine({
    exportRoot: outputRoot(),
    profileDir: DEFAULT_PROFILE_DIR,
    headless: options.headless,
    networkLog: networkLogPath(),
    onEvent: printEvent,
    control: {
      async waitForCourse(courses) {
        if (courseFromEnv) {
          const index = Number(courseFromEnv) - 1;
          if (Number.isInteger(index) && courses[index]) {
            console.log(`\n已通过 EDUCODER_COURSE 选择课程：${courses[index].name}`);
            return courses[index];
          }
          console.log(`\nEDUCODER_COURSE=${courseFromEnv} 无效，改为手动选择。`);
        }
        console.log('\n可用教学课程：');
        courses.forEach((course, index) => {
          const extra = [course.school, course.membersCount ? `${course.membersCount} 人` : '']
            .filter(Boolean)
            .join('，');
          console.log(`${index + 1}. ${course.name}${extra ? `（${extra}）` : ''}`);
        });
        const answer = await ask('\n请输入课程编号：');
        const index = Number(answer) - 1;
        if (!Number.isInteger(index) || !courses[index]) throw new Error('课程编号无效。');
        return courses[index];
      },

      async waitForExperiments(experiments) {
        if (experimentsFromEnv) {
          if (experimentsFromEnv.toLowerCase() === 'all') {
            console.log('\n已通过 EDUCODER_EXPERIMENTS=all 选择全部实验。');
            return experiments;
          }
          const indexes = experimentsFromEnv.split(',').map((value) => Number(value.trim()) - 1);
          if (indexes.every((index) => Number.isInteger(index) && experiments[index])) {
            console.log('\n已通过 EDUCODER_EXPERIMENTS 选择实验。');
            return indexes.map((index) => experiments[index]);
          }
          console.log(`\nEDUCODER_EXPERIMENTS=${experimentsFromEnv} 无效，改为手动选择。`);
        }
        console.log('\n可用课程实验：');
        experiments.forEach((item, index) => {
          console.log(`${index + 1}. ${item.name}（${describeTaskCount(item.taskCount)}）`);
        });
        const answer = await ask('\n请输入实验编号（多个用逗号分隔，输入 all 抓取全部）：');
        if (answer.trim().toLowerCase() === 'all') return experiments;
        const indexes = answer.split(',').map((value) => Number(value.trim()) - 1);
        if (!indexes.length || indexes.some((index) => !Number.isInteger(index) || !experiments[index])) {
          throw new Error('实验编号无效。');
        }
        return indexes.map((index) => experiments[index]);
      },

      async waitForLevels(levels) {
        if (!levels.length) return null;
        console.log(`\n该实验共 ${levels.length} 个关卡：`);
        levels.forEach((level, index) => {
          const type = level.type !== 'unknown' ? `（${level.type}）` : '';
          console.log(`${index + 1}. 第${level.index}关 ${level.name}${type}`);
        });
        const answer = await ask('\n请输入关卡编号（多个用逗号分隔，直接回车抓取全部）：');
        if (!answer.trim()) {
          console.log('已选择全部关卡。');
          return levels;
        }
        const indexes = answer.split(',').map((value) => Number(value.trim()) - 1);
        if (indexes.some((index) => !Number.isInteger(index) || !levels[index])) {
          throw new Error('关卡编号无效。');
        }
        return indexes.map((index) => levels[index]);
      },

      async shouldStop() {
        return false;
      }
    }
  });

  await engine.run();
  return engine.stats;
}

async function runUi(options = {}) {
  // 本地配置统一放 .env（AK/SK、控制台端口与 token、导出目录…）。
  // 必须在使用这些值之前加载。
  loadEnvFile();
  const { startUiServer } = require('./ui/server');
  const pending = { course: null, experiments: null, levels: null, stop: null };
  let server = null;

  const engine = new ExtractEngine({
    exportRoot: outputRoot(),
    profileDir: DEFAULT_PROFILE_DIR,
    headless: options.headless,
    networkLog: networkLogPath(),
    onEvent: (event) => server?.emit(event),
    control: {
      waitForCourse(courses) {
        return new Promise((resolve) => {
          pending.course = { courses, resolve };
        });
      },
      waitForExperiments(experiments) {
        return new Promise((resolve) => {
          pending.experiments = { experiments, resolve };
        });
      },
      waitForLevels(levels) {
        return new Promise((resolve) => {
          pending.levels = { levels, resolve };
        });
      },
      waitForAllLevels(levels) {
        // 多实验统一选择：一次拿到所有选中实验的关卡（每条带 experimentName）
        return new Promise((resolve) => {
          pending.levels = { levels, resolve, all: true };
        });
      },
      shouldStop() {
        return Promise.resolve(Boolean(pending.stop));
      }
    }
  });

  async function onControl(action, payload = {}) {
    if (action === 'select-course') {
      if (!pending.course) throw new Error('当前不在课程选择阶段。');
      const course = pending.course.courses.find((item) => String(item.id) === String(payload.courseId));
      if (!course) throw new Error('课程编号无效。');
      const { resolve } = pending.course;
      pending.course = null;
      resolve(course);
      return { ok: true, course: course.name };
    }
    if (action === 'select-experiments') {
      if (!pending.experiments) throw new Error('当前不在实验选择阶段。');
      const indexes = Array.isArray(payload.indices) ? payload.indices : [];
      const selected = indexes.map((index) => pending.experiments.experiments[index]).filter(Boolean);
      if (!selected.length) throw new Error('请至少选择一个实验。');
      const { resolve } = pending.experiments;
      pending.experiments = null;
      resolve(selected);
      return { ok: true, count: selected.length };
    }
    if (action === 'select-levels') {
      if (!pending.levels) throw new Error('当前不在关卡选择阶段。');
      const all = pending.levels.levels;
      // 关卡列表常常只有名称（identifier 为空），因此选择项可能只带 position / challengeId。
      // 三种身份都接受；全部无法匹配时视为「全选」而不是「一个都不抓」。
      const wantedLevels = Array.isArray(payload.levels) ? payload.levels : null;
      const identifiers = Array.isArray(payload.identifiers) ? payload.identifiers : [];
      let selected = null;
      if (wantedLevels && wantedLevels.length) {
        selected = all.filter((level) =>
          wantedLevels.some((want) => {
            if (!want || typeof want !== 'object') return String(want) === String(level.identifier);
            if (want.identifier && String(want.identifier) === String(level.identifier)) return true;
            if (want.challengeId && String(want.challengeId) === String(level.challengeId)) return true;
            const position = Number(want.position);
            return Number.isFinite(position) && position > 0 && Number(level.position) === position;
          })
        );
      } else if (identifiers.length) {
        selected = all.filter((level) => identifiers.includes(level.identifier));
      } else {
        selected = all;
      }
      const { resolve } = pending.levels;
      pending.levels = null;
      resolve(selected.length ? selected : null);
      return { ok: true, count: selected.length };
    }
    if (action === 'stop') {
      // 停止当前任务但**不关闭浏览器**：用户可以接着换课程/实验继续抓。
      // 只有引擎空闲（没有任务在跑）时才真正关掉浏览器，便于彻底收工。
      pending.stop = true;
      if (pending.course) {
        pending.course.resolve(null);
        pending.course = null;
      }
      if (pending.experiments) {
        pending.experiments.resolve([]);
        pending.experiments = null;
      }
      if (pending.levels) {
        pending.levels.resolve([]);
        pending.levels = null;
      }
      if (!engine.running) {
        await engine.stop();
        return { ok: true, closed: true };
      }
      return { ok: true, stopping: true };
    }
    if (action === 'reset') {
      // 「开始提取」：清空上一轮的课程/实验/关卡列表与已提取内容，从零再来一遍。
      engine.resetRun();
      pending.course = null;
      pending.experiments = null;
      pending.levels = null;
      return { ok: true, reset: true };
    }
    if (action === 'diagnose') {
      if (!engine.context) throw new Error('请先点击「开始提取」启动浏览器，再进行诊断。');
      const result = await engine.diagnose();
      return { ok: true, lines: result.lines || [] };
    }
    if (action === 'start') {
      // 支持多次提取：一次任务结束后浏览器保持打开，可直接再选课程/实验继续抓。
      if (engine.running) throw new Error('已有提取任务正在运行，请先等待结束或点击「停止」。');
      // **必须清掉上一次的停止标记**。`shouldStop()` 读的就是它，而它此前一旦被
      // 「停止」置为 true 就再没人复位——于是下一次任务会在第一个停止检查点
      // （读关卡列表）静默中断，报出「所选实验都没有返回关卡列表」这种
      // 与事实相反的话，然后卡在那里。这就是「抓取实验时卡住」的真凶。
      pending.stop = false;
      // 默认跳过本地已存在的关卡；界面上勾选「重新下载」时改为覆盖。
      engine.skipExisting = payload.skipExisting !== false;
      engine.answersOnly = payload.answersOnly === true;
      engine.run().catch((error) => {
        server?.emit({ type: 'status', phase: 'error', message: `提取失败：${error.message}` });
        server?.emit({ type: 'error', message: error.message });
      });
      return { ok: true, skipExisting: engine.skipExisting, answersOnly: engine.answersOnly };
    }
    throw new Error(`未知操作：${action}`);
  }

  server = await startUiServer({
    // 允许调用方指定端口：离线测试要并行起多个控制台，固定端口会互相抢。
    // 生产入口（CLI）不传，走固定端口。
    port: options.port === undefined ? resolveUiPort() : options.port,
    token: options.token === undefined ? resolveUiToken() : options.token,
    onControl,
    // AI 作答：真正的模型调用放在外壳里，服务端只管进度与快照。
    // dispatch 参数（isStopped/report/log）都由服务端提供；缺省时退化成「不报进度」，不抛错。
    onAnswerRun: async ({ course, experiments, levels, apiKey, baseUrl, model, isStopped, report, log } = {}) => {
      const { answerExperiment } = require('./lib/answerer');
      const stopped = typeof isStopped === 'function' ? isStopped : () => false;
      const report2 = typeof report === 'function' ? report : () => {};
      const log2 = typeof log === 'function' ? log : (message) => console.log(message);
      report2({ course, total: experiments.length });
      log2(`开始 AI 作答：${course}（${experiments.length} 个实验）`);
      const results = [];
      let done = 0;
      for (const experiment of experiments) {
        if (stopped()) break;
        report2({ experiment });
        try {
          const result = await answerExperiment({
            exportRoot: outputRoot(),
            course,
            experiment,
            apiKey,
            baseUrl,
            model,
            onlyLevelIds: levels,
            log: log2
          });
          results.push({ experiment, ...result });
        } catch (error) {
          log2(`实验「${experiment}」作答失败：${error.message}`, 'error');
          results.push({ experiment, ok: false, error: error.message });
        }
        done += 1;
        report2({ done, results });
      }
      log2(
        stopped() ? `AI 作答已停止（完成 ${done}/${experiments.length}）` : `AI 作答完成（${done}/${experiments.length}）`,
        stopped() ? 'warn' : 'info'
      );
      return { results, total: experiments.length };
    },
    onAnswerStop: async () => {
      console.log('已收到停止 AI 作答的请求。');
    },
    open: options.open !== false
  });
  console.log(`\n本地控制台已启动：${server.url}`);
  console.log('请在浏览器中完成课程、实验、关卡选择；终端也会同步显示进度。');
  server.emit({
    type: 'status',
    phase: 'starting',
    message: '控制台已就绪，等待启动抓取任务。',
    loggedIn: false
  });
  return { server, engine };
}

async function main() {
  const args = process.argv.slice(2);
  const useUi = args.includes('--ui');
  const headless = args.includes('--headless');
  if (useUi) {
    await runUi({ headless });
    return;
  }
  const stats = await runTerminal({ headless });
  console.log(`\n完成。已保存 ${stats.saved} 关，跳过 ${stats.skipped}（其中抛弃 ${stats.dropped || 0} 关非编程题/选择题），失败 ${stats.failed}。`);
  console.log(`资料目录：${outputRoot()}（每门课一个文件夹，每个实验一个 md + 一个 metadata.json）`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`提取失败：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { runTerminal, runUi };
