'use strict';

/** One filesystem component; keep existing naming conventions for ordinary names. */
function safeFileName(value, { replacement = ' ', collapseWhitespace = true, fallback = 'untitled' } = {}) {
  let name = String(value ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, replacement);
  if (collapseWhitespace) name = name.replace(/\s+/g, ' ');
  // Windows discards trailing dots/spaces; dot-only names must never traverse directories.
  name = name.trim().replace(/[. ]+$/, '');
  if (!name) return fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name;
}

module.exports = { safeFileName };
