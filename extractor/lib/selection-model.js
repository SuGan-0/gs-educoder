(function (root) {
  'use strict';

  function levelKey(level, index) {
    var owner = level && level.experimentIndex != null ? 'exp:' + level.experimentIndex + '/' : '';
    if (level && level.identifier) return owner + 'id:' + level.identifier;
    if (level && level.challengeId) return owner + 'cid:' + level.challengeId;
    var position = Number(level && (level.position != null ? level.position : level.index));
    return owner + (position > 0 ? 'pos:' + position : 'idx:' + index);
  }

  function matches(item, query) {
    var text = String(query || '').trim().toLocaleLowerCase();
    if (!text) return true;
    var haystack = [item && item.name, item && item.experimentName, item && item.school,
      item && item.classroomCode, item && item.code, item && item.identifier, item && item.homeworkId].join(' ').toLocaleLowerCase();
    return text.split(/\s+/).every(function (word) { return haystack.includes(word); });
  }

  function entries(items, query) {
    return items.map(function (item, index) { return { item: item, index: index }; })
      .filter(function (entry) { return matches(entry.item, query); });
  }

  /** 强身份不命中时不回退序号；没有实验归属且存在多个匹配时拒绝猜测。 */
  function resolveLevelSelection(all, payload) {
    var wanted = Array.isArray(payload.levels) ? payload.levels : payload.identifiers;
    if (!Array.isArray(wanted) || !wanted.length) throw new Error('请至少选择一个关卡');
    return Array.from(new Set(wanted.map(function (want) {
      var object = want && typeof want === 'object';
      var owner = object && want.experimentIndex != null ? Number(want.experimentIndex) : null;
      if (owner != null && (!Number.isInteger(owner) || owner < 0)) throw new Error('实验归属无效，请刷新关卡列表');
      var found = all.filter(function (item) {
        if (!item || (owner != null && (item.experimentIndex == null || Number(item.experimentIndex) !== owner))) return false;
        if (!object) return Boolean(want) && String(item.identifier) === String(want);
        if (want.identifier) return String(item.identifier) === String(want.identifier);
        if (want.challengeId) return String(item.challengeId) === String(want.challengeId);
        var position = Number(want.position != null ? want.position : want.index);
        return position > 0 && Number(item.position != null ? item.position : item.index) === position;
      });
      if (found.length > 1) throw new Error('关卡身份不唯一，请刷新列表后重新选择');
      if (!found.length) throw new Error('未找到关卡，请刷新列表后重新选择');
      return found[0];
    })));
  }

  var model = { levelKey: levelKey, matches: matches, entries: entries, resolveLevelSelection: resolveLevelSelection };
  if (typeof module === 'object' && module.exports) module.exports = model;
  else root.TougeSelection = model;
})(typeof globalThis === 'object' ? globalThis : this);
