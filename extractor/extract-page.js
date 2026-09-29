/**
 * Run this function in the js-reverse MCP page context.
 * It extracts supported question content without answering or submitting.
 */
function extractEducoderTask() {
  const text = (node) => (node?.innerText || node?.textContent || '').trim();
  const heading = (level, value) =>
    [...document.querySelectorAll(`h${level}`)].find((node) => text(node) === value);
  const sectionText = (name) => {
    const start = heading(4, name);
    if (!start) return '';
    const parts = [];
    for (let node = start.nextElementSibling; node; node = node.nextElementSibling) {
      if (/^H[1-4]$/.test(node.tagName)) break;
      parts.push(text(node));
    }
    return parts.filter(Boolean).join('\n\n');
  };

  const pageText = text(document.body);
  const taskTitle = text(document.querySelector('h3')) || document.title;
  const match = taskTitle.match(/^第\s*(\d+)\s*关\s*[：:]\s*(.+)$/);
  const level = match ? `第${match[1]}关_${match[2].trim()}` : taskTitle;
  const codeNode = document.querySelector('code');
  const code = text(codeNode);
  const options = [...document.querySelectorAll('input[type="radio"], input[type="checkbox"]')]
    .map((input) => input.closest('label') || input.parentElement)
    .map(text)
    .filter(Boolean);

  return {
    source: location.href,
    pageTitle: document.title,
    experiment: text(document.querySelector('h2')) || document.title,
    level,
    supportedType: code ? 'code' : options.length ? 'choice' : 'unsupported',
    taskDescription: sectionText('任务描述'),
    programmingRequirements: sectionText('编程要求'),
    testDescription: sectionText('测试说明'),
    choices: options,
    starterCode: code,
    capturedText: pageText
  };
}
