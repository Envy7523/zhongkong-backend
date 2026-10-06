'use strict';
/**
 * 阶段2：结果网格只读诊断（不导航、不点击、不导出、不下载）
 *   node src/phase2/diag-grid.js
 * 目的：判定「查询结果 20 行 vs 期望 22 行」的原因（虚拟滚动 / 合计行位置 / 总条数文案 / 筛选值）。
 * 全程只读：仅调用只读宿主命令（url/health/gridDetail/tableSummary/filterPanel/blockers/region）。
 */
const fs = require('fs');
const path = require('path');
const P = require('../paths');
const client = require('./client');

(async () => {
  const out = { at: new Date().toISOString(), kind: 'diag-grid', read_only: true };
  const guard = async (name, fn) => {
    try {
      out[name] = await fn();
    } catch (e) {
      out[name] = { error: e.message };
    }
  };
  await guard('health', () => client.health());
  await guard('url', () => client.url());
  await guard('gridDetail', () => client.gridDetail({ maxRows: 40 }));
  await guard('tableSummary', async () => {
    const s = await client.tableSummary({});
    return {
      tableCount: s.tableCount,
      tables: (s.tables || []).map((t) => ({ rowCount: t.rowCount, dataRowCount: t.dataRowCount, hasTotalRow: t.hasTotalRow, header: t.headerRow, frameIndex: t.frameIndex })),
      grids: (s.grids || []).map((g) => ({ dataRowCount: g.dataRowCount, hasTotalRow: g.hasTotalRow, class: g.container_class, rect: g.rect, frameIndex: g.frameIndex })),
    };
  });
  await guard('filterPanel', () => client.filterPanel({}));
  await guard('blockers', () => client.blockers({}));
  await guard('dateInputs', () => client.dateInputs({}));

  const dir = path.join(P.state, 'selectors-dump');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `diag-grid-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));

  // 控制台摘要（便于人工快速判读）
  const gd = out.gridDetail && out.gridDetail.best;
  console.log('URL:', (out.url && out.url.url) || (out.health && out.health.url));
  console.log('active_task:', out.health && out.health.active_task_id);
  console.log('human_busy:', JSON.stringify(out.health && out.health.human_busy));
  if (gd) {
    console.log('grid frames:', out.gridDetail.frameCount);
    for (const c of gd.grid_candidates || []) {
      console.log(`--- candidate class="${c.class_name}" rect=${JSON.stringify(c.rect)} rendered=${c.rendered_row_count} scrollable=${c.scrollable} totalIdx=${c.total_row_index} count_text=${c.count_text}`);
      if (c.scroll) console.log('    scroll:', JSON.stringify(c.scroll));
      console.log('    rowIndex range:', c.min_row_index, '..', c.max_row_index);
      (c.all_rows || []).forEach((t, i) => console.log(`    [${i}] ${t.slice(0, 120)}`));
    }
    console.log('page_count_text:', gd.page_count_text, 'page_text_has_heji:', gd.page_text_has_heji);
  } else {
    console.log('no grid candidate found');
  }
  console.log('filterPanel keys:', out.filterPanel && Object.keys(out.filterPanel));
  console.log('blockers:', JSON.stringify(out.blockers && (out.blockers.merged || out.blockers)));
  console.log('dump:', file);
})().catch((e) => {
  console.error('DIAG_FAILED', e.message);
  process.exit(1);
});
