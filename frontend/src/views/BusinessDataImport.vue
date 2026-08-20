<template>
  <div class="business-import-page" :class="`mode-${mode}`">
    <section class="import-hero">
      <div>
        <span class="eyebrow">DATA INTAKE</span>
        <h2>{{ config.title }}</h2>
        <p>{{ config.description }}</p>
      </div>
      <el-button plain @click="downloadTemplate"><el-icon><Download /></el-icon>下载标准模板</el-button>
    </section>

    <section class="import-layout">
      <main class="upload-panel">
        <header>
          <span class="step-no">01</span>
          <div><h3>选择并上传营业文件</h3><p>支持 Excel（.xlsx / .xls）和 CSV，同门店、同日期、同渠道再次导入会覆盖旧记录。</p></div>
        </header>

        <el-form label-position="top">
          <el-form-item v-if="mode !== 'pos'" label="本次导入平台" required>
            <el-select v-model="platform" placeholder="请选择平台渠道" style="width:100%">
              <el-option v-for="item in config.platforms" :key="item" :label="item" :value="item" />
            </el-select>
          </el-form-item>
          <el-form-item label="营业数据文件" required>
            <label class="file-drop" :class="{ selected: file }">
              <input type="file" accept=".xlsx,.xls,.csv" @change="selectFile" />
              <span class="file-icon"><el-icon><DocumentAdd /></el-icon></span>
              <b>{{ file ? file.name : '点击选择文件' }}</b>
              <small>{{ file ? fileSize(file.size) : '请先使用本页标准模板整理数据' }}</small>
            </label>
          </el-form-item>
        </el-form>

        <div v-if="result" :class="['import-result', result.type]">
          <el-icon><CircleCheck v-if="result.type === 'success'" /><Warning v-else /></el-icon>
          <div>
            <b>{{ result.title }}</b>
            <p>{{ result.message }}</p>
            <ul v-if="result.errors?.length" class="import-errors" aria-label="未导入行明细">
              <li v-for="error in result.errors" :key="error">{{ error }}</li>
            </ul>
          </div>
        </div>

        <footer>
          <span>系统会自动匹配门店、校验日期并计算平台实际结算。</span>
          <el-button type="primary" size="large" :loading="importing" :disabled="!canSubmit" @click="submitImport">开始导入</el-button>
        </footer>
      </main>

      <aside class="requirements-panel">
        <header><span class="step-no">02</span><div><h3>需要准备的数据</h3><p>带“必填”的字段缺失时，该行不会进入分析。</p></div></header>
        <div class="field-groups">
          <section v-for="group in config.groups" :key="group.title">
            <h4>{{ group.title }}</h4>
            <div class="field-list">
              <div v-for="field in group.fields" :key="field.name">
                <span>{{ field.name }}<em v-if="field.required">必填</em></span>
                <small>{{ field.note }}</small>
              </div>
            </div>
          </section>
        </div>
        <div class="formula-card">
          <span>进入分析的计算口径</span>
          <b>{{ config.formula }}</b>
        </div>
      </aside>
    </section>

    <section class="workflow-panel">
      <div v-for="(item, index) in config.workflow" :key="item.title">
        <span>{{ String(index + 1).padStart(2, '0') }}</span>
        <div><b>{{ item.title }}</b><small>{{ item.note }}</small></div>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { CircleCheck, DocumentAdd, Download, Warning } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { getBusinessTemplate, importBusinessData } from '@/api'

const route = useRoute()
const file = ref(null)
const platform = ref('')
const importing = ref(false)
const result = ref(null)

