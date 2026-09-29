// 通用提取器：适用于头歌课程列表页 / 课程详情页 / 关卡任务页
// 用法：
// 1. 打开头歌“教学课堂 / 课程列表”页面
// 2. 在控制台执行：
//    const runner = new EducoderExtractor();
//    await runner.init();
// 3. 脚本会列出课程列表，随后你可调用：
//    await runner.exportSelectedCourse('示例课程B');
// 4. 仅提取并导出资料，不自动答题、不自动提交、不自动评测

(() => {
  if (window.EducoderExtractor) return;

  class EducoderExtractor {
    constructor() {
      this.courseList = [];
      this.selectedCourse = null;
    }

    getText(node) {
      if (!node) return '';
      return (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
    }

    getSafeFileName(value) {
      return String(value || 'untitled')
        .replace(/[\\/:*?"<>|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    downloadBlob(filename, content, type = 'application/json') {
      const blob = new Blob([content], { type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 500);
    }

    normalizeCourseName(name) {
      return (name || '').replace(/\s+/g, ' ').trim();
    }

    getReactCourseData() {
      const roots = [...document.querySelectorAll('a')];
      for (const root of roots) {
        const fiberKey = Object.keys(root).find(key => key.startsWith('__reactFiber'));
        if (!fiberKey) continue;
        let fiber = root[fiberKey];
        for (let depth = 0; fiber && depth < 20; depth += 1, fiber = fiber.return) {
          const props = fiber.memoizedProps;
          const source = props && Array.isArray(props.dataSource) ? props.dataSource : null;
          if (!source) continue;
          const courses = source.filter(item => item && item.name && item.first_category_url);
          if (courses.length) return courses;
        }
      }
      return [];
    }

    findCourseList() {
      const reactCourses = this.getReactCourseData();
      if (reactCourses.length) {
        this.courseList = reactCourses.map(course => ({
          name: this.normalizeCourseName(course.name),
          href: new URL(course.first_category_url, location.origin).href,
          classroomId: course.id,
          classroomIdentifier: course.first_category_url.split('/')[2],
          id: this.getSafeFileName(course.name)
        }));
        return this.courseList;
      }

      const aNodes = [...document.querySelectorAll('a[href]')];
      const seen = new Set();
      const items = [];

      for (const a of aNodes) {
        const name = this.normalizeCourseName(this.getText(a));
        const href = a.href || '';
        if (!name || name.length < 4 || seen.has(name)) continue;
        const isLikelyCourse = /课程|实验|机器学习|编程|设计|程序|系统|算法|导论|面向对象|网络|软件|CNN|卷积/i.test(name)
          || /\/users\//.test(href) === false;
        if (!isLikelyCourse) continue;
        if (/首页|个人主页|我的|正在进行|已结束|教学课堂|全部|我学习的|我管理的|加入教学课堂|查看全部任务/.test(name)) continue;
        if (/\.com$/.test(href)) continue;
        seen.add(name);
        items.push({ name, href, id: this.getSafeFileName(name) });
      }

      this.courseList = items
        .filter(item => item.name.length > 4)
        .filter((item, index, arr) => arr.findIndex(x => x.name === item.name) === index);

      return this.courseList;
    }

    showCourseChoice() {
      const courses = this.findCourseList();
      if (!courses.length) {
        console.warn('未识别到课程列表，请在“教学课堂 / 我的课程”页执行此脚本。');
        return [];
      }
      console.table(courses.map((c, i) => ({ idx: i + 1, name: c.name, href: c.href })));
      return courses;
    }

    getTaskLinksFromPage() {
      const links = [...document.querySelectorAll('a[href]')]
        .map(a => ({ text: this.getText(a), href: a.href }))
        .filter(x => x.text && /\d+关|任务|实验|题目|卷积|CNN|conv|practice|task/i.test(x.text) && /\/tasks\//.test(x.href));
      return [...new Map(links.map(item => [item.href, item])).values()];
    }

    extractTaskMetadata(doc, taskUrl, courseName) {
      const titleNode = doc.querySelector('h1, h2, h3');
      const title = this.getText(titleNode) || doc.title || 'untitled';
      const body = doc.body;
      const bodyText = this.getText(body);
      const codeTexts = [...doc.querySelectorAll('code, textarea, pre')]
        .map(node => this.getText(node))
        .filter(Boolean)
        .slice(0, 10)
        .join('\n\n');

      const sectionNames = ['任务描述', '编程要求', '测试说明'];
      const sectionMap = {};
      for (const name of sectionNames) {
        const heading = [...doc.querySelectorAll('h4, h5, h6')].find(node => this.getText(node) === name);
        if (!heading) continue;
        const parts = [];
        for (let node = heading.nextElementSibling; node; node = node.nextElementSibling) {
          if (/^H[1-6]$/.test(node.tagName)) break;
          const value = this.getText(node);
          if (value) parts.push(value);
        }
        sectionMap[name] = parts.join('\n\n');
      }

      return {
        course: courseName,
        source: taskUrl,
        title,
        extractedAt: new Date().toISOString(),
        taskDescription: sectionMap['任务描述'] || '',
        programmingRequirements: sectionMap['编程要求'] || '',
        testDescription: sectionMap['测试说明'] || '',
        bodyText: bodyText.slice(0, 12000),
        starterCode: codeTexts.slice(0, 20000),
        pageTitle: doc.title || ''
      };
    }

    async exportSelectedCourse(courseName) {
      const courseList = this.findCourseList();
      const target = courseList.find(c => c.name.includes(courseName) || courseName.includes(c.name));
      if (!target) {
        throw new Error(`未找到课程：${courseName}`);
      }

      const courseKey = this.getSafeFileName(target.name);
      const tasks = [];
      const hrefs = this.getTaskLinksFromPage();

      if (!hrefs.length) {
        console.warn('当前页面没有检测到关卡链接。请先打开该课程页，进入“全部任务/关卡列表”视图再执行。');
        return { course: target.name, tasks: [] };
      }

      for (const item of hrefs) {
        try {
          const res = await fetch(item.href, { credentials: 'same-origin' });
          const html = await res.text();
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const metadata = this.extractTaskMetadata(doc, item.href, target.name);
          metadata.taskIndex = tasks.length + 1;
          tasks.push(metadata);
        } catch (error) {
          console.warn('抓取失败：', item.href, error);
        }
      }

      const totalJson = {
        course: target.name,
        taskCount: tasks.length,
        tasks
      };

      this.downloadBlob(`${courseKey}_全量题目.json`, JSON.stringify(totalJson, null, 2), 'application/json');

      for (const task of tasks) {
        const fileName = `${courseKey}_${this.getSafeFileName(task.title)}.json`;
        this.downloadBlob(fileName, JSON.stringify(task, null, 2), 'application/json');
      }

      console.log('导出完成：', totalJson);
      return totalJson;
    }

    async init() {
      const courses = this.showCourseChoice();
      return courses;
    }
  }

  window.EducoderExtractor = EducoderExtractor;
  window.educoderExtractor = new EducoderExtractor();
  console.log('EducoderExtractor 已加载。请在课程列表页执行：');
  console.log('const runner = new EducoderExtractor();');
  console.log('await runner.init();');
  console.log('await runner.exportSelectedCourse("示例课程B");');
})();
