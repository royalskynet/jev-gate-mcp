export function stripAnsi(text) {
  return text
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '');
}

export function collapseProgress(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const i = line.lastIndexOf('\r');
      return i === -1 ? line : line.slice(i + 1);
    })
    .join('\n');
}

export function collapseRepeats(text, { min = 3 } = {}) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const count = j - i;
    out.push(lines[i]);
    if (count >= min) {
      out.push(`[l0: repeated ${count - 1} more times]`);
    } else {
      for (let k = i + 1; k < j; k++) out.push(lines[k]);
    }
    i = j;
  }
  return out.join('\n');
}

export function l0Prune(text, opts) {
  if (typeof text !== 'string') return { text, savedChars: 0 };
  const pruned = collapseRepeats(collapseProgress(stripAnsi(text)), opts);
  return { text: pruned, savedChars: text.length - pruned.length };
}
