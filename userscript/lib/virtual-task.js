'use strict';

function virtualTaskInfo(payload) {
  const data = payload || {};
  const environments = Array.isArray(data.shixun_environments) ? data.shixun_environments : [];
  const environment = environments.find((item) => item && (item.vnc_url || /(?:\bVNC\b|图形化|远程桌面)/i.test(String(item.name || item.environment_name || ''))));
  const mirrors = Array.isArray(data.mirror_name) ? data.mirror_name.join(' ') : String(data.mirror_name || '');
  return {
    supported: Boolean(data.vnc_url || environment || /(?:\bVNC\b|图形化|远程桌面)/i.test(mirrors)),
    environmentId: Number(environment && (environment.id || environment.shixun_environment_id)) || 0,
    classroomCode: String(data.course_identifier || '').trim(),
    homeworkId: Number(data.homework_common_id) || 0,
    identifier: String(data.game && data.game.identifier || '').trim()
  };
}

module.exports = { virtualTaskInfo };
