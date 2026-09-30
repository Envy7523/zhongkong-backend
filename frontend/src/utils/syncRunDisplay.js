// 后端阶段与审计字段维持稳定英文代码；业务页面只展示中文。
export const STAGE_LABELS = Object.freeze({
  PRECHECK: '开始前检查',
  QUERY_DONE: '报表查询完成',
  EXPORT_SUBMITTED: '已提交导出申请',
  WAITING_EXPORT: '等待报表生成',
  DOWNLOADED: '报表下载完成',
  FILE_VALIDATED: '文件校验通过',
  IMPORT_STARTED: '开始导入中控',
  IMPORT_SUCCEEDED: '导入中控成功',
  IMPORT_FAILED: '导入中控失败',
  PUSH_SUCCEEDED: '日报发送成功',
  PUSH_FAILED: '日报发送失败',
  FAILED: '执行失败',
  WAITING_HUMAN: '等待人工处理',
})

const FIELD_LABELS = Object.freeze({
  phase: '发生阶段', failure_reason: '原因', note: '说明', mode: '执行方式',
  raw_store_count: '原始门店数', matched_store_count: '匹配门店数',
  raw_imported: '原始门店数', matched_stores: '匹配门店数', imported: '导入数据行数',
  import_batch_id: '导入批次', validation: '校验结果', evidence: '证据摘要',
  errors_empty: '无校验错误', amount_delta: '金额差额',
  business_date_matched: '业务日期一致', sha256_prefix: 'SHA-256 前缀',
  original_filename: '原始文件名', file_size: '文件大小',
  screenshot_count: '截图数量', ok: '结果正常', store_rows: '门店数据行数',
  started_at: '开始时间', finished_at: '结束时间', duration_ms: '耗时（毫秒）',
  ready_to_push: '机器人推送标志', is_backfill: '历史补录',
  reconstructed: '由历史资料重建', not_a_realtime_success: '非实时成功',
})

const VALUE_LABELS = Object.freeze({
  gates_passed: '导入前校验已通过',
  verify_failed: '校验失败',
  amount_missing: '金额数据缺失',
  verified_after_import: '导入后核验完成',
  verified_existing_batch_no_reimport_no_push: '已核验原有导入批次；未重复导入或发送',
  verified_existing_workflow_and_batch: '已核验原有机器人任务与导入批次；仅补记审计',
  verified_scheduled_workflow_and_batch: '已核验自动任务与导入批次',
  historical_backfill: '历史补录',
  reconcile_batch180: '批次 180 对账修复',
  construction_zero_exception: '筹建门店全零例外校验',
  business_columns_missing: '业务数据列缺失',
})

export const stageLabel = value => STAGE_LABELS[String(value || '')] || '其他阶段'

export function reasonLabel(value) {
  const raw = String(value || '').trim()
  if (!raw) return '-'
  if (VALUE_LABELS[raw]) return VALUE_LABELS[raw]
  let translated = raw
  for (const [code, label] of Object.entries(VALUE_LABELS)) translated = translated.replaceAll(code, label)
  // 未登记的纯机器代码不直接暴露在业务页面，原码仍保留在后端审计。
  return /^[A-Za-z0-9_.:-]+$/.test(translated) ? '未识别的技术异常' : translated
}

function valueLabel(value, key) {
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (value === null || value === undefined || value === '') return '-'
  if (key === 'phase') return stageLabel(value)
  if (key === 'note' || key === 'failure_reason' || key === 'mode') return reasonLabel(value)
  if (Array.isArray(value)) return value.map(item => valueLabel(item, key)).join('、') || '-'
  return String(value)
}

export function detailLines(detail) {
  if (!detail || typeof detail !== 'object') return []
  const lines = []
  const visit = (object, depth) => {
    for (const [key, value] of Object.entries(object)) {
      const label = FIELD_LABELS[key] || '其他记录'
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        lines.push({ label, value: '', depth })
        visit(value, depth + 1)
      } else {
        lines.push({ label, value: valueLabel(value, key), depth })
      }
    }
  }
  visit(detail, 0)
  return lines
}
