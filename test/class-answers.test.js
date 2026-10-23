'use strict';

/** 班级答案文件（version 2）：构建 / 合并 / 校验 / 标识提取。 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  identifiersFromSource,
  buildClassDocument,
  mergeClassDocuments,
  validateClassDocument,
  classAnswersPathFor
} = require('../extractor/lib/class-answers');

/** 构造一个实验的输入：levels.jsonl 记录 + v2 答案文档。 */
function experimentInput(name, chapter, levels) {
  const records = levels.map((level) => ({
    levelId: level.level_id,
    taskIndex: level.position,
    title: level.title,
    type: level.kind,
    source: level.source || ''
  }));
  const answerDoc = {
    schema_version: 2,
    classroom: { name: '软件工程导论2026年下半年', code: '2i6ng7vp' },
    experiment: { name, homework_id: 0 },
    answers: levels
      // answered=true 表示「有关卡条目」——即使答案是空的（校验要能抓到这种坏数据）
      .filter((level) => level.answer !== undefined || level.answered === true || Array.isArray(level.selected))
      .map((level) => ({
        level_id: level.level_id,
        task_identifier: level.task_identifier || '',
        title: level.title,
        kind: level.kind,
        source: level.answerSource || 'ai',
        verified: false,
        // normalizeAnswer 的输出是**扁平**的：choice → questions[]，code → language/code
        questions: level.kind === 'choice'
          ? (level.selected || []).map((s, i) => ({ number: i + 1, selected: [s] }))
          : undefined,
        language: level.language || 'python',
        code: level.kind === 'code' ? (level.answer || '') : undefined
      })),
    unanswered: []
  };
  return { name, chapter, records, answerDoc };
}

test('identifiersFromSource：两种任务 URL 形态都只取关卡标识', () => {
  assert.deepEqual(
    identifiersFromSource('https://www.educoder.net/tasks/wafjr3xgmk5b?homework_common_id=4200883&zzud=x'),
    ['wafjr3xgmk5b']
  );
  assert.deepEqual(
    identifiersFromSource('https://www.educoder.net/tasks/2i6ng7vp/4200880/efbt5uy9cgwj?coursesId=2i6ng7vp'),
    ['efbt5uy9cgwj']
  );
  assert.deepEqual(identifiersFromSource(''), []);
});

test('buildClassDocument：一个班一份文件，课堂/实验/关卡三层，答案按 level_id 对齐', () => {
  const doc = buildClassDocument({
    grade: '2024级',
    className: '软工24-15、16班',
    classrooms: [
      {
        name: '软件工程导论2026年下半年',
        code: '2i6ng7vp',
        experiments: [
          experimentInput('面向对象分析之类图', '8、面向对象分析', [
            { level_id: 'L001', position: 1, title: '软件危机', kind: 'choice', source: 'https://www.educoder.net/tasks/aaa1111111' },
            { level_id: 'L002', position: 2, title: '类图题目初体验', kind: 'choice', selected: ['A'], source: 'https://www.educoder.net/tasks/bbb2222222' }
          ]),
          experimentInput('面向对象分析之顺序图', '8、面向对象分析', [
            { level_id: 'L001', position: 1, title: '软件危机', kind: 'choice', source: 'https://www.educoder.net/tasks/aaa1111111' }
          ])
        ]
      }
    ]
  });

  assert.equal(doc.version, 2);
  assert.equal(doc.kind, 'class-answers');
  assert.equal(doc.class.grade, '2024级');
  assert.equal(doc.classrooms.length, 1);
  const experiment = doc.classrooms[0].experiments[0];
  assert.equal(experiment.chapter, '8、面向对象分析');
  // 同一关标识（两个实验共用公共测验）→ identifiers 都取到
  assert.deepEqual(experiment.levels[0].identifiers, ['aaa1111111']);
  // 有答案的关：答案与来源都进来了；没答案的关：answered=false
  assert.equal(experiment.levels[0].answered, false);
  assert.equal(experiment.levels[1].answered, true);
  assert.deepEqual(experiment.levels[1].answer, [{ number: 1, selected: ['A'] }]);
  assert.equal(doc.stats.levels, 3);
  assert.equal(doc.stats.answered, 1);
  assert.equal(doc.stats.missing, 2);
});

