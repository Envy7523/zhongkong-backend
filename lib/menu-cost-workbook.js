'use strict';
// Read the supplied cost-card layout. Cached Excel totals are reconciliation
// targets, never evaluated as JavaScript or used as instructions.
const XLSX = require('xlsx');
const crypto = require('crypto');
const address = (col, row) => XLSX.utils.encode_cell({ c: col, r: row });
const at = (sheet, col, row) => sheet[address(col, row)]?.v;
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

function parseWorkbook(buffer, filename) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellFormula: true });
  const overview = workbook.Sheets['成本总览'];
  if (!overview || !workbook.Sheets['9月成本校准']) throw new Error('请使用包含“成本总览”和“9月成本校准”的成本卡2.0文件');
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const materials = [], preparations = [], recipes = [], yields = [];
  const strawCost = number(workbook.Sheets['饮料']?.I9?.v);
  const packaging = strawCost === null ? [] : [{ id: 'straw', name: '吸管', unit: '根', unit_cost: strawCost, source: '饮料!I9', note: '原卡已计入饮料成本；作为每份常用耗材，仅计一次' }];
  const calibration = workbook.Sheets['9月成本校准'];
  for (let row = 10; row < 36; row++) {
    const name = at(calibration, 0, row), price = number(at(calibration, 4, row));
    if (name && price !== null) materials.push({ name, unit: at(calibration, 1, row), quantity: at(calibration, 2, row), amount: at(calibration, 3, row), unit_cost: price, note: at(calibration, 8, row), source: `9月成本校准!E${row + 1}` });
  }
  const prep = workbook.Sheets['配料'];
  const yieldSheet = workbook.Sheets['出成率校准'];
  if (yieldSheet) {
    for (let row = 5; row <= 7; row++) yields.push({ name: at(yieldSheet, 0, row), raw_quantity: number(at(yieldSheet, 1, row)), cooked_quantity: number(at(yieldSheet, 2, row)), sale_quantity: number(at(yieldSheet, 10, row)), unit: '克', yield_rate: number(at(yieldSheet, 11, row)), note: at(yieldSheet, 0, row + 18) || '', source: `出成率校准!A${row + 1}` });
    for (let row = 30; row <= 31; row++) yields.push({ name: at(yieldSheet, 0, row), raw_quantity: number(at(yieldSheet, 1, row)), cooked_quantity: number(at(yieldSheet, 2, row)), sale_quantity: number(at(yieldSheet, 2, row)), unit: '斤', yield_rate: number(at(yieldSheet, 3, row)), note: at(yieldSheet, 10, row) || '', source: `出成率校准!A${row + 1}` });
  }
  if (prep) {
    let current;
    for (let row = 2; row < 67; row++) {
      if (at(prep, 1, row)) {
        current = { name: String(at(prep, 1, row)), yield: at(prep, 7, row) || '', total: number(at(prep, 8, row)), source: `配料!B${row + 1}`, process: at(prep, 9, row) || '', lines: [] };
        preparations.push(current);
      }
      if (current && at(prep, 2, row)) current.lines.push({ name: at(prep, 2, row), quantity: at(prep, 3, row), unit: at(prep, 4, row), purchase_price: at(prep, 5, row) ?? '', subtotal: number(at(prep, 6, row)), source: `配料!G${row + 1}` });
    }
  }
  function quantity(raw, unit) {
    const first = String(raw ?? '').split('/')[0].trim();
    const q = Number(first);
    return { quantity: Number.isFinite(q) && q > 0 ? q : 1, unit: first && Number.isFinite(q) && q > 0 ? String(unit || '份').split('/')[0] : '份', source_quantity: `${raw ?? '未提供'}${unit || ''}` };
  }
  for (let row = 8; row <= XLSX.utils.decode_range(overview['!ref']).e.r; row++) {
    const origin = at(overview, 8, row);
    if (typeof origin !== 'string' || !origin.includes('!')) continue;
    const split = origin.lastIndexOf('!'), sheetName = origin.slice(0, split), anchor = origin.slice(split + 1);
    const sheet = workbook.Sheets[sheetName];
    if (!sheet || !sheet[anchor]) throw new Error(`来源不存在：${origin}`);
    const pos = XLSX.utils.decode_cell(anchor), isCut = sheetName === '惹味斩料';
    const totalCell = address(isCut ? 6 : pos.c + 6, pos.r);
    const total = number(sheet[totalCell]?.v);
    if (total === null) throw new Error(`${origin} 缺少可核对的成本结果，请先在Excel中计算并保存`);
    const lines = [], packs = [], warnings = [];
    function addLine(cell, grouped) {
      const p = XLSX.utils.decode_cell(cell), value = number(sheet[cell]?.v);
      if (value === null) return;
      const name = grouped?.name || at(sheet, p.c - 3, p.r);
      if (!name || name === '合计') throw new Error(`${sheetName}!${cell} 无法识别构成名称`);
      const q = quantity(at(sheet, p.c - 2, p.r), at(sheet, p.c - 1, p.r));
      if (q.source_quantity.startsWith('未提供')) warnings.push(`${name}缺少用量，暂按每份固定成本保留`);
      const entry = { ingredient_name: String(name), ...q, unit_cost: value / q.quantity, source_subtotal: value, source: `${sheetName}!${cell}`, formula: sheet[cell]?.f || '', basis: grouped ? '原卡合并分摊' : sheet[cell]?.f ? '原卡公式折算' : '原卡份成本折算', note: grouped?.note || '' };
      if (entry.ingredient_name === '吸管') {
        if (!packaging.length || Math.abs(value - q.quantity * strawCost) > 0.00001) throw new Error(`${entry.source} 吸管成本缺少一致的单位价格依据`);
        packs.push({ material_id: 'straw', quantity: q.quantity, scope: 'dish', usage: 'always' });
      }
      else lines.push(entry);
    }
    function expand(cell, seen = new Set()) {
      if (seen.has(cell)) throw new Error(`${sheetName}!${cell} 成本公式循环引用`);
      const p = XLSX.utils.decode_cell(cell), label = at(sheet, p.c - 3, p.r), formula = sheet[cell]?.f || '';
      if (label !== '合计') return addLine(cell);
      const range = formula.match(/^SUM\(\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)\)$/i);
      let refs;
      if (range) {
        const start = XLSX.utils.decode_cell(range[1] + range[2]), end = XLSX.utils.decode_cell(range[3] + range[4]);
        refs = [];
        for (let r = start.r; r <= end.r; r++) refs.push(address(start.c, r));
      } else if (/^[A-Z0-9+$]+$/i.test(formula)) refs = formula.match(/[A-Z]+\d+/g);
      else throw new Error(`${sheetName}!${cell} 合计公式暂不支持，不能静默导入`);
      const named = (refs || []).filter(ref => { const p = XLSX.utils.decode_cell(ref); return at(sheet, p.c - 3, p.r); });
      if (!named.length) throw new Error(`${sheetName}!${cell} 缺少构成`);
      const unallocated = named.some(ref => number(sheet[ref]?.v) === null);
      if (unallocated) {
        const description = named.map(ref => { const p = XLSX.utils.decode_cell(ref); return `${at(sheet, p.c - 3, p.r)}${at(sheet, p.c - 2, p.r) ?? ''}${at(sheet, p.c - 1, p.r) || ''}`; }).join('＋');
        addLine(cell, { name: named.map(ref => { const p = XLSX.utils.decode_cell(ref); return at(sheet, p.c - 3, p.r); }).join('＋'), note: `${description}；成本按原卡合并分摊，未把缺失分项成本当作零` });
      } else for (const ref of named) expand(ref, new Set([...seen, cell]));
    }
    if (isCut) {
      const q = quantity(at(sheet, 3, pos.r), at(sheet, 4, pos.r));
      lines.push({ ingredient_name: String(at(sheet, 2, pos.r)), ...q, unit_cost: total / q.quantity, source_subtotal: total, source: `${sheetName}!${totalCell}`, formula: sheet[totalCell]?.f || '', basis: '出成率及熟品成本分摊', note: '' });
    } else {
      const formula = sheet[totalCell]?.f || '';
      if (!/^[A-Z0-9+$]+$/i.test(formula)) throw new Error(`${sheetName}!${totalCell} 总成本公式暂不支持`);
      for (const ref of formula.match(/[A-Z]+\d+/g) || []) expand(ref);
    }
    const sum = lines.reduce((s, l) => s + l.quantity * l.unit_cost, 0) + packs.reduce((s, p) => s + p.quantity * packaging[0].unit_cost, 0);
    if (Math.abs(sum - total) > 0.00001) throw new Error(`${origin} 分项合计${sum}与原表${total}不一致`);
    recipes.push({ id: crypto.createHash('sha256').update(`${hash}:${origin}`).digest('hex').slice(0, 24), name: String(sheet[anchor].v), category: sheetName, variant: isCut ? `${at(sheet, 3, pos.r)}${at(sheet, 4, pos.r)}` : '', sale_price: Number(at(overview, 2, row)), source_total: total, source: origin, source_cost_cell: `${sheetName}!${totalCell}`, lines, packaging: packs, packaging_status: 'pending', warnings });
  }
  const duplicates = new Map();
  for (const r of recipes) duplicates.set(r.name, (duplicates.get(r.name) || 0) + 1);
  for (const r of recipes) if (duplicates.get(r.name) > 1) { r.variant ||= r.lines.slice(0, 3).map(l => l.ingredient_name).join('＋'); r.warnings.push('原表存在同名记录，请按配方和规格分别关联'); }
  if (!recipes.length) throw new Error('未读取到成本卡');
  return { filename: String(filename || '成本卡.xlsx').split(/[\\/]/).pop(), hash, period: '欧景2026年9月采购校准', sheets: workbook.SheetNames.length, recipes, materials, preparations, packaging, yields };
}
module.exports = { parseWorkbook };
