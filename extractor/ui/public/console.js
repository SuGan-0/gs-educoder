(function () {
  'use strict';

  var TOKEN = new URLSearchParams(location.search).get('token') || '';
  var LOG_LIMIT = 500;
  var SAVED_LIMIT = 12;
  var selectionModel = window.TougeSelection;
  var filters = { courses: '', experiments: '', levels: '' };
  var stateRequest = null;
  var eventSource = null;

  var state = {
    phase: '',
    message: '',
    user: null,
    loggedIn: false,
    courses: [],
    experiments: [],
    levels: [],
    // 多实验统一选择时，关卡列表是「合并列表」：每条自带 experimentName。
    levelsMulti: false,
    levelsExperiments: [],
    selectedCourse: null,
    selectedExperiments: [],
    selectedLevels: [],
    progress: { saved: 0, skipped: 0, failed: 0, current: 0, total: 0 },
    logs: [],
    extracted: [],
    done: null,
    currentExperiment: null,
    currentLevel: null,
    currentType: null,
    error: null
  };

  // 本地待提交选择（用户点选后立即体现，提交成功后由后端阶段推进）
  var sel = { courseId: null, experiments: new Set(), levels: new Set() };
  var agentCourses = [];
  var agentLoading = null;
  var publishing = false;
  var recentSaved = [];
  var logsRendered = 0;
  var lastRendered = { courses: null, experiments: null, levels: null };
  var connection = 'connecting';
  var posting = false;
  // 已应用的实时事件序号：用于识别“比快照更新”的实时状态，避免陈旧 /api/state 覆盖新事件
  var eventSeq = 0;
  // 已成功提交、等待引擎推进的选择阶段，避免重复提交
  var submitted = { course: false, experiments: false, levels: false };
  // 引擎只在进程内启动一次：start 提交成功后即上锁，直到页面重新加载
  var started = false;

  var PHASES = {
    'starting': ['启动中', 'busy'],
    'browser': ['启动浏览器', 'busy'],
    'login': ['检查登录', 'busy'],
    'waiting-login': ['等待登录', 'warn'],
    'courses': ['读取课程列表', 'busy'],
    'waiting-course': ['等待选择课程', 'active'],
    'experiments': ['读取实验列表', 'busy'],
    'waiting-experiments': ['等待选择实验', 'active'],
    'levels': ['读取关卡列表', 'busy'],
    'waiting-levels': ['等待选择关卡', 'active'],
    'running': ['抓取中', 'run'],
    'stopping': ['正在停止', 'warn'],
    'done': ['已完成', 'ok'],
    'error': ['出错', 'err']
  };

  function $(id) { return document.getElementById(id); }
  function toArray(value) { return Array.isArray(value) ? value : []; }
  function num(value) { var n = Number(value); return Number.isFinite(n) ? n : 0; }

  // 注意：这里必须与后端实际会推送的事件类型保持一致，否则事件会在入口处被丢弃
  // （曾因缺少 reused/reset，导致「已提取内容」既统计不到复用、也无法被清空；
  //  前端仅订阅抓取和结果事件，Agent 作答由外部工具完成。
  var EVENT_TYPES = ['status', 'courses', 'experiments', 'levels', 'progress', 'saved', 'reused', 'dropped', 'reset', 'log', 'done', 'error'];
  var AFTER_LOGIN_PHASES = ['courses', 'waiting-course', 'experiments', 'waiting-experiments',
    'levels', 'waiting-levels', 'running', 'stopping', 'done'];

  // 事件信封的 type 与 saved 载荷里的题目 type(code/choice/text) 同名，因此判定顺序为：
  // SSE 的 event 名 > data.type（是已知事件名时）> 载荷结构 > 未知丢弃。
  function detectEventType(named, data) {
    if (EVENT_TYPES.indexOf(named) >= 0) return named;
    if (EVENT_TYPES.indexOf(data.type) >= 0) return data.type;
    if (data.path != null || (data.title != null && data.images !== undefined)) return 'saved';
    if (data.exportRoot != null || 'stopped' in data) return 'done';
    if (data.phase != null) return 'status';
    if (Array.isArray(data.courses)) return 'courses';
    if (Array.isArray(data.experiments)) return 'experiments';
    if (Array.isArray(data.levels)) return 'levels';
    if (data.message != null && data.level != null) return 'log';
    if (data.current != null || data.total != null || data.saved != null) return 'progress';
    return '';
  }

  function applyWireEvent(named, data) {
    if (!data || typeof data !== 'object') return;
    var type = detectEventType(named, data);
    if (EVENT_TYPES.indexOf(type) < 0) return;
    applyEvent(type, data);
  }

  function el(tag, opts, children) {    var node = document.createElement(tag);
    opts = opts || {};
    if (opts.class) node.className = opts.class;
    if (opts.text != null) node.textContent = String(opts.text);
    if (opts.attrs) {
      Object.keys(opts.attrs).forEach(function (key) {
        var value = opts.attrs[key];
        if (value === false || value == null) return;
        node.setAttribute(key, value === true ? '' : String(value));
      });
    }
    if (opts.props) Object.assign(node, opts.props);
    if (opts.on) {
      Object.keys(opts.on).forEach(function (key) { node.addEventListener(key, opts.on[key]); });
    }
    toArray(children).forEach(function (child) {
      if (child == null) return;
      node.append(child);
    });
    return node;
  }

  function formatTime(value) {
    var date = value ? new Date(value) : new Date();
    if (isNaN(date.getTime())) return String(value || '').slice(-8);
    function pad(n) { return String(n).padStart(2, '0'); }
    return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
  }

  function typeTag(type) {
    var value = String(type || 'unknown');
    var cls = value === 'code' ? 'tag-code' : value === 'choice' ? 'tag-choice' : 'tag-unknown';
    var label = value === 'code' ? '编程题' : value === 'choice' ? '选择题' : '其他';
    return el('span', { class: 'tag ' + cls, text: label });
  }

  /**
   * 跳过清单标签：引擎在关卡上带了 localDone（本地存档 / 答案文件里已有这一关）。
   * 只做展示——勾选权还在用户手里，「全选」时才会自动排除（见 applyBulk）。
   */
  function doneTag(level) {
    var done = level && level.localDone;
    if (!done || (!done.archived && !done.answered)) return null;
    var text = done.answered ? '已有答案' : '已存档';
    return el('span', {
      class: 'tag tag-done',
      text: text,
      attrs: { title: '本地已有' + (done.answered ? '答案' : '存档') + '，「全选」时自动不勾；要重抓可手动勾上' }
    });
  }

  /* ------------------------------ toast ------------------------------ */

  function toast(message, kind) {
    var wrap = $('toast-wrap');
    var box = el('div', { class: 'toast', attrs: { 'data-kind': kind || 'info', role: 'status' } }, [
      el('span', { class: 'toast-msg', text: message }),
      el('button', {
        class: 'toast-close',
        text: '×',
        attrs: { type: 'button', 'aria-label': '关闭提示' },
        on: { click: function () { box.remove(); } }
      })
    ]);
    wrap.append(box);
    setTimeout(function () { box.remove(); }, kind === 'error' ? 9000 : 5000);
  }

  /* ------------------------------ actions ------------------------------ */

  async function postAction(action, payload) {
    if (!TOKEN) throw new Error('URL 缺少 token，请使用终端输出的地址打开本页');
    if (posting) throw new Error('上一个操作仍在提交中，请稍候');
    posting = true;
    renderControls();
    try {
      var body = Object.assign({ action: action, token: TOKEN }, payload || {});
      if (['select-course', 'select-experiments', 'select-levels'].indexOf(action) >= 0) {
        body.answersOnly = Boolean($('opt-answers-only').checked);
        body.skipExisting = !$('opt-redownload').checked;
      }
      var response = await fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      var data = null;
      try { data = await response.json(); } catch (error) { data = null; }
      if (!response.ok || (data && data.ok === false)) {
        throw new Error((data && (data.error || data.message)) || ('操作失败：HTTP ' + response.status));
      }
      return data || { ok: true };
    } finally {
      posting = false;
      renderControls();
    }
  }

  function runAction(action, payload, label) {
    setBusy(true);
    return postAction(action, payload)
      .then(function () {
        if (action === 'select-course') submitted.course = true;
        if (action === 'select-experiments') submitted.experiments = true;
        if (action === 'select-levels') submitted.levels = true;
        if (action === 'start') started = true;
        toast(label + '：已提交，等待引擎响应', 'ok');
        // 服务端动作会直接改写快照（含动作失败日志），静默重新同步一次
        return fetchState(true);
      })
      .catch(function (error) { toast(label + '失败：' + error.message, 'error'); })
      .finally(function () { setBusy(false); });
  }

  function setBusy(busy) {
    document.body.toggleAttribute('data-busy', busy);
    renderControls();
  }

  /* ------------------------------ snapshot / event merge ------------------------------ */

  function normalizeId(value) {
    if (value == null) return null;
    if (typeof value === 'object') return value.id != null ? value.id : null;
    return value;
  }

  function syncSelectionFromServer() {
    var courseId = normalizeId(state.selectedCourse);
    if (courseId != null) sel.courseId = courseId;

    var experiments = toArray(state.selectedExperiments);
    if (experiments.length) {
      var indices = experiments
        .map(function (item) {
          if (typeof item === 'number') return item;
          if (item && typeof item === 'object') {
            var found = lookupExperiment(item);
            return found >= 0 ? found : null;
          }
          return null;
        })
        .filter(function (value) { return value != null && Number.isInteger(value); });
      if (indices.length) sel.experiments = new Set(indices);
    }

    var levels = toArray(state.selectedLevels);
    if (levels.length) {
      // 服务端回传的是引擎眼中的选中关卡，按 levelKey 的优先级反查勾选状态。
      var keys = levels
        .map(function (item) { return item && typeof item === 'object' ? levelKey(item, 0) : 'id:' + item; })
        .filter(Boolean);
      if (keys.length) sel.levels = new Set(keys);
    }
  }

  function lookupExperiment(candidate) {
    return state.experiments.findIndex(function (item) {
      if (candidate.homeworkId != null) return String(item.homeworkId) === String(candidate.homeworkId);
      if (candidate.myshixunIdentifier) return item.myshixunIdentifier === candidate.myshixunIdentifier;
      return Boolean(candidate.name) && item.name === candidate.name;
    });
  }

  /**
   * 一轮提取结束后，引擎会把阶段推回 starting（浏览器保持打开，可直接再抓）。
   * 这时必须清掉上一轮的「已提交/已启动」闸门，否则「开始提取」会一直是灰的
   * ——用户会以为只能点一次。数据数组由各自的快照/事件分支负责，这里只管闸门。
   */
  var TERMINAL_PHASES = ['done', 'error', 'stopping'];
  function resetRunGates(nextPhase, previousPhase) {
    if (nextPhase !== 'starting') return false;
    if (TERMINAL_PHASES.indexOf(previousPhase) === -1) return false;
    started = false;
    submitted.course = false;
    submitted.experiments = false;
    submitted.levels = false;
    sel.courseId = null;
    sel.experiments = new Set();
    sel.levels = new Set();
    state.currentLevel = '';
    state.currentType = '';
    doneDismissed = false; // 新一轮开始，结果面板恢复可显示
    return true;
  }

  function applySnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    var previousPhase = state.phase;
    if (snapshot.phase != null) {
      if (resetRunGates(String(snapshot.phase), previousPhase)) state.done = null;
      state.phase = String(snapshot.phase);
    }
    if (snapshot.message != null) state.message = String(snapshot.message);
    if ('user' in snapshot) state.user = snapshot.user == null ? null : String(snapshot.user);
    if ('loggedIn' in snapshot) state.loggedIn = Boolean(snapshot.loggedIn);
    if ('courses' in snapshot) state.courses = toArray(snapshot.courses);
    if ('experiments' in snapshot) state.experiments = toArray(snapshot.experiments);
    if ('levels' in snapshot) state.levels = toArray(snapshot.levels);
    if ('levelsMulti' in snapshot) state.levelsMulti = Boolean(snapshot.levelsMulti);
    if ('levelsExperiments' in snapshot) state.levelsExperiments = toArray(snapshot.levelsExperiments);
    if ('selectedCourse' in snapshot) state.selectedCourse = snapshot.selectedCourse;
    if ('selectedExperiments' in snapshot) state.selectedExperiments = toArray(snapshot.selectedExperiments);
    if ('selectedLevels' in snapshot) state.selectedLevels = toArray(snapshot.selectedLevels);
    if (snapshot.progress && typeof snapshot.progress === 'object') mergeProgress(snapshot.progress, true);
    if ('done' in snapshot) state.done = snapshot.done || null;
    if (Array.isArray(snapshot.logs)) {
      state.logs = snapshot.logs.slice(-LOG_LIMIT);
      logsRendered = 0;
      $('log-box').replaceChildren();
    }
    if (Array.isArray(snapshot.extracted)) {
      state.extracted = snapshot.extracted.slice();
      renderExtracted();
    }
    syncSelectionFromServer();
    renderAll({ forceLists: true });
    syncLogs();
    if (state.done) renderDone();
  }

  function mergeProgress(progress, quiet) {
    ['saved', 'skipped', 'failed', 'current', 'total'].forEach(function (key) {
      if (progress[key] != null) state.progress[key] = num(progress[key]);
    });
    if (progress.experimentName != null) state.currentExperiment = progress.experimentName;
    if (progress.levelName != null) state.currentLevel = progress.levelName;
    if (progress.levelType != null) state.currentType = progress.levelType;
    if (!quiet) renderProgress();
  }

  function applyEvent(type, data) {
    if (!data || typeof data !== 'object') return;
    eventSeq += 1;
    var previousPhase = state.phase;

    switch (type) {
      case 'status':
        if (data.phase != null) {
          if (resetRunGates(String(data.phase), previousPhase)) state.done = null;
          state.phase = String(data.phase);
        }
        state.message = data.message != null ? String(data.message) : '';
        if ('user' in data) state.user = data.user == null ? null : String(data.user);
        if ('loggedIn' in data) state.loggedIn = Boolean(data.loggedIn);
        if (data.user || AFTER_LOGIN_PHASES.indexOf(state.phase) >= 0) state.loggedIn = true;
        if (state.phase === 'waiting-login' || state.phase === 'login' || state.phase === 'starting') state.loggedIn = Boolean(data.loggedIn);
        if (data.phase && data.phase !== 'error') state.error = null;
        break;
      case 'courses':
        state.courses = toArray(data.courses);
        break;
      case 'experiments':
        state.experiments = toArray(data.experiments);
        if (data.course) state.selectedCourse = data.course;
        sel.experiments = new Set();
        break;
      case 'levels':
        state.levels = toArray(data.levels);
        // 多实验统一选择时，引擎会一次性推来合并列表（每条带 experimentName）。
        state.levelsMulti = Boolean(data.multi);
        state.levelsExperiments = toArray(data.experimentNames);
        sel.levels = new Set();
        break;
      case 'progress':
        mergeProgress(data);
        break;
      case 'saved':
        pushSaved(data);
        // 与服务端快照保持一致：每条 saved 事件计入已保存（后续 progress 事件会覆盖为权威值）
        state.progress.saved = num(state.progress.saved) + 1;
        appendExtractedLocal(data, data.status === 'reused' ? 'reused' : 'saved');
        renderProgress();
        renderExtracted();
        break;
      case 'reused':
        appendExtractedLocal(data, 'reused');
        renderExtracted();
        break;
      case 'dropped':
        // 题型白名单：非编程题/选择题（虚拟机、图形化、纯问答）一律抛弃，界面要说清原因。
        pushLog({
          time: new Date().toISOString(),
          level: 'warn',
          message: '抛弃非编程题/选择题的关卡：' + (data.title || data.level || '未命名') +
            (data.reason ? '（' + data.reason + '）' : '')
        });
        state.progress.dropped = num(state.progress.dropped) + 1;
        renderProgress();
        break;
      case 'reset':
        // 「开始提取」：服务端已清空，本地同步清掉上一轮的列表与已提取内容
        state.courses = [];
        state.experiments = [];
        state.levels = [];
        state.levelsMulti = false;
        state.levelsExperiments = [];
        state.selectedCourse = null;
        state.selectedExperiments = [];
        state.selectedLevels = [];
        state.extracted = [];
        state.done = null;
        state.progress = { saved: 0, skipped: 0, failed: 0, current: 0, total: 0, dropped: 0 };
        sel.courseId = null;
        sel.experiments = new Set();
        sel.levels = new Set();
        doneDismissed = false;
        started = false;
        renderDone();
        renderExtracted();
        break;
      case 'log':
        pushLog({ time: new Date().toISOString(), level: data.level || 'info', message: data.message || '' });
        break;
      case 'done':
        state.done = data;
        // done 事件自带完整「已提取内容」：SSE 是短命的，以它为准可避免丢条目。
        if (Array.isArray(data.extracted) && data.extracted.length) {
          state.extracted = data.extracted.slice();
          renderExtracted();
        }
        if (!state.phase || state.phase !== 'done') state.phase = 'done';
        renderDone();
        break;
      case 'error':
        state.error = data.message || '未知错误';
        pushLog({ time: new Date().toISOString(), level: 'error', message: state.error });
        break;
      default:
        break;
    }

    renderAll();
    syncLogs();
    if (type === 'done') { renderDone(); loadAgentTargets(); }
    if (previousPhase !== state.phase) onPhaseChanged(previousPhase);
  }

  function onPhaseChanged(previousPhase) {
    renderDone();
    // 阶段推进说明后端已消费上一轮选择：清掉已提交标记与过期的本地勾选
    submitted = { course: false, experiments: false, levels: false };
    if (state.phase === 'waiting-experiments' && previousPhase !== 'waiting-experiments') sel.experiments = new Set();
    if (state.phase === 'waiting-levels' && previousPhase !== 'waiting-levels') sel.levels = new Set();
    renderAll();
  }

  /* ------------------------------ rendering ------------------------------ */

  function phaseInfo(phase) {
    if (PHASES[phase]) return { label: PHASES[phase][0], tone: PHASES[phase][1] };
    return { label: phase ? '阶段：' + phase : '未知阶段', tone: 'busy' };
  }

  function can(what) {
    var phase = state.phase;
    switch (what) {
      case 'course': return phase === 'waiting-course';
      case 'experiments': return phase === 'waiting-experiments';
      case 'levels': return phase === 'waiting-levels';
      // 引擎启动前快照阶段为 starting；启动后由引擎推送后续阶段
      // 引擎启动前快照阶段为 starting；启动后由引擎推送后续阶段。
      // 终态（done/error/stopping）也要允许再次启动——一轮结束后浏览器仍开着，
      // 可以直接换课程/实验继续抓（曾经这里只允许 starting，导致「只能提取一次」）。
      case 'start': return !started && TERMINAL_PHASES.concat('starting', 'stopping').indexOf(phase) >= 0;
      // 只要引擎还活着（不是启动前、也没结束/出错）就允许请求停止。
      // 这里用「排除」而不是枚举：枚举曾漏掉 courses / levels 等阶段，
      // 导致读课程或读实验时「停止」按钮是灰的、用户无法中止。
      case 'stop': return phase !== 'starting' && phase !== 'done' && phase !== 'error';
      default: return false;
    }
  }

  function renderAll(options) {
    options = options || {};
    renderChrome();
    renderCourses(options.forceLists);
    renderExperiments(options.forceLists);
    renderLevels(options.forceLists);
    renderProgress();
    renderControls();
    renderSelectionBadges();
    renderRecentlySaved();
    renderExtracted();
  }

  function renderChrome() {
    var info = phaseInfo(state.phase);
    var chip = $('chip-phase');
    chip.dataset.tone = info.tone;
    $('chip-phase-text').textContent = info.label;

    $('st-phase-text').textContent = info.label;
    $('st-phase-raw').textContent = state.phase || '—';
    $('st-phase-raw').title = state.phase || '';

    var login = $('st-login');
    if (state.loggedIn) {
      login.dataset.state = 'ok';
      $('st-login-text').textContent = '已登录';
    } else if (state.phase === 'waiting-login' || state.phase === 'login' || state.phase === 'starting' || state.phase === 'browser') {
      login.dataset.state = 'warn';
      $('st-login-text').textContent = '未登录';
    } else {
      login.dataset.state = 'err';
      $('st-login-text').textContent = '未登录';
    }
    $('st-user').textContent = state.user ? '账号 ' + state.user : '未识别账号';

    $('st-message').textContent = state.message || (state.phase ? info.label : '正在读取后端状态…');
    $('st-logs-count').textContent = '日志 ' + state.logs.length + ' 条';

    var conn = $('chip-conn');
    if (connection === 'open') {
      conn.dataset.tone = 'ok';
      $('chip-conn-text').textContent = '已连接';
    } else if (connection === 'connecting') {
      conn.dataset.tone = 'busy';
      $('chip-conn-text').textContent = '连接中';
    } else {
      conn.dataset.tone = 'err';
      $('chip-conn-text').textContent = '正在重连';
    }

    $('banner-login').hidden = state.phase !== 'waiting-login';

    var banner = $('banner-error');
    if (!TOKEN) {
      banner.hidden = false;
      $('banner-error-title').textContent = '缺少访问 token';
      $('banner-error-text').textContent = '请使用终端输出的完整地址（含 ?token=… ）打开本页面。';
    } else if (state.error) {
      banner.hidden = false;
      $('banner-error-title').textContent = state.phase === 'error' ? '运行出错' : '操作提示';
      $('banner-error-text').textContent = state.error;
    } else {
      banner.hidden = true;
    }

  }

  function listEl(kind) { return $('list-' + kind); }

  function visibleEntries(kind) {
    var rows = selectionModel.entries(state[kind], filters[kind]);
    $('results-' + kind).textContent = rows.length + ' / ' + state[kind].length;
    return rows;
  }

  function renderCourses(force) {
    var data = state.courses;
    if (!force && lastRendered.courses === data) return;
    lastRendered.courses = data;
    var rows = visibleEntries('courses');
    var box = listEl('courses');
    if (!rows.length) {
      box.replaceChildren();
      box.dataset.empty = 'true';
      box.dataset.emptyText = state.phase === 'waiting-course'
        ? '没有读取到课程。请确认账号已登录且课程接口可用。'
        : '等待读取课程列表…';
      if (data.length) box.dataset.emptyText = '没有匹配的课程，试试其他关键词。';
      return;
    }
    box.dataset.empty = 'false';
    box.replaceChildren.apply(box, rows.map(function (entry) {
      var course = entry.item, index = entry.index;
      var id = course && course.id != null ? course.id : index;
      var meta = [];
      if (course && course.school) meta.push(String(course.school));
      if (course && course.membersCount != null) meta.push(num(course.membersCount) + ' 名成员');
      if (course && course.visits != null) meta.push(num(course.visits) + ' 次访问');
      // homeworkCommonsCount 是「作业总数」而非可抓取的实训数，且 courses.json 里该字段
      // 常为 0/缺失，直接显示会误导（实际实训数要选中课程后才取得到）。
      if (course && course.homeworkCommonsCount) meta.push(num(course.homeworkCommonsCount) + ' 个作业');
      var side = [];
      if (course && course.classroomCode) side.push(String(course.classroomCode));
      else if (course && course.id != null) side.push('id ' + course.id);

      var input = el('input', {
        attrs: { type: 'radio', name: 'course', 'data-index': String(index) },
        props: { checked: String(sel.courseId) === String(id), value: String(id) }
      });
      input.addEventListener('change', function () {
        if (!can('course')) { input.checked = false; return; }
        sel.courseId = id;
        submitted.course = false;
        renderControls();
        renderSelectionBadges();
      });

      return el('label', { class: 'row', attrs: { title: (course && course.name) || '' } }, [
        input,
        el('span', { class: 'row-main' }, [
          el('span', { class: 'row-title', text: (course && course.name) || '未命名课程' }),
          el('span', { class: 'row-meta' }, meta.map(function (text) { return el('span', { text: text }); }))
        ]),
        course && course.isEnd ? el('span', { class: 'tag tag-end', text: '已结课' }) : null,
        el('span', { class: 'row-side mono', text: side.join(' · '), attrs: { title: side.join(' · ') } })
      ]);
    }));
  }

  function renderExperiments(force) {
    var data = state.experiments;
    if (!force && lastRendered.experiments === data) return;
    lastRendered.experiments = data;
    var rows = visibleEntries('experiments');
    var box = listEl('experiments');
    if (!rows.length) {
      box.replaceChildren();
      box.dataset.empty = 'true';
      box.dataset.emptyText = state.phase === 'waiting-experiments'
        ? '该课程下没有可提取的实训实验。'
        : '等待读取实验列表…';
      if (data.length) box.dataset.emptyText = '没有匹配的实验，试试其他关键词。';
      return;
    }
    box.dataset.empty = 'false';
    box.replaceChildren.apply(box, rows.map(function (entry) {
      var item = entry.item, index = entry.index;
      var input = el('input', {
        attrs: { type: 'checkbox', 'data-index': String(index) },
        props: { checked: sel.experiments.has(index) }
      });
      input.addEventListener('change', function () {
        if (!can('experiments')) { input.checked = sel.experiments.has(index); return; }
        if (input.checked) sel.experiments.add(index); else sel.experiments.delete(index);
        submitted.experiments = false;
        renderControls();
        renderSelectionBadges();
      });
      var meta = [];
      if (item && item.taskCount != null) meta.push(num(item.taskCount) + ' 个关卡');
      else meta.push('关卡数未知');
      return el('label', { class: 'row', attrs: { title: (item && item.name) || '' } }, [
        input,
        el('span', { class: 'row-main' }, [
          el('span', { class: 'row-title', text: (item && item.name) || '未命名实验' }),
          el('span', { class: 'row-meta' }, meta.map(function (text) { return el('span', { text: text }); }))
        ]),
        el('span', {
          class: 'row-side mono',
          text: item && item.myshixunIdentifier ? String(item.myshixunIdentifier) : '',
          attrs: { title: item && item.myshixunIdentifier ? String(item.myshixunIdentifier) : '' }
        })
      ]);
    }));
  }

  function renderLevels(force) {
    var data = state.levels;
    if (!force && lastRendered.levels === data) return;
    lastRendered.levels = data;
    var rows = visibleEntries('levels');
    var groupHint = $('hint-level-groups');
    if (groupHint) {
      var text = levelGroupHintText();
      groupHint.textContent = text;
      groupHint.hidden = !text;
    }
    var box = listEl('levels');
    if (!rows.length) {
      box.replaceChildren();
      box.dataset.empty = 'true';
      box.dataset.emptyText = state.phase === 'waiting-levels'
        ? '关卡接口未返回列表，可直接开始，引擎会按关卡链自动遍历。'
        : '等待读取关卡列表…';
      if (data.length) box.dataset.emptyText = '没有匹配的关卡，试试实验名或关卡名。';
      return;
    }
    box.dataset.empty = 'false';
    box.replaceChildren.apply(box, rows.map(function (entry) {
      var level = entry.item, index = entry.index;
      var key = levelKey(level, index);
      // 右侧展示的短标识：优先真实 identifier，无标识时退回序号（不能引用未定义变量，
      // 否则整个关卡列表渲染会抛错、一个条目都出不来）。
      var identifier = level && level.identifier
        ? String(level.identifier)
        : level && level.position != null
          ? '第 ' + num(level.position) + ' 关'
          : '#' + (index + 1);
      var input = el('input', {
        attrs: { type: 'checkbox', 'data-index': String(index) },
        props: { checked: sel.levels.has(key) }
      });
      input.addEventListener('change', function () {
        if (!can('levels')) { input.checked = sel.levels.has(key); return; }
        if (input.checked) sel.levels.add(key); else sel.levels.delete(key);
        submitted.levels = false;
        renderControls();
        renderSelectionBadges();
      });
      var meta = [];
      // 多实验会合并成一份关卡列表：必须标出每条属于哪个实验，
      // 否则用户会以为「只列出了第一个实验的关卡」。
      if (level && level.index != null) meta.push('第 ' + num(level.index) + ' 关');
      var row = [
        input,
        el('span', { class: 'row-main' }, [
          el('span', { class: 'row-exp', text: (level && level.experimentName) || '' }),
          el('span', { class: 'row-title', text: (level && level.name) || '未命名关卡' }),
          el('span', { class: 'row-meta' }, meta.map(function (text) { return el('span', { text: text }); }))
        ]),
        typeTag(level && level.type)
      ];
      var done = doneTag(level);
      if (done) row.push(done);
      row.push(el('span', { class: 'row-side mono', text: identifier, attrs: { title: identifier } }));
      return el('label', {
        class: 'row' + (level && level.experimentName ? ' has-exp' : ''),
        attrs: { title: (level && level.name) || '' }
      }, row);
    }));
  }

  function renderSelectionBadges() {
    $('badge-courses').textContent = '已选 ' + (sel.courseId != null ? 1 : 0) + ' / ' + state.courses.length;
    $('badge-courses').dataset.state = sel.courseId != null ? 'active' : '';
    $('badge-experiments').textContent = '已选 ' + sel.experiments.size + ' / ' + state.experiments.length;
    $('badge-experiments').dataset.state = sel.experiments.size ? 'active' : '';
    $('badge-levels').textContent = '已选 ' + sel.levels.size + ' / ' + state.levels.length;
    $('badge-levels').dataset.state = sel.levels.size ? 'active' : '';
  }

  function renderProgress() {
    var progress = state.progress;
    var total = num(progress.total);
    var current = num(progress.current);
    var percent = total > 0 ? Math.max(0, Math.min(100, Math.round((current / total) * 100))) : 0;
    $('prog-fill').style.width = percent + '%';
    $('prog-bar').setAttribute('aria-valuenow', String(percent));
    $('badge-progress').textContent = current + ' / ' + total;
    $('count-saved').textContent = num(progress.saved);
    $('count-skipped').textContent = num(progress.skipped);
    $('count-failed').textContent = num(progress.failed);
    // 本地已存在、未重复抓取的关卡数（第二次提取时最有用）
    var reusedHint = $('hint-reused');
    if (reusedHint) {
      var hints = [];
      var reused = num(progress.existing);
      if (reused > 0) hints.push('已存在 ' + reused + ' 关，未重复抓取');
      var dropped = num(progress.dropped);
      if (dropped > 0) hints.push('抛弃非编程题/选择题 ' + dropped + ' 关');
      reusedHint.textContent = hints.join('；');
      reusedHint.hidden = hints.length === 0;
    }

    var parts = [];
    if (state.currentExperiment) parts.push('实验：' + state.currentExperiment);
    if (state.currentLevel) parts.push('关卡：' + state.currentLevel);
    if (state.currentType) parts.push('类型：' + state.currentType);
    if (!parts.length) {
      if (can('start')) parts.push('等待启动：点击「开始提取」启动引擎');
      else parts.push(total > 0 ? '准备中…' : '尚未开始');
    }
    $('prog-current').textContent = parts.join(' · ');
  }

  function renderControls() {
    var modeLocked = posting || state.phase === 'running' || state.phase === 'stopping';
    $('opt-answers-only').disabled = modeLocked;
    $('opt-redownload').disabled = modeLocked;
    var courseOn = can('course') && !posting;
    var experimentsOn = can('experiments') && !posting;
    var levelsOn = can('levels') && !posting;
    var startOn = can('start') && !posting;
    var stopOn = can('stop') && !posting;

    listEl('courses').classList.toggle('locked', !courseOn);
    listEl('experiments').classList.toggle('locked', !experimentsOn);
    listEl('levels').classList.toggle('locked', !levelsOn);
    listEl('courses').querySelectorAll('input').forEach(function (input) { input.disabled = !courseOn; });
    listEl('experiments').querySelectorAll('input').forEach(function (input) { input.disabled = !experimentsOn; });
    listEl('levels').querySelectorAll('input').forEach(function (input) { input.disabled = !levelsOn; });

    document.querySelectorAll('[data-bulk]').forEach(function (button) {
      var target = button.dataset.target;
      var enabled = target === 'experiments' ? experimentsOn : levelsOn;
      var filtered = Boolean(filters[target].trim());
      var hasItems = filtered ? selectionModel.entries(state[target], filters[target]).length > 0 : state[target].length > 0;
      button.disabled = !(enabled && hasItems);
      button.textContent = ({ all: '全选', invert: '反选', none: '清空' })[button.dataset.bulk] + (filtered ? '结果' : '');
    });

    var courseButton = $('btn-course');
    courseButton.disabled = !(courseOn && sel.courseId != null && !submitted.course);
    $('hint-courses').textContent = hintFor('course', courseOn);
    $('hint-courses').dataset.state = courseOn && sel.courseId == null ? 'warn' : '';

    var experimentsButton = $('btn-experiments');
    experimentsButton.disabled = !(experimentsOn && sel.experiments.size > 0 && !submitted.experiments);
    experimentsButton.textContent = sel.experiments.size
      ? '提取选中的 ' + sel.experiments.size + ' 个实验'
      : '提取选中的实验';
    $('hint-experiments').textContent = hintFor('experiments', experimentsOn);
    $('hint-experiments').dataset.state = experimentsOn && sel.experiments.size === 0 ? 'warn' : '';

    var levelsButton = $('btn-levels');
    var noLevelData = levelsOn && state.levels.length === 0;
    levelsButton.disabled = !(levelsOn && (sel.levels.size > 0 || noLevelData) && !submitted.levels);
    levelsButton.textContent = state.levels.length === 0 && levelsOn
      ? '开始抓取（自动遍历全部关卡）'
      : sel.levels.size ? '开始抓取选中的 ' + sel.levels.size + ' 个关卡' : '开始抓取选中的关卡';
    $('hint-levels').textContent = hintFor('levels', levelsOn);
    $('hint-levels').dataset.state = levelsOn && sel.levels.size === 0 && state.levels.length > 0 ? 'warn' : '';

    var startButton = $('btn-start');
    startButton.disabled = !startOn;
    startButton.textContent = '开始提取';
    startButton.classList.toggle('btn-primary', startOn && state.phase === 'starting');
    startButton.title = startOn
      ? '启动引擎并打开抓取用的浏览器窗口'
      : (started ? '引擎已启动' : '当前阶段不可启动：' + (state.phase || '未知'));
    $('btn-stop').disabled = !stopOn;
    $('btn-stop').title = stopOn ? '请求停止当前任务' : '当前阶段不可停止';

    renderSteps();
  }

  /**
   * 步骤指示：决定哪一步是活的，并只显示那一步的内容。
   *
   * 为什么值得这么改：提取是**顺序流程**（课程 → 实验 → 关卡），同一时刻只有一步能用。
   * 原来拆成三个等高面板，两个永远是锁着的、白占半屏，而「抓取进度」被挤到折叠线以下。
   *
   * 「活的那一步」直接取 `can()` 的第一个为真的项——和按钮的可用性同源，
   * 不会出现「步骤条说能选、按钮却是灰的」这种自相矛盾。
   */
  function renderSteps() {
    var active = can('course') ? 0 : can('experiments') ? 1 : can('levels') ? 2
      // 都不在可选阶段（启动中/抓取中/已结束）：停在做完的那一步，
      // 用已有的数据判断走到哪了，而不是硬跳到第一步。
      : state.levels.length ? 2 : state.experiments.length ? 1 : 0;

    var bar = $('step-bar');
    if (bar) {
      var items = bar.querySelectorAll('li');
      for (var i = 0; i < items.length; i += 1) {
        items[i].dataset.state = i < active ? 'done' : i === active ? 'active' : 'locked';
      }
    }
    var panes = ['pane-course', 'pane-experiments', 'pane-levels'];
    for (var j = 0; j < panes.length; j += 1) {
      var pane = $(panes[j]);
      if (pane) pane.hidden = j !== active;
    }
    var badge = $('badge-step');
    if (badge) badge.textContent = '第 ' + (active + 1) + ' 步 / 3';

    // 步骤条上带一句摘要：不必点回去也知道前面选了什么
    var notes = [$('step-note-course'), $('step-note-experiments'), $('step-note-levels')];
    if (notes[0]) notes[0].textContent = sel.courseId != null ? '已选' : '';
    if (notes[1]) notes[1].textContent = sel.experiments.size ? sel.experiments.size + ' 个' : '';
    if (notes[2]) notes[2].textContent = sel.levels.size ? sel.levels.size + ' 关' : '';
  }

  /**
   * 关卡列表说明：多实验合并时明确写出涉及几个实验，
   * 避免用户误以为「只列出了第一个实验的关卡」。
   */
  function levelScopeHint() {
    var names = [];
    state.levels.forEach(function (level) {
      var name = level && level.experimentName;
      if (name && names.indexOf(name) < 0) names.push(name);
    });
    if (names.length <= 1) return '';
    return '（来自 ' + names.length + ' 个实验：' + names.join('、') + '）';
  }

  /** 关卡区的分组说明：多实验合并列表时逐行标出所属实验，并给出统计。 */
  function levelGroupHintText() {
    var parts = [];
    var counts = [];
    state.levels.forEach(function (level) {
      var name = level && level.experimentName;
      if (!name) return;
      var hit = counts.filter(function (item) { return item.name === name; })[0];
      if (hit) hit.count += 1;
      else counts.push({ name: name, count: 1 });
    });
    if (counts.length > 1) {
      parts.push('共 ' + state.levels.length + ' 关，来自 ' + counts.length + ' 个实验：' +
        counts.map(function (item) { return item.name + ' ' + item.count + ' 关'; }).join('、'));
    }
    // 跳过清单：不解释的话，「全选完怎么少了一截」会像 bug。
    var doneCount = state.levels.filter(function (level) {
      var done = level && level.localDone;
      return done && (done.archived || done.answered);
    }).length;
    if (doneCount) parts.push('跳过清单 ' + doneCount + ' 关本地已有，「全选」自动不勾');
    return parts.join('；');
  }

  function hintFor(kind, enabled) {
    if (posting) return '正在提交操作…';
    if (enabled) {
      if (submitted[kind]) return '已提交选择，等待引擎推进到下一阶段…';
      if (kind === 'course') return sel.courseId != null ? '已选中课程，点击右侧按钮提交。' : '请选择一个课程（单选）。';
      if (kind === 'experiments') {
        return state.experiments.length
          ? (sel.experiments.size ? '已选 ' + sel.experiments.size + ' 个实验，点击右侧按钮开始。' : '请勾选实验，可多选或使用「全选 / 反选」。')
          : '当前课程没有可选的实训实验。';
      }
      return state.levels.length
        ? (sel.levels.size
            ? '已选 ' + sel.levels.size + ' 个关卡' + levelScopeHint() + '，点击右侧按钮开始。'
            : '请勾选关卡' + levelScopeHint() + '，可多选或使用「全选 / 反选」。')
        : '无关卡列表，开始后由引擎按关卡链自动遍历。';
    }
    // 还不能选的时候，说人话 + 告诉用户「现在正在干什么」。
    // 原来直接拼内部状态名（"当前阶段不可选择课程：starting"），用户既看不懂
    // 也不知道该等还是该操作。
    var note = '（当前正在：' + phaseInfo(state.phase).label + '）';
    if (kind === 'course') return '现在还不能选课程' + note;
    if (kind === 'experiments') return '现在还不能选实验' + note;
    return '现在还不能选关卡' + note;
  }

  function pushSaved(data) {
    // 兼容 { type:'saved', payload:{…} } 这类嵌套写法
    var body = data.payload && typeof data.payload === 'object' && !Array.isArray(data.payload)
      ? Object.assign({}, data, data.payload)
      : data;
    // 事件信封的 type 与题目类型同名：优先 taskType，其次取非事件名的 type（code/choice/text）
    var taskType = body.taskType
      || (body.type && EVENT_TYPES.indexOf(body.type) < 0 ? body.type : '');
    recentSaved.unshift({
      title: body.title || '未命名关卡',
      type: taskType || 'unknown',
      level: body.level || '',
      path: body.path || '',
      images: body.images
    });
    if (recentSaved.length > SAVED_LIMIT) recentSaved.length = SAVED_LIMIT;
    renderRecentlySaved();
  }

  function renderRecentlySaved() {
    var box = $('saved-list');
    $('badge-recent').textContent = String(recentSaved.length);
    if (!recentSaved.length) {
      box.replaceChildren(el('div', { class: 'saved-empty', text: '暂无保存记录。' }));
      return;
    }
    box.replaceChildren.apply(box, recentSaved.map(function (item) {
      return el('div', { class: 'saved-line' }, [
        typeTag(item.type),
        el('span', { class: 'row-title', text: item.title, attrs: { title: item.title } }),
        el('span', { class: 'saved-path mono', text: item.path, attrs: { title: item.path } })
      ]);
    }));
  }

  function pushLog(entry) {
    state.logs.push(entry);
    if (state.logs.length > LOG_LIMIT) {
      state.logs.splice(0, state.logs.length - LOG_LIMIT);
      logsRendered = 0;
      $('log-box').replaceChildren();
    }
  }

  function renderLogs() {
    $('badge-logs').textContent = String(state.logs.length);
    $('st-logs-count').textContent = '日志 ' + state.logs.length + ' 条 · 阶段 ' + (state.phase || '未知');
    // 抽屉收起时也要能看见最新一条——否则「日志看不到」等于没修。
    var last = state.logs.length ? state.logs[state.logs.length - 1] : null;
    var line = $('logdock-latest');
    if (line) line.textContent = last && last.message != null ? String(last.message) : '暂无日志';
    var dot = $('logdock-dot');
    if (dot) dot.setAttribute('data-level', last ? (last.level || 'info') : 'idle');
  }

  function logLine(entry) {
    return el('div', { class: 'log-line', attrs: { 'data-level': entry.level || 'info' } }, [
      el('span', { class: 'log-time', text: formatTime(entry.time) }),
      el('span', { class: 'log-msg', text: entry.message == null ? '' : String(entry.message) })
    ]);
  }

  function syncLogs() {
    var box = $('log-box');
    if (state.logs.length < logsRendered) {
      box.replaceChildren();
      logsRendered = 0;
    }
    var stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
    for (var i = logsRendered; i < state.logs.length; i += 1) box.append(logLine(state.logs[i]));
    logsRendered = state.logs.length;
    if (stick) box.scrollTop = box.scrollHeight;
    renderLogs();
  }

  var doneDismissed = false;

  /**
   * 本地累积一条「已提取内容」（与服务端快照同构，SSE 事件到达时即时更新）。
   */
  function appendExtractedLocal(data, status) {
    if (!Array.isArray(state.extracted)) state.extracted = [];
    state.extracted.push({
      time: new Date().toISOString().slice(11, 19),
      status: status === 'reused' ? 'reused' : 'saved',
      title: String(data.title || ''),
      level: String(data.level || data.title || ''),
      taskType: String(data.taskType || ''),
      images: num(data.images),
      path: String(data.path || ''),
      directory: String(data.directory || ''),
      experiment: data.experiment ? String(data.experiment) : String(state.currentExperiment || ''),
      course: data.course
        ? String(data.course)
        : state.selectedCourse
          ? String(state.selectedCourse.name || '')
          : ''
    });
  }

  /**
   * 「已提取内容」面板：汇总本次会话已保存/复用的关卡，并把
   * 「开始提取（清空重来）」与「继续提取（保留）」分成两个按钮。
   * 两者都保留浏览器与登录态；区别只在是否清空课程/实验/关卡列表。
   */
  function renderExtracted() {
    var panel = $('panel-extracted');
    var items = Array.isArray(state.extracted) ? state.extracted : [];
    var busy = state.phase && state.phase !== 'done' && state.phase !== 'error' && state.phase !== 'starting';
    var hasAny = items.length > 0 || (state.done && (num(state.done.saved) || num(state.done.skipped)));
    panel.hidden = !hasAny;
    if (!hasAny) return;

    $('extracted-badge').textContent = String(items.length);

    // 按 课程 / 实验 归组，便于确认「哪些实验提取了多少关」
    var groups = [];
    var index = {};
    items.forEach(function (item) {
      var key = (item.course || '') + '\u0000' + (item.experiment || '');
      if (index[key] == null) {
        index[key] = groups.length;
        groups.push({
          course: item.course || '（未知课程）',
          experiment: item.experiment || '（未知实验）',
          saved: 0,
          reused: 0,
          rows: []
        });
      }
      var group = groups[index[key]];
      if (item.status === 'reused') group.reused += 1; else group.saved += 1;
      group.rows.push(item);
    });

    var reused = items.filter(function (item) { return item.status === 'reused'; }).length;
    var savedCount = items.length - reused;
    $('extracted-summary').textContent =
      '本次会话已提取 ' + items.length + ' 关（新保存 ' + savedCount + '，复用已存在 ' + reused + '），涉及 ' +
      groups.length + ' 个实验。';
    $('extracted-hint').textContent =
      '「开始提取」会清空下面的课程/实验/关卡列表并重新读取课程；「继续提取」保留这些内容，' +
      '适合补抓同一实验的其它关卡或换一个实验。两者都不会关闭浏览器。';

    var list = $('extracted-list');
    list.replaceChildren.apply(list, groups.map(function (group) {
      var rows = group.rows.map(function (item) {
        return el('div', { class: 'extracted-item' + (item.status === 'reused' ? ' is-reused' : '') }, [
          el('span', { class: 'mono', text: item.level || item.title || '未命名关卡' }),
          el('span', { class: 'extracted-tag', text: item.status === 'reused' ? '复用' : item.taskType || '已保存' }),
          item.images > 0 ? el('span', { class: 'extracted-tag', text: '图 ' + item.images }) : null
        ]);
      });
      return el('div', { class: 'extracted-group' }, [
        el('div', { class: 'extracted-group-hd' }, [
          el('strong', { text: group.course }),
          el('span', { class: 'extracted-sep', text: '›' }),
          el('strong', { text: group.experiment }),
          el('span', { class: 'spacer' }),
          el('span', { class: 'hint mono', text: '新 ' + group.saved + ' · 复用 ' + group.reused })
        ])
      ].concat(rows));
    }));

    // 任务进行中不允许再次启动
    $('btn-restart').disabled = busy;
    $('btn-continue').disabled = busy;
  }

  function renderDone() {
    var panel = $('panel-done');
    var done = state.done;
    if (!done || typeof done !== 'object' || doneDismissed) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    $('done-saved').textContent = num(done.saved);
    $('done-skipped').textContent = num(done.skipped);
    $('done-failed').textContent = num(done.failed);
    $('done-badge').textContent = done.stopped ? '已停止（部分结果）' : '已完成';
    $('done-root').textContent = done.exportRoot || '—';
    $('done-root').title = done.exportRoot || '';
    var notes = [];
    if (done.stopped) notes.push('任务被提前停止，以上为已抓取的部分结果。');
    if (num(done.failed) > 0) notes.push('存在失败项，请查看日志定位原因。');
    if (num(done.dropped) > 0) {
      notes.push('已抛弃 ' + num(done.dropped) + ' 关非编程题/选择题（如虚拟机、图形化、纯问答），产物里只有编程题与选择题。');
    }
    if (!notes.length) notes.push('全部关卡处理完毕，每个实验一个 md 文件。');
    $('done-note').textContent = notes.join(' ');
  }

  /* ------------------------------ bulk selection ------------------------------ */

  function applyBulk(target, mode) {
    var host = target === 'experiments' ? listEl('experiments') : listEl('levels');
    if (host.classList.contains('locked')) return;
    submitted[target] = false;
    var next = new Set(target === 'experiments' ? sel.experiments : sel.levels);
    if (target === 'experiments') {
      visibleEntries('experiments').forEach(function (entry) {
        var index = entry.index;
        var current = sel.experiments.has(index);
        if (mode === 'all' || (mode === 'invert' && !current)) next.add(index);
        else next.delete(index);
      });
      sel.experiments = next;
    } else {
      visibleEntries('levels').forEach(function (entry) {
        var level = entry.item, index = entry.index;
        var key = levelKey(level, index);
        var current = sel.levels.has(key);
        // 跳过清单：「全选」不勾本地已有的关（存档 / 已有答案）。
        // 反选 / 手动勾选不受影响——要重抓某一关，手动勾上就行。
        var done = level && level.localDone && (level.localDone.archived || level.localDone.answered);
        if (done && mode === 'all') { next.delete(key); return; }
        if (mode === 'all' || (mode === 'invert' && !current)) next.add(key);
        else next.delete(key);
      });
      sel.levels = next;
    }
    host.querySelectorAll('.row input').forEach(function (input) { input.checked = false; });
    renderListsChecked();
    renderControls();
    renderSelectionBadges();
  }

  /**
   * 关卡的稳定键：优先关卡标识，其次列表自带的 challengeId，最后用序号。
   * 关卡列表常常只有名称（identifier 为空），此前各处 fallback 不一致
   * （渲染用 'level-N'、提交却发 String(identifier)='undefined'），
   * 导致「只能全选、无法选择性跳过」。所有地方统一走这个函数。
   */
  function levelKey(level, index) {
    return selectionModel.levelKey(level, index);
  }

  function renderListsChecked() {
    ['courses', 'experiments', 'levels'].forEach(function (kind) {
      listEl(kind).querySelectorAll('.row input').forEach(function (input) {
        var index = Number(input.dataset.index), item = state[kind][index];
        input.checked = kind === 'courses' ? String(sel.courseId) === String(item.id != null ? item.id : index)
          : kind === 'experiments' ? sel.experiments.has(index) : sel.levels.has(levelKey(item, index));
      });
    });
  }

  /* ------------------------------ network ------------------------------ */

  function fetchState(silent) {
    if (!stateRequest) stateRequest = readState(silent).finally(function () { stateRequest = null; });
    return stateRequest;
  }

  async function readState(silent) {
    // 若请求期间已有更新的实时事件到达，该快照可能陈旧，重取而不是覆盖实时状态
    for (var attempt = 0; attempt < 3; attempt += 1) {
      var seqBefore = eventSeq;
      try {
        var response = await fetch('/api/state?token=' + encodeURIComponent(TOKEN), { headers: { Accept: 'application/json' } });
        if (response.status === 403) throw new Error('访问凭据无效，请用控制台输出的完整地址重新打开');
        if (!response.ok) throw new Error('HTTP ' + response.status);
        var snapshot = await response.json();
        if (eventSeq !== seqBefore) continue;
        applySnapshot(snapshot);
        if (!silent) toast('已重新同步后端状态', 'info');
        return true;
      } catch (error) {
        if (!silent) {
          toast('同步状态失败：' + error.message, 'error');
          state.error = '同步 /api/state 失败：' + error.message;
          renderChrome();
        }
        return false;
      }
    }
    return false;
  }

  function connectEvents() {
    if (!TOKEN) {
      connection = 'error';
      renderChrome();
      return;
    }
    var source = new EventSource('/api/events?token=' + encodeURIComponent(TOKEN));
    eventSource = source;

    function handle(type, event) {
      var data = null;
      try { data = JSON.parse(event.data); } catch (error) { data = null; }
      applyWireEvent(type, data);
    }

    source.onopen = function () {
      var wasDown = connection !== 'open';
      connection = 'open';
      renderChrome();
      if (wasDown) fetchState(true);
    };

    source.onmessage = function (event) { handle('', event); };

    EVENT_TYPES.forEach(function (type) {
        source.addEventListener(type, function (event) { handle(type, event); });
      });

    source.onerror = function () {
      connection = 'error';
      renderChrome();
    };
  }

  /* ------------------------------ Agent handoff ------------------------------ */

  async function loadAgentTargets() {
    if (!TOKEN) return false;
    if (agentLoading) return agentLoading;
    $('btn-agent-refresh').disabled = true;
    agentLoading = (async function () {
      try {
        var response = await fetch('/api/agent/targets?token=' + encodeURIComponent(TOKEN));
        var data = await response.json();
        if (!response.ok || data.ok === false) throw new Error(data.error || data.message || '读取本地资料失败');
        agentCourses = toArray(data.courses);
        renderAgentCatalog();
        return true;
      } catch (error) {
        toast('读取本地资料失败：' + error.message, 'error');
        return false;
      } finally {
        agentLoading = null;
        $('btn-agent-refresh').disabled = false;
      }
    })();
    return agentLoading;
  }

  function renderAgentCatalog() {
    var experiments = 0, levels = 0, answered = 0;
    var rows = agentCourses.map(function (course) {
      var courseLevels = 0, courseAnswered = 0;
      toArray(course.experiments).forEach(function (experiment) {
        experiments++;
        toArray(experiment.levels).forEach(function (level) { courseLevels++; if (level.answered) courseAnswered++; });
      });
      levels += courseLevels;
      answered += courseAnswered;
      var first = toArray(course.experiments)[0];
      var code = first && first.classroom && first.classroom.code;
      return el('div', { class: 'catalog-row' }, [
        el('span', { text: course.name + (code ? '（' + code + '）' : '') }), el('small', { text: courseAnswered + ' / ' + courseLevels + ' 关有答案' })
      ]);
    });
    $('agent-experiments').textContent = String(experiments);
    $('agent-levels').textContent = String(levels);
    $('agent-answered').textContent = String(answered);
    $('agent-catalog').replaceChildren.apply($('agent-catalog'), rows.length ? rows : [el('div', { class: 'agent-empty', text: '还没有本地资料。先选择课程并抓取题目；已有答案也会计入这里。' })]);
  }

  function agentTaskText() {
    var chosen = state.selectedCourse;
    var chosenCode = chosen && String(chosen.classroomCode || chosen.code || '');
    var courses = chosen ? agentCourses.filter(function (course) {
      var first = toArray(course.experiments)[0];
      var code = String((first && first.classroom && first.classroom.code) || course.code || '');
      return chosenCode ? chosenCode === code : course.name === chosen.name;
    }) : agentCourses;
    if (chosen && !chosenCode && courses.length > 1) courses = [];
    var selected = Array.from(sel.experiments).map(function (index) { return state.experiments[index]; }).filter(Boolean);
    if (!selected.length) selected = toArray(state.selectedExperiments).filter(function (item) { return item && typeof item === 'object'; });
    if (chosen && selected.length) {
      courses = courses.map(function (course) {
        return Object.assign({}, course, { experiments: toArray(course.experiments).filter(function (experiment) {
          return selected.some(function (item) {
            var wantedId = Number(item.homeworkId || item.homework_id);
            var actualId = Number(experiment.homeworkId || experiment.homework_id);
            return wantedId && actualId ? wantedId === actualId : item.name === experiment.name;
          });
        }) });
      }).filter(function (course) { return course.experiments.length; });
    }
    var lines = [
      '先阅读项目中的 docs/AGENT-ANSWERING.md 和 docs/AI-ANSWER-FORMAT.md，再根据本地题目补全答案。',
      '只处理缺失或尚未验证的答案；保留已经通过的 verified=true 答案，不修改题目存档。',
      '工作文件使用 schema_version: 2；不要把它与供篡改猴导入的 version: 2、kind: class-answers 班级文件混淆。',
      '范围：' + (courses.length ? courses.map(function (course) { return course.name; }).join('、') : chosen ? '当前选定课程或实验尚无可匹配的本地资料。请先补抓或核对课堂码；不要扩展到其他课程。' : 'exports/ 中已抓取的题目。没有题目时先抓题，不猜测实验内容。')
    ];
    courses.forEach(function (course) {
      toArray(course.experiments).forEach(function (experiment) {
        lines.push('- ' + course.name + ' / ' + experiment.name);
        if (experiment.mdPath) lines.push('  题目：' + experiment.mdPath);
        if (experiment.answerPath) lines.push('  工作答案：' + experiment.answerPath);
      });
    });
    lines.push('按文档完成格式校验，并汇报完成与无法作答的关卡。导出班级文件后交给我检查；不要自动提交平台。');
    return lines.join('\n');
  }

  async function copyAgentTask() {
    if (!(await loadAgentTargets())) return;
    var ok = await copyText(agentTaskText());
    toast(ok ? '已复制 Agent 任务，粘贴到你使用的 Agent 即可' : '复制失败，请直接阅读下载的说明文档', ok ? 'ok' : 'warn');
  }

  async function copyConsoleAddress() {
    var ok = await copyText(location.href);
    toast(ok ? '已复制控制台连接地址' : '复制失败，请从地址栏复制', ok ? 'ok' : 'warn');
  }

  async function publishClassAnswers(event) {
    event.preventDefault();
    if (publishing) return;
    var grade = $('publish-grade').value.trim();
    var className = $('publish-class').value.trim();
    if (!className) { $('publish-class').focus(); return; }
    publishing = true;
    $('btn-publish').disabled = true;
    try {
      var result = await postAction('export-class-answers', { grade: grade, className: className });
      var box = $('publish-result');
      box.replaceChildren(el('div', { text: result.message || '班级答案文件已导出。' }));
      if (result.path) box.append(el('code', { text: result.path }));
      box.hidden = false;
      try { localStorage.setItem('educoder-publish-class', JSON.stringify({ grade: grade, className: className })); } catch (error) { /* optional preference */ }
      toast('班级答案文件已导出，可导入篡改猴使用', 'ok');
      loadAgentTargets();
    } catch (error) {
      toast('导出失败：' + error.message, 'error');
    } finally {
      publishing = false;
      $('btn-publish').disabled = false;
    }
  }

  function renderExtractionMode() {
    var answersOnly = $('opt-answers-only').checked;
    $('mode-description').textContent = answersOnly
      ? '仅保存可取得的答案，不保存题目。'
      : '关闭时保存题目、初始代码和可用答案。';
  }

  /**
   * 日志抽屉：贴底常驻，收起时一行显示最新一条，展开占 44vh。
   *
   * 为什么要做成抽屉而不是页面底部的普通面板：那个位置在 900px 高度的屏幕上
   * 根本滚不到，而日志恰恰是抓取时最需要盯的东西。状态记在 localStorage，刷新后保持。
   */
  function setupLogDock() {
    var dock = $('logdock');
    var button = $('btn-logdock');
    var cue = $('logdock-cue');
    if (!dock || !button) return;
    function apply(open) {
      dock.setAttribute('data-open', open ? 'true' : 'false');
      // body 上的标记用来给内容留出抽屉高度、并把提示浮到抽屉之上
      document.body.setAttribute('data-logopen', open ? 'true' : 'false');
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (cue) cue.textContent = open ? '收起 ▾' : '展开 ▴';
      if (open) {
        var box = $('log-box');
        if (box) box.scrollTop = box.scrollHeight; // 展开就直接给最新一条
      }
    }
    var saved = '';
    try { saved = localStorage.getItem('logOpen') || ''; } catch (error) { /* 无痕/禁存储时降级为不记忆 */ }
    apply(saved === '1');
    button.addEventListener('click', function () {
      var open = dock.getAttribute('data-open') !== 'true';
      apply(open);
      try { localStorage.setItem('logOpen', open ? '1' : '0'); } catch (error) { /* 同上 */ }
    });
  }

  /* ------------------------------ 缺答案清单 ------------------------------ */

  /** 渲染清单：行结构复用「已提取内容」的既有样式类。 */
  function renderMissing(items) {
    var list = $('list-missing');
    var badge = $('badge-missing');
    if (!list) return;
    var rows = (items || []).map(function (item) {
      return el('div', { class: 'extracted-item' }, [
        el('span', { class: 'mono', text: item.level || '（未命名关卡）' }),
        el('span', { class: 'extracted-tag', text: item.reason || 'no-answer' }),
        el('span', { class: 'hint', text: [item.course, item.experiment].filter(Boolean).join(' · ') }),
        el('span', { class: 'hint mono', text: item.reported_at ? formatTime(item.reported_at) : '' })
      ]);
    });
    if (badge) badge.textContent = String((items || []).length);
    list.replaceChildren.apply(list, rows);
    list.dataset.empty = rows.length ? 'false' : 'true';
  }

  async function loadMissing() {
    try {
      var response = await fetch('/api/missing?token=' + encodeURIComponent(TOKEN), {
        headers: { Accept: 'application/json' }
      });
      var payload = await response.json();
      if (!payload || !payload.ok) {
        toast('读取缺答案清单失败', 'error');
        return;
      }
      renderMissing(payload.items);
    } catch (error) {
      toast('读取缺答案清单失败：' + error.message, 'error');
    }
  }

  async function clearMissingList() {
    if (!window.confirm('清空缺答案清单？（只清记录，不动任何答案文件）')) return;
    try {
      var response = await fetch('/api/missing?token=' + encodeURIComponent(TOKEN), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clear' })
      });
      var payload = await response.json();
      if (payload && payload.ok) {
        renderMissing([]);
        toast('缺答案清单已清空', 'ok');
      } else {
        toast('清空失败：' + ((payload && payload.error) || response.status), 'error');
      }
    } catch (error) {
      toast('清空失败：' + error.message, 'error');
    }
  }

  /* ------------------------------ wiring ------------------------------ */

  function showWorkspace(view) {
    var descriptions = {
      capture: ['CAPTURE / 01', '把课程资料整理到本地', '选择课程、实验和关卡。已有内容自动复用，抓取范围由你决定。', '课程 → 实验 → 关卡'],
      handoff: ['WORKSPACE / 02', '整理资料，补全答案', '把本地资料交给你选择的 Agent，再将工作答案导出使用。', '资料 → Agent → 导出']
    };
    if (!descriptions[view]) view = 'capture';
    document.body.dataset.view = view;
    document.querySelectorAll('[data-view-target]').forEach(function (button) {
      if (button.dataset.viewTarget === view) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    ['workspace-eyebrow', 'workspace-title', 'workspace-description', 'workspace-tag'].forEach(function (id, index) { $(id).textContent = descriptions[view][index]; });
    try { localStorage.setItem('touge-console-view', view); } catch (error) { /* optional preference */ }
  }

  function bind() {
    document.querySelectorAll('[data-view-target]').forEach(function (button) {
      button.addEventListener('click', function () { showWorkspace(button.dataset.viewTarget); });
    });
    var renderers = { courses: renderCourses, experiments: renderExperiments, levels: renderLevels };
    Object.keys(renderers).forEach(function (kind) {
      $('search-' + kind).addEventListener('input', function (event) {
        filters[kind] = event.target.value;
        renderers[kind](true);
        renderControls();
      });
    });
    try { showWorkspace(localStorage.getItem('touge-console-view') || 'capture'); }
    catch (error) { showWorkspace('capture'); }
    $('btn-refresh').addEventListener('click', function () { fetchState(false); });

    $('btn-agent-guide').href = '/api/agent/guide?token=' + encodeURIComponent(TOKEN);
    $('btn-agent-refresh').addEventListener('click', loadAgentTargets);
    $('btn-agent-copy').addEventListener('click', copyAgentTask);
    $('btn-console-copy').addEventListener('click', copyConsoleAddress);
    $('publish-form').addEventListener('submit', publishClassAnswers);
    $('opt-answers-only').addEventListener('change', renderExtractionMode);
    renderExtractionMode();
    try {
      var savedClass = JSON.parse(localStorage.getItem('educoder-publish-class') || '{}');
      $('publish-grade').value = savedClass.grade || '';
      $('publish-class').value = savedClass.className || '';
    } catch (error) { /* optional preference */ }
    setupLogDock();

    $('btn-course').addEventListener('click', function () {
      if (sel.courseId == null) return;
      runAction('select-course', { courseId: sel.courseId }, '选择课程');
    });

    $('btn-experiments').addEventListener('click', function () {
      var indices = Array.from(sel.experiments).sort(function (a, b) { return a - b; });
      if (!indices.length) return;
      runAction('select-experiments', { indices: indices }, '选择实验');
    });

    $('btn-levels').addEventListener('click', function () {
      // 只提交被勾选的关卡。无标识的列表用 position/challengeId 表达选择，
      // 不再发送 "undefined"（那会让服务端匹配不到，退化成「全选」）。
      var picked = state.levels.filter(function (level, index) {
        return sel.levels.has(levelKey(level, index));
      });
      if (!picked.length) {
        toast('请至少勾选一个关卡', 'error');
        return;
      }
      runAction('select-levels', {
        levels: picked.map(function (level) {
          return {
            identifier: level.identifier != null ? String(level.identifier) : '',
            position: Number(level.position != null ? level.position : level.index) || null,
            challengeId: level.challengeId != null ? String(level.challengeId) : '',
            experimentIndex: level.experimentIndex != null ? Number(level.experimentIndex) : undefined
          };
        })
      }, '选择关卡');
    });

    // 「开始提取（清空重来）」：清空上一轮的课程/实验/关卡列表与已提取内容
    $('btn-restart').addEventListener('click', function () {
      doneDismissed = true;
      renderDone();
      runAction('reset', {}, '开始提取');
    });

    // 「继续提取（保留上面内容）」：保留列表，直接回到课程选择继续补抓
    $('btn-continue').addEventListener('click', function () {
      doneDismissed = false;
      var answersOnlyToggle = $('opt-answers-only');
      runAction('start', {
        skipExisting: !($('opt-redownload') && $('opt-redownload').checked),
        answersOnly: Boolean(answersOnlyToggle && answersOnlyToggle.checked)
      }, '继续提取');
    });

    $('btn-start').addEventListener('click', function () {
      // 一轮提取结束后再次点击 = 开始新一轮：先收起上一轮的结果面板。
      doneDismissed = true;
      renderDone();
      var redownload = $('opt-redownload');
      var answersOnlyToggle = $('opt-answers-only');
      runAction('start', {
        skipExisting: !(redownload && redownload.checked),
        answersOnly: Boolean(answersOnlyToggle && answersOnlyToggle.checked)
      }, '开始提取');
    });

    $('btn-stop').addEventListener('click', function () {
      runAction('stop', {}, '停止任务');
    });

    $('btn-diagnose').addEventListener('click', function () {
      runAction('diagnose', {}, '诊断');
    });

    $('btn-copy-root').addEventListener('click', function () {
      var text = $('done-root').textContent;
      copyText(text).then(function (ok) {
        toast(ok ? '已复制导出目录' : '复制失败，请手动选中复制', ok ? 'ok' : 'warn');
      });
    });

    document.querySelectorAll('[data-bulk]').forEach(function (button) {
      button.title = '仅作用于当前搜索结果，其他选择会保留；全选会排除本地已有的关卡';
      button.addEventListener('click', function () {
        applyBulk(button.dataset.target, button.dataset.bulk);
      });
    });

    $('btn-missing-refresh').addEventListener('click', loadMissing);
    $('btn-missing-clear').addEventListener('click', clearMissingList);

    document.addEventListener('keydown', function (event) {
      if (event.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(event.target.tagName) && document.body.dataset.view === 'capture') {
        event.preventDefault();
        var pane = ['courses', 'experiments', 'levels'].find(function (kind) { return can(kind === 'courses' ? 'course' : kind); }) || 'courses';
        $('search-' + pane).focus();
      }
    });
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) { /* 回退方案 */ }
    try {
      var area = el('textarea', { props: { value: text } });
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      var ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch (error) {
      return false;
    }
  }

  function init() {
    bind();
    renderAll({ forceLists: true });
    syncLogs();
    if (!TOKEN) {
      state.error = 'URL 缺少 token，请使用终端输出的完整地址打开本页面。';
      renderChrome();
      toast('URL 缺少 token，无法连接后端', 'error');
      return;
    }
    fetchState(true).then(function () {
      connectEvents();
      renderAll({ forceLists: true });
      loadAgentTargets();
      loadMissing();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  window.addEventListener('pagehide', function () {
    if (eventSource) eventSource.close();
  });
})();
