// Model output is untrusted text. Escape first; allow only simple emphasis and headings.
export function renderAnalysisText(value) {
  const escaped = String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const lines = escaped.split(/\r?\n/), out = [];
  const inline = line => line.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(s => s.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.includes('|') && lines[i + 1]?.includes('|') && cells(lines[i + 1]).every(s => /^:?-{3,}:?$/.test(s))) {
      const header = cells(line), rows = [];i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(cells(lines[i]));i++; }
      i--;
      out.push('<div class="analysis-text-table"><table><thead><tr>' + header.map(s => `<th>${inline(s)}</th>`).join('') + '</tr></thead><tbody>' + rows.map(row => '<tr>' + header.map((_, j) => `<td>${inline(row[j] || '')}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>');
    } else if (/^(?:[-*]\s|\d+[.)]\s)/.test(line)) {
      const ordered = /^\d+[.)]\s/.test(line), items = [];const pattern = ordered ? /^\d+[.)]\s/ : /^[-*]\s/;
      while (i < lines.length && pattern.test(lines[i].trim())) { items.push(inline(lines[i].trim().replace(pattern, '')));i++; }
      i--;const tag = ordered ? 'ol' : 'ul';out.push(`<${tag}>` + items.map(s => `<li>${s}</li>`).join('') + `</${tag}>`);
    } else out.push(/^#{1,4}\s/.test(line) ? `<h5>${inline(line.replace(/^#{1,4}\s/, ''))}</h5>` : `<p>${inline(line)}</p>`);
  }
  return out.join('');
}
