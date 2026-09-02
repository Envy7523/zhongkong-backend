/**
 * 记账本备份/更新导入（覆盖替换模式）
 * 文件结构（取第一个含 门店名称/大类/小类/金额+日期 的子表，其余子表忽略）：
 *   日期 | 序号 | 门店名称 | 大类 | 小类 | 金额   （序号列自动忽略；时间可为 Excel 序列或文本）
 * 处理：
 *   1) 先删除本地 bookkeeping_entries 中 date >= replace_from 的记录（替换窗口）
 *   2) 逐行解析并写入（门店按名称精确匹配本地 stores；大类/小类按名称复用或自动创建）
 *   3) 早于 replace_from 的行拒绝导入（防止污染保留窗口造成重复）
 */
const XLSX = require('xlsx');

function cleanKey(value) {
  return String(value == null ? '' : value).trim().replace(/[\s_（）()]/g, '').toLowerCase();
}

function getValue(row, aliases) {
  const keys = Object.keys(row);
  const wanted = aliases.map(cleanKey);
  const key = keys.find(k => wanted.includes(cleanKey(k)));
  return key == null ? undefined : row[key];
}

function normalizeStoreName(value) {
  // 去掉（订货）前缀与空格，全角括号转半角，便于与本地档案匹配
  return String(value || '')
    .replace(/（订货）|\(订货\)/g, '')
    .replace(/\s+/g, '')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .trim();
}

function number(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(/[¥￥,，\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function dateText(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'number') {
    const compact = String(Math.trunc(value));
    if (/^\d{8}$/.test(compact)) return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
    const d = XLSX.SSF.parse_date_code(value);
    if (d) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
    return '';
  }
  const text = String(value).trim().replace(/[./]/g, '-');
  const matched = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  return matched ? `${matched[1]}-${matched[2].padStart(2, '0')}-${matched[3].padStart(2, '0')}` : '';
}

function workbookRows(base64) {
  const payload = String(base64 || '').replace(/^data:.*?;base64,/, '');
  if (!payload) throw new Error('文件内容为空');
  const workbook = XLSX.read(Buffer.from(payload, 'base64'), { type: 'buffer', cellDates: false });
  // 候选子表：表头同时含 门店名称/日期/大类/小类/金额（列序不敏感）
  const candidates = workbook.SheetNames.map(name => {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { defval: '', raw: true });
    const head = rows[0];
    const ok = head
      && getValue(head, ['门店名称', '门店名', '门店']) !== undefined
      && getValue(head, ['大类', '分类', '类别']) !== undefined
      && getValue(head, ['小类', '子类']) !== undefined
      && getValue(head, ['金额']) !== undefined
      && getValue(head, ['日期', '时间', '营业日期', '业务日期', '账单日期']) !== undefined;
    if (!ok) return null;
    // 打分：该子表中 门店/日期/大类/金额 齐全的数据行数（避开合并单元格式碎片表）
    let score = 0;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (String(getValue(r, ['门店名称', '门店名', '门店']) || '').trim()
        && dateText(getValue(r, ['日期', '时间', '营业日期', '业务日期', '账单日期']))
        && String(getValue(r, ['大类', '分类', '类别']) || '').trim()
        && number(getValue(r, ['金额'])) !== null) score++;
    }
    return { name, rows, score };
  }).filter(Boolean).sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || !best.score) throw new Error('未找到记账流水子表（需包含 日期、门店名称、大类、小类、金额 列头，且存在有效数据行）');
  return { sheet_name: best.name, rows: best.rows };
}