test('mergeClassDocuments：新导出没抓到的关卡保留旧答案（不丢）', () => {
  const previous = buildClassDocument({
    grade: '2024级',
    className: '软工24-15、16班',
    classrooms: [
      {
        name: '软件工程导论2026年下半年',
        code: '2i6ng7vp',
        experiments: [
          experimentInput('面向对象分析之类图', '8、面向对象分析', [
            { level_id: 'L001', position: 1, title: '软件危机', kind: 'choice', selected: ['B'], answerSource: 'platform' }
          ])
        ]
      }
    ]
  });
  // 新导出：同一关这次没有答案（answer 未提供）
  const next = buildClassDocument({
    grade: '2024级',
    className: '软工24-15、16班',
    classrooms: [
      {
        name: '软件工程导论2026年下半年',
        code: '2i6ng7vp',
        experiments: [
          experimentInput('面向对象分析之类图', '8、面向对象分析', [
            { level_id: 'L001', position: 1, title: '软件危机', kind: 'choice' }
          ])
        ]
      }
    ]
  });
  const merged = mergeClassDocuments(previous, next);
  const level = merged.classrooms[0].experiments[0].levels[0];
  assert.equal(level.answered, true, '旧答案必须保留');
  assert.deepEqual(level.answer, [{ number: 1, selected: ['B'] }]);
});

// 回归（10-12 实测）：新导出拿不到课堂码时，合并必须仍能按**课堂名**找到旧班级。
// 否则只按 code 查会全部落空 → 旧答案被静默丢掉。实测重新导出班级文件时
// 「结构化分析工具」L002 的人工答案就是这么没的，有答案的关卡 102 → 101。
// （新导出为什么常缺码：关卡 source 不是三段式 `/tasks/{码}/{作业号}/{关卡}` 时就没有码。）
test('mergeClassDocuments：新导出缺课堂码时，按课堂名也要对上，旧答案不能丢', () => {
  const previous = buildClassDocument({
    grade: '2024级',
    className: '软工24-15、16班',
    classrooms: [
      {
        name: '软件工程导论2026年下半年',
        code: '2i6ng7vp',
        experiments: [
          experimentInput('结构化分析工具', '4、需求分析与结构化分析', [
            { level_id: 'L002', position: 2, title: 'Warnier图', kind: 'code', answer: '序号1：(VIP 用户)', answerSource: 'manual' }
          ])
        ]
      }
    ]
  });
  // 新导出：码丢了，只剩课堂名；同一关这次没有答案
  const next = buildClassDocument({
    grade: '2024级',
    className: '软工24-15、16班',
    classrooms: [
      {
        name: '软件工程导论2026年下半年',
        code: '',
        experiments: [
          experimentInput('结构化分析工具', '4、需求分析与结构化分析', [
            { level_id: 'L002', position: 2, title: 'Warnier图', kind: 'code' }
          ])
        ]
      }
    ]
  });
  const merged = mergeClassDocuments(previous, next);
  const classroom = merged.classrooms[0];
  const level = classroom.experiments[0].levels[0];
  assert.equal(level.answered, true, '缺码时旧答案仍必须保留');
  assert.equal(classroom.code, '2i6ng7vp', '旧文件里的课堂码要被捡回来');
});

test('validateClassDocument：空答案/缺班级名要报错，重复标识给 warning', () => {
  const doc = buildClassDocument({
    grade: '2024级',
    className: '软工24-15、16班',
    classrooms: [
      {
        name: '软件工程导论2026年下半年',
        code: '2i6ng7vp',
        experiments: [
          experimentInput('类图', '8、面向对象分析', [
            { level_id: 'L001', position: 1, title: '空答案的选择题', kind: 'choice', answered: true },
            { level_id: 'L002', position: 2, title: '空代码的编程题', kind: 'code', answered: true, answer: '' }
          ])
        ]
      }
    ]
  });
  const verdict = validateClassDocument(doc);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.errors.length, 2, '两关都标了 answered 但答案为空');
  assert.equal(verdict.stats.levels, 2);

  // 同一关卡标识出现在两个实验（公共测验被多个作业引用）→ warning 而非 error
  const shared = buildClassDocument({
    grade: '2024级',
    className: '软工24-15、16班',
    classrooms: [
      {
        name: '软件工程导论2026年下半年',
        code: '2i6ng7vp',
        experiments: [
          experimentInput('类图', '8、面向对象分析', [
            { level_id: 'L001', position: 1, title: '软件危机', kind: 'choice', source: 'https://www.educoder.net/tasks/shared00001' }
          ]),
          experimentInput('顺序图', '8、面向对象分析', [
            { level_id: 'L001', position: 1, title: '软件危机', kind: 'choice', source: 'https://www.educoder.net/tasks/shared00001' }
          ])
        ]
      }
    ]
  });
  const sharedVerdict = validateClassDocument(shared);
  assert.equal(sharedVerdict.ok, true);
  assert.ok(sharedVerdict.warnings.some((w) => /shared00001/.test(w)));
});

test('classAnswersPathFor：年级-班级拼进文件名，非法字符替换', () => {
  const path = classAnswersPathFor('/tmp/out', { grade: '2024级', className: '软工24-15、16班' });
  assert.match(path, /answers[\\/]2024级-软工24-15、16班\.answers\.json$/);
});