const mode = computed(() => ['group-buy', 'delivery'].includes(route.meta.importMode) ? route.meta.importMode : 'pos')
const configs = {
  pos: {
    title: '收银系统数据导入',
    description: '导入每家门店的线下堂食与线上渠道收银记录，建立经营分析的门店总账。',
    platforms: [],
    groups: [
      { title: '基础识别', fields: [{ name: '日期', required: true, note: '营业日期，格式 YYYY-MM-DD' }, { name: '门店ID / 门店名称', required: true, note: '至少填写一项，必须与门店档案匹配' }, { name: '订单数', note: '门店当日总订单数' }] },
      { title: '线下堂食', fields: [{ name: '扫码支付', note: '微信、支付宝等线下扫码实收' }, { name: '现金', note: '现金实收金额' }, { name: '小程序储值消费', note: '会员储值账户核销金额' }, { name: '其他线下', note: '其他堂食收款方式' }] },
      { title: '线上收银记录', fields: [{ name: '美团团购 / 抖音团购', note: '收银机核销记录金额，用于双向验证' }, { name: '美团外卖 / 淘宝闪购 / 京东外卖', note: '收银系统记录金额，不作为最终平台实收' }] },
    ],
    formula: '门店收银总账 = 线下堂食 + 收银系统记录的全部线上渠道',
    workflow: [{ title: '导出收银日报', note: '按门店、按营业日导出' }, { title: '整理标准字段', note: '复制到系统模板中' }, { title: '导入形成总账', note: '线上金额进入待验证状态' }],
  },
  'group-buy': {
    title: '团购平台数据导入',
    description: '导入美团团购或抖音团购结算明细，修正收银系统的团购记录并分析商品销量。',
    platforms: ['美团团购', '抖音团购', '免费试'],
    groups: [
      { title: '基础识别', fields: [{ name: '日期', required: true, note: '平台结算对应的营业日期' }, { name: '门店ID / 门店名称', required: true, note: '至少填写一项' }, { name: '渠道', required: true, note: '美团团购、抖音团购或免费试' }] },
      { title: '结算数据', fields: [{ name: '订单金额', note: '消费者支付或核销总额' }, { name: '实收', note: '平台实际结算金额；不填时由费用自动计算' }, { name: '手续费 / 保险费 / 推广费', note: '平台扣除的第三方费用' }, { name: '退款金额', note: '退款及售后扣减' }, { name: '订单数', note: '有效核销订单数' }] },
      { title: '商品销量（可选）', fields: [{ name: '商品名称', note: '团购套餐或商品名称' }, { name: '销量', note: '核销或销售数量' }, { name: '商品销售额', note: '对应商品销售金额' }] },
    ],
    formula: '团购实收 = 平台实收；未提供实收时 = 订单金额 - 手续费 - 保险费 - 推广费 - 退款',
    workflow: [{ title: '导出平台账单', note: '按门店、按营业日导出' }, { title: '补充费用与销量', note: '保留结算和商品明细' }, { title: '与收银双向核对', note: '自动计算团购差额和占比' }],
  },
  delivery: {
    title: '外卖平台数据导入',
    description: '导入美团外卖、淘宝闪购或京东外卖账单，核算平台实收、费用与商品销量。',
    platforms: ['美团外卖', '淘宝闪购', '京东外卖'],
    groups: [
      { title: '基础识别', fields: [{ name: '日期', required: true, note: '订单归属的营业日期' }, { name: '门店ID / 门店名称', required: true, note: '至少填写一项' }, { name: '渠道', required: true, note: '美团外卖、淘宝闪购或京东外卖' }] },
      { title: '结算数据', fields: [{ name: '订单金额', note: '顾客支付及平台补贴前后按导出口径填写' }, { name: '实收', note: '平台实际结算金额' }, { name: '手续费 / 保险费 / 推广费', note: '佣金、履约、流量推广等费用' }, { name: '退款金额', note: '退款和售后金额' }, { name: '订单数', note: '有效完成订单数' }] },
      { title: '商品销量（可选）', fields: [{ name: '商品名称', note: '外卖商品名称' }, { name: '销量', note: '商品销售数量' }, { name: '商品销售额', note: '对应商品销售金额' }] },
    ],
    formula: '外卖实收 = 平台实收；未提供实收时 = 订单金额 - 手续费 - 保险费 - 推广费 - 退款',
    workflow: [{ title: '导出平台账单', note: '分别导出各平台数据' }, { title: '按标准模板整理', note: '保留费用和商品明细' }, { title: '完成外卖核对', note: '自动计算实收与门店占比' }],
  },
}
const config = computed(() => configs[mode.value])
const canSubmit = computed(() => file.value && (mode.value === 'pos' || platform.value))