function importLedgerBackup(db, params, user) {
  const replaceFrom = String(params.replace_from || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(replaceFrom)) throw new Error('请提供 replace_from（要替换的起始日期，格式 YYYY-MM-DD）');
  const { sheet_name, rows } = workbookRows(params.data);
  const aliases = {
    storeName: ['门店名称', '门店名', '门店'],
    date: ['日期', '时间', '营业日期', '业务日期', '账单日期'],
    category: ['大类', '分类', '类别'],
    subcategory: ['小类', '子类'],
    amount: ['金额'],
  };
  // 门店档案
  const stores = db.queryAll('SELECT id, store_name FROM stores');
  const storeMap = new Map(stores.map(store => [normalizeStoreName(store.store_name), store]));
  // 分类/小类
  const categories = db.queryAll('SELECT * FROM bookkeeping_categories');
  const categoryMap = new Map(categories.map(c => [normalizeStoreName(c.name), c]));
  const subcategoryRows = db.queryAll('SELECT * FROM bookkeeping_subcategories');
  const subcategoryMap = new Map(subcategoryRows.map(s => [`${s.category_id}:${normalizeStoreName(s.name)}`, s]));

  const parsed = [];
  const errors = [];
  const matchedStores = new Set();
  rows.forEach((row, index) => {
    const storeName = String(getValue(row, aliases.storeName) || '').trim();
    const date = dateText(getValue(row, aliases.date));
    const categoryName = String(getValue(row, aliases.category) || '').trim();
    const subcategoryName = String(getValue(row, aliases.subcategory) || '').trim();
    const amount = number(getValue(row, aliases.amount));
    if (!storeName && !date && !categoryName && amount === null) return; // 空行/分隔行
    const reason = !storeName ? '缺少门店名称' : !date ? '日期缺失/格式不正确'
      : !categoryName ? '缺少大类' : amount === null ? '金额格式不正确' : '';
    if (reason) { errors.push(`第 ${index + 2} 行：${reason}（已跳过）`); return; }
    if (date < replaceFrom) {
      errors.push(`第 ${index + 2} 行：日期 ${date} 早于替换起点 ${replaceFrom}，为避免重复未导入`);
      return;
    }
    const store = storeMap.get(normalizeStoreName(storeName));
    if (!store) {
      errors.push(`第 ${index + 2} 行：未找到门店「${storeName}」（已跳过）`);
      return;
    }
    matchedStores.add(store.id);
    parsed.push({ row, line: index + 2, store, date, categoryName, subcategoryName, amount });
  });
  if (!parsed.length && !errors.length) throw new Error('表格中没有可导入的数据行');

  let createdCategories = 0;
  let createdSubcategories = 0;
  let inserted = 0;
  const userId = user?.id || null;
  const userName = user?.display_name || user?.username || '';
  const remark = `记账本更新导入（${sheet_name}，替换自 ${replaceFrom}）`;

  db.run('BEGIN');
  try {
    // 1) 删除替换窗口
    const deleted = db.run('DELETE FROM bookkeeping_entries WHERE date>=?', [replaceFrom]);
    // 2) 逐行写入
    parsed.forEach(item => {
      const categoryKey = normalizeStoreName(item.categoryName);
      let category = categoryMap.get(categoryKey);
      if (!category) {
        const id = db.insert('INSERT INTO bookkeeping_categories (name,sort_order) VALUES (?,?)', [item.categoryName, 999]);
        category = { id, name: item.categoryName };
        categoryMap.set(categoryKey, category);
        createdCategories++;
      }
      const subKey = `${category.id}:${normalizeStoreName(item.subcategoryName)}`;
      let subcategory = subcategoryMap.get(subKey);
      if (!subcategory) {
        const id = db.insert('INSERT INTO bookkeeping_subcategories (category_id,name,sort_order) VALUES (?,?,?)', [category.id, item.subcategoryName, 999]);
        subcategory = { id, name: item.subcategoryName };
        subcategoryMap.set(subKey, subcategory);
        createdSubcategories++;
      }
      db.insert(
        'INSERT INTO bookkeeping_entries (store_id,store_name,user_id,user_name,date,category_id,category_name,subcategory_id,subcategory_name,amount,images,remark) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [item.store.id, item.store.store_name, userId, userName, item.date,
          category.id, category.name, subcategory.id, subcategory.name, item.amount, '[]', remark]
      );
      inserted++;
    });
    db.run('COMMIT');
    const dates = parsed.map(p => p.date).sort();
    db.save();
    return {
      ok: true, sheet_name, replace_from: replaceFrom,
      deleted, inserted, unmatched: errors.filter(e => e.includes('未找到门店')).length,
      matched_stores: matchedStores.size,
      created_categories: createdCategories, created_subcategories: createdSubcategories,
      date_from: dates[0] || null, date_to: dates.at(-1) || null,
      skipped: errors.length, errors: errors.slice(0, 20),
    };
  } catch (error) {
    try { db.run('ROLLBACK'); } catch {}
    throw error;
  }
}

module.exports = { importLedgerBackup };