watch(mode, () => { file.value = null; platform.value = ''; result.value = null })
function selectFile(event) { file.value = event.target.files?.[0] || null; result.value = null }
function fileSize(bytes) { return bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB` }
function readFile(raw) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(raw) }) }

async function submitImport() {
  if (!canSubmit.value) return
  importing.value = true
  result.value = null
  try {
    const response = await importBusinessData({ source_type: mode.value === 'pos' ? 'pos' : 'platform', platform: platform.value, file_name: file.value.name, data: await readFile(file.value) })
    const imported = Number(response.imported || 0)
    const skipped = Number(response.skipped || 0)
    result.value = {
      type: imported > 0 ? 'success' : 'error',
      title: imported > 0 ? '导入完成' : '未导入有效数据',
      message: imported > 0
        ? `写入 ${imported} 条营收记录${response.product_rows ? `、${response.product_rows} 条商品销量` : ''}${skipped ? `；跳过 ${skipped} 行异常数据` : ''}。`
        : `文件中的 ${skipped || '所有'} 行均未通过校验，请按下方原因修正后重新上传。`,
      errors: response.errors || [],
    }
    if (imported > 0) file.value = null
  } catch (error) {
    result.value = { type: 'error', title: '导入失败', message: error.message }
  } finally { importing.value = false }
}

async function downloadTemplate() {
  try {
    const response = await getBusinessTemplate(mode.value === 'pos' ? 'pos' : 'platform')
    const bytes = Uint8Array.from(atob(response.data), char => char.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
    const link = document.createElement('a'); link.href = url; link.download = mode.value === 'pos' ? response.file_name : `${config.value.title}模板.xlsx`; link.click(); URL.revokeObjectURL(url)
  } catch (error) { ElMessage.error(error.message) }
}
</script>

<style scoped>
.business-import-page{--accent:#3b82f6;--accent-soft:#eff6ff;--ink:#172033;--muted:#7a8699;--line:#e5e9f0;color:var(--ink)}.business-import-page.mode-group-buy{--accent:#8b5cf6;--accent-soft:#f5f1ff}.business-import-page.mode-delivery{--accent:#0d9488;--accent-soft:#ecfdf8}
.import-hero{display:flex;align-items:flex-end;justify-content:space-between;gap:22px;margin-bottom:16px;padding:27px 30px;border-radius:18px;color:#fff;background:radial-gradient(circle at 90% 0,rgba(255,255,255,.2),transparent 34%),linear-gradient(125deg,#172b5f,var(--accent));box-shadow:0 16px 36px color-mix(in srgb,var(--accent) 20%,transparent)}.eyebrow{color:rgba(255,255,255,.7);font-size:10px;font-weight:800;letter-spacing:.18em}.import-hero h2{margin:7px 0 6px;font-size:26px}.import-hero p{margin:0;color:rgba(255,255,255,.75);font-size:13px}.import-hero :deep(.el-button){border-color:rgba(255,255,255,.35);background:rgba(255,255,255,.12);color:#fff}
.import-layout{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(420px,.95fr);gap:14px}.upload-panel,.requirements-panel,.workflow-panel{border:1px solid var(--line);border-radius:15px;background:#fff;box-shadow:0 7px 22px rgba(33,48,78,.055)}.upload-panel,.requirements-panel{min-height:570px;padding:20px}.upload-panel>header,.requirements-panel>header{display:flex;align-items:flex-start;gap:11px;margin-bottom:19px}.step-no{display:grid;flex:0 0 auto;width:32px;height:32px;place-items:center;border-radius:9px;background:var(--accent-soft);color:var(--accent);font-size:10px;font-weight:800}.import-layout h3{margin:1px 0 4px;font-size:14px}.import-layout header p{margin:0;color:#929cad;font-size:10px;line-height:1.55}.file-drop{display:flex;flex-direction:column;align-items:center;width:100%;padding:37px 20px;border:1px dashed #cbd5e1;border-radius:13px;background:#fafcff;cursor:pointer;transition:.2s}.file-drop:hover,.file-drop.selected{border-color:var(--accent);background:var(--accent-soft)}.file-drop input{display:none}.file-icon{display:grid;width:48px;height:48px;margin-bottom:11px;place-items:center;border-radius:14px;background:#fff;color:var(--accent);box-shadow:0 7px 18px rgba(40,59,92,.1);font-size:24px}.file-drop b{font-size:12px}.file-drop small{margin-top:6px;color:#98a2b3;font-size:10px}.upload-panel footer{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:20px;padding-top:17px;border-top:1px solid #edf0f4}.upload-panel footer span{max-width:340px;color:#8792a4;font-size:10px;line-height:1.6}.upload-panel footer :deep(.el-button){min-width:120px}.import-result{display:flex;align-items:flex-start;gap:10px;margin-top:14px;padding:12px 13px;border-radius:10px}.import-result.success{background:#edf9f4;color:#147a57}.import-result.error{background:#fff3f1;color:#c54d43}.import-result .el-icon{margin-top:1px;font-size:18px}.import-result b{font-size:11px}.import-result p{margin:4px 0 0;font-size:10px;line-height:1.55}
.import-result>div{min-width:0}.import-errors{display:grid;gap:4px;max-height:132px;margin:9px 0 0;padding:9px 10px 9px 26px;overflow:auto;border-radius:8px;background:rgba(255,255,255,.62);font-size:10px;line-height:1.5}.import-errors li::marker{color:currentColor}
.field-groups{display:grid;gap:15px}.field-groups section+section{padding-top:14px;border-top:1px solid #edf0f4}.field-groups h4{margin:0 0 9px;color:#4c5a70;font-size:11px}.field-list{display:grid;grid-template-columns:1fr 1fr;gap:8px}.field-list>div{padding:10px;border-radius:9px;background:#f7f9fc}.field-list span,.field-list small{display:block}.field-list span{font-size:10px;font-weight:700}.field-list em{margin-left:5px;padding:2px 4px;border-radius:4px;background:#fff0ed;color:#d45949;font-size:8px;font-style:normal}.field-list small{margin-top:4px;color:#929cad;font-size:8px;line-height:1.45}.formula-card{margin-top:16px;padding:13px 14px;border-left:3px solid var(--accent);border-radius:0 9px 9px 0;background:var(--accent-soft)}.formula-card span,.formula-card b{display:block}.formula-card span{color:var(--accent);font-size:9px;font-weight:700}.formula-card b{margin-top:5px;font-size:10px;line-height:1.6}
.workflow-panel{display:grid;grid-template-columns:repeat(3,1fr);gap:0;margin-top:14px;padding:17px 20px}.workflow-panel>div{display:flex;align-items:center;gap:10px;padding:5px 18px;border-right:1px solid #e9edf3}.workflow-panel>div:last-child{border-right:0}.workflow-panel>div>span{color:var(--accent);font-size:16px;font-weight:800}.workflow-panel b,.workflow-panel small{display:block}.workflow-panel b{font-size:11px}.workflow-panel small{margin-top:3px;color:#929cad;font-size:9px}
@media(max-width:1050px){.import-layout{grid-template-columns:1fr}.upload-panel,.requirements-panel{min-height:auto}}
@media(max-width:700px){.import-hero{align-items:flex-start;flex-direction:column;padding:22px 20px}.field-list{grid-template-columns:1fr}.workflow-panel{grid-template-columns:1fr}.workflow-panel>div{border-right:0;border-bottom:1px solid #e9edf3}.workflow-panel>div:last-child{border-bottom:0}.upload-panel footer{align-items:stretch;flex-direction:column}.upload-panel footer :deep(.el-button){width:100%}}
</style>
