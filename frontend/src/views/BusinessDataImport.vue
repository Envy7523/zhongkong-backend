<template>
  <div class="business-import-page" :class="`mode-${mode}`">
    <section class="import-hero">
      <div>
        <span class="eyebrow">DATA INTAKE</span>
        <h2>{{ activeImportTitle }}</h2>
        <p>{{ activeImportDescription }}</p>
      </div>
      <el-tag v-if="isDirectSource" class="direct-source-tag" effect="plain">原始报表可直接上传</el-tag>
      <el-button v-else plain @click="downloadTemplate"><el-icon><Download /></el-icon>下载标准模板</el-button>
    </section>

    <section class="platform-switcher" aria-label="选择数据来源平台">
      <button v-for="item in platformTabs" :key="item.value" type="button" :class="['platform-entry', { active: platform === item.value }]" @click="selectPlatform(item.value)">
        <span class="platform-entry-icon">{{ item.short }}</span>
        <span><b>{{ item.label }}</b><small>{{ item.note }}</small></span>
        <em v-if="platform === item.value">当前导入</em>
      </button>
    </section>

    <section class="import-layout">
      <main class="upload-panel">
        <header>
          <span class="step-no">01</span>
          <div><h3>{{ isDirectSource ? `上传${platform}原始报表` : '选择并上传营业文件' }}</h3><p>{{ isDouyinGroupBuy && groupReportKind === 'operation' ? '录入访问人数、购买人数、门店评分、累计评价数；营业额和实收自动取分账明细。' : isMeituanGroupOperation ? '只读取门店基础数据明细表；成交/核销/退款原字段不会展示，实际到账自动匹配收益明细。' : isMeituanGroupBuy ? '只读取“收益明细”工作表，按美团团购门店 ID 与收益时间精确入库。' : isDouyinGroupBuy ? '只读取“分账明细-正向-团购”和“分账明细-退款-团购”，按核销时间、订单编号与核销门店 ID 自动抵销。' : isMeituanDelivery ? '无需整理模板，先选好文件，点击「开始导入」后系统才自动识别报表类型，并按平台门店 ID 精确关联。' : '支持 Excel（.xlsx / .xls）和 CSV，同门店、同日期、同渠道再次导入会覆盖旧记录。' }}</p></div>
        </header>

        <el-form label-position="top">
          <section v-if="isMeituanDelivery" class="report-type-section" aria-label="选择外卖报表类型">
            <div class="section-caption"><span>第 2 步：选择报表类型</span><small>每个平台均按三类数据分别导入，避免混传</small></div>
            <div class="report-type-grid">
              <button v-for="report in deliveryReportOptions" :key="report.key" type="button" :class="['report-type-card', report.tone, { active: deliveryReportKind === report.key }]" @click="selectDeliveryReport(report.key)">
                <span class="report-type-icon"><el-icon><component :is="report.icon" /></el-icon></span>
                <div><b>{{ report.title }}</b><small>{{ report.description }}</small></div>
                <em>{{ report.destination }}</em>
              </button>
            </div>
          </section>
          <section v-if="isMeituanGroupPlatform || isDouyinGroupBuy" class="report-type-section" aria-label="选择团购报表类型">
            <div class="section-caption"><span>第 2 步：选择报表类型</span><small>结算明细与门店经营数据独立导入，互不覆盖</small></div>
            <div class="report-type-grid">
              <button v-for="report in (isDouyinGroupBuy ? douyinReportOptions : groupReportOptions)" :key="report.key" type="button" :class="['report-type-card', report.tone, { active: groupReportKind === report.key }]" @click="selectGroupReport(report.key)">
                <span class="report-type-icon"><el-icon><component :is="report.icon" /></el-icon></span><div><b>{{ report.title }}</b><small>{{ report.description }}</small></div><em>{{ report.destination }}</em>
              </button>
            </div>
          </section>
          <el-form-item :label="isDirectSource ? `选择${platform}${isDouyinGroupBuy ? (groupReportKind === 'operation' ? '门店经营数据表' : '分账明细') : isMeituanGroupPlatform ? (groupReportKind === 'operation' ? '门店基础数据表' : '收益明细') : (selectedDeliveryReport?.title || '报表')}` : '营业数据文件'" required>
            <label class="file-drop" :class="{ selected: file, dragging: fileDropActive }" @dragenter.prevent="fileDropActive = true" @dragover.prevent="fileDropActive = true" @dragleave.prevent="fileDropActive = false" @drop.prevent="dropFile">
              <input type="file" accept=".xlsx,.xls,.csv" @change="selectFile" />
              <span class="file-icon"><el-icon><DocumentAdd /></el-icon></span>
              <b>{{ file ? file.name : '点击选择或直接拖放文件' }}</b>
              <small v-if="file">{{ fileSize(file.size) }} · {{ detectedFileLabel || '等待导入时校验文件内容' }}</small>
              <small v-else>{{ isDouyinGroupBuy && groupReportKind === 'operation' ? '支持含门店ID、天、访问人数、购买人数、门店评分、累计评价数的经营表' : isMeituanGroupOperation ? '只支持含日期、美团门店ID、曝光、访问、购买、成交与核销字段的门店基础数据表' : isMeituanGroupBuy ? '只支持美团团购“收益明细”Excel 工作表' : isDouyinGroupBuy ? '同一文件必须同时包含抖音“分账明细-正向-团购”和“分账明细-退款-团购”' : isMeituanDelivery ? '选择文件后点击「开始导入」，届时自动识别平台与报表类型并按内容校验。' : '支持拖放 Excel / CSV 文件' }}</small>
            </label>
          </el-form-item>
        </el-form>

        <div v-if="result" :class="['import-result', result.type]">
          <el-icon><CircleCheck v-if="result.type === 'success'" /><Warning v-else /></el-icon>
          <div>
            <b>{{ result.title }}</b>
            <p>{{ result.message }}</p>
            <div v-if="result.type === 'success' && result.stats?.length" class="result-stats">
              <span v-for="stat in result.stats" :key="stat.label"><small>{{ stat.label }}</small><b>{{ stat.value }}</b></span>
            </div>
            <ul v-if="result.errors?.length" class="import-errors" aria-label="未导入行明细">
              <li v-for="error in result.errors" :key="error">{{ error }}</li>
            </ul>
          </div>
        </div>

        <footer>
          <span>{{ importing && importStage ? importStage : (isDirectSource ? `门店仅按“第三方平台 → ${platform} ID”匹配；未匹配的数据会保留，方便补齐档案后重导。` : '系统会自动匹配门店、校验日期并计算平台实际结算。') }}</span>
          <el-button type="primary" size="large" :loading="importing" :disabled="!canSubmit" @click="submitImport">{{ importing ? (importStage || '正在导入…') : '开始导入' }}</el-button>
        </footer>
      </main>

      <aside class="requirements-panel">
        <header><span class="step-no">02</span><div><h3>{{ isMeituanDelivery ? '报表识别与归属' : '需要准备的数据' }}</h3><p>{{ isMeituanDelivery ? '平台原表可直接上传，识别在点击「开始导入」之后进行；带“必填”的字段缺失时，该行不会进入分析。' : '带“必填”的字段缺失时，该行不会进入分析。' }}</p></div></header>
        <div class="field-groups">
          <section v-for="group in activeGroups" :key="group.title">
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
          <b>{{ activeFormula }}</b>
        </div>
      </aside>
    </section>

    <section class="workflow-panel">
      <div v-for="(item, index) in activeWorkflow" :key="item.title">
        <span>{{ String(index + 1).padStart(2, '0') }}</span>
        <div><b>{{ item.title }}</b><small>{{ item.note }}</small></div>
      </div>
    </section>

    <section class="import-history-panel">
      <header>
        <div><span class="eyebrow">IMPORT HISTORY</span><h3>导入记录</h3><p>所有平台共用一份历史记录，可追溯文件、归属平台与覆盖日期。</p></div>
        <div class="history-actions">
          <el-select v-model="batchPlatformFilter" clearable placeholder="全部平台" @change="resetImportHistoryPage">
            <el-option v-for="item in allPlatformTabs" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <el-button plain :loading="historyLoading" @click="loadImportBatches">刷新</el-button>
        </div>
      </header>
      <el-table v-loading="historyLoading" :data="importBatches" class="import-history-table" empty-text="暂无导入记录">
        <el-table-column label="导入时间" min-width="160"><template #default="{ row }">{{ formatDateTime(row.created_at) }}</template></el-table-column>
        <el-table-column label="来源平台" min-width="120"><template #default="{ row }"><span class="history-platform-chip">{{ row.platform || (row.source_type === 'pos' ? '收银系统' : '未标记') }}</span></template></el-table-column>
        <el-table-column label="文件名称" min-width="260" show-overflow-tooltip><template #default="{ row }">{{ row.file_name || '未命名文件' }}</template></el-table-column>
        <el-table-column label="数据日期" min-width="180"><template #default="{ row }">{{ row.date_from || '—' }} 至 {{ row.date_to || '—' }}</template></el-table-column>
        <el-table-column label="入库记录" min-width="100" align="right"><template #default="{ row }">{{ row.row_count || 0 }} 条</template></el-table-column>
        <el-table-column label="导入人" min-width="110"><template #default="{ row }">{{ row.imported_by_name || '系统管理员' }}</template></el-table-column>
      </el-table>
      <footer class="history-pagination">
        <span>共 {{ importBatchTotal }} 条记录</span>
        <el-pagination v-model:current-page="importBatchPage" v-model:page-size="importBatchPageSize" :total="importBatchTotal" :page-sizes="[10, 20, 50, 100]" layout="sizes, prev, pager, next" small @current-change="loadImportBatches" @size-change="resetImportHistoryPage" />
      </footer>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { CircleCheck, DocumentAdd, Download, Money, Warning, Tickets, TrendCharts } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { getBusinessImportBatches, getBusinessTemplate, importBusinessData, importDouyinGroupBuyData, importJdDeliveryData, importMeituanDeliveryData, importMeituanGroupBuyData, importMeituanGroupOperationData, importTaobaoFlashData } from '@/api'

const route = useRoute()
const file = ref(null)
const fileDropActive = ref(false)
const detectedFileLabel = ref('')
const platform = ref('')
const importing = ref(false)
// 导入过程中的阶段提示：先识别报表类型，再校验内容并入库
const importStage = ref('')
const result = ref(null)
const deliveryReportKind = ref('operating')
const groupReportKind = ref('benefit')
const importBatches = ref([])
const historyLoading = ref(false)
const batchPlatformFilter = ref('')
const importBatchTotal = ref(0)
const importBatchPage = ref(1)
const importBatchPageSize = ref(20)

const mode = ref(['group-buy', 'delivery'].includes(route.meta.importMode) ? route.meta.importMode : 'pos')
const configs = {
  pos: {
    title: '收银系统数据导入',
    description: '支持标准模板，也可直接上传收银系统“综合营业统计”原表；原表仅提取已配置的渠道字段入库。',
    platforms: [],
    groups: [
      { title: '基础识别', fields: [{ name: '日期', required: true, note: '营业日期，格式 YYYY-MM-DD' }, { name: '门店ID / 门店名称', required: true, note: '至少填写一项，必须与门店档案匹配' }, { name: '订单数', note: '门店当日总订单数' }] },
      { title: '线下堂食', fields: [{ name: '扫码支付', note: '微信、支付宝等线下扫码实收' }, { name: '现金', note: '现金实收金额' }, { name: '小程序储值消费', note: '会员储值账户核销金额' }, { name: '其他线下', note: '其他堂食收款方式' }] },
      { title: '线上收银记录', fields: [{ name: '美团团购 / 抖音团购', note: '收银机核销记录金额，用于双向验证' }, { name: '淘宝闪购综合营业统计', note: '按三级表头定位“淘宝闪购 → 营业额 / 营业收入 / 订单量”，不依赖固定列号' }, { name: '美团外卖 / 京东外卖', note: '收银系统记录金额，不作为最终平台实收' }] },
    ],
    formula: '门店收银总账 = 线下堂食 + 收银系统记录的全部线上渠道',
    workflow: [{ title: '导出收银日报', note: '综合营业统计原表可直接上传' }, { title: '自动识别所需字段', note: '按“淘宝闪购 + 指标名”动态定位，不导入无关字段' }, { title: '导入形成核对基准', note: '线上金额保留为收银侧记录，等待平台账单核验' }],
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
    description: '导入美团外卖、淘宝闪购或京东外卖账单；美团与京东支持直接上传“营业额收入单量”或“商品销量”全门店报表。',
    platforms: ['美团外卖', '淘宝闪购', '京东外卖'],
    groups: [
      { title: '基础识别', fields: [{ name: '日期', required: true, note: '订单归属的营业日期' }, { name: '门店ID / 门店名称', required: true, note: '至少填写一项' }, { name: '渠道', required: true, note: '美团外卖、淘宝闪购或京东外卖' }] },
      { title: '结算数据', fields: [{ name: '订单金额', note: '顾客支付及平台补贴前后按导出口径填写' }, { name: '实收', note: '平台实际结算金额' }, { name: '手续费 / 保险费 / 推广费', note: '佣金、履约、流量推广等费用' }, { name: '退款金额', note: '退款和售后金额' }, { name: '订单数', note: '有效完成订单数' }] },
      { title: '平台商品销量报表', fields: [{ name: '商品名', note: '平台“全部门店商品销量”报表原字段' }, { name: '商品销量', note: '按日期和平台门店 ID 汇总的销量' }, { name: '商品销售额', note: '对应商品销售金额' }] },
    ],
    formula: '外卖实收 = 平台实收；未提供实收时 = 订单金额 - 手续费 - 保险费 - 推广费 - 退款',
    workflow: [{ title: '导出平台报表', note: '美团、京东可直接上传“营业额收入单量”或“商品销量”原表' }, { title: '系统自动识别', note: '按“第三方平台 → 对应平台 ID”精确匹配门店' }, { title: '进入对应看板', note: '营业数据用于核对；商品销量进入对应平台菜品销量看板' }],
  },
}
const config = computed(() => configs[mode.value])
const activeImportTitle = computed(() => mode.value === 'pos' ? config.value.title : `${platform.value || '平台'}数据导入`)
const activeImportDescription = computed(() => {
  if (mode.value === 'pos') return config.value.description
  if (platform.value === '美团外卖') return '美团原始结算账单、营业日报和商品销量分别识别，按美团门店 ID 精确归属。'
  if (platform.value === '淘宝闪购') return '淘宝账单汇总、营业日报和商品销量独立入库；日商品总量可进入规格拆分与成本核算。'
  if (platform.value === '京东外卖') return '京东营业日报、商品销量和“全部门店真实到账收入”结算明细均可直接上传；结算明细以 X 列应结金额作为已扣费实际到账。'
  if (platform.value === '美团团购') return groupReportKind.value === 'operation' ? '导入门店基础数据的经营、流量和评分；实际到账自动关联已导入的收益明细。' : '仅读取美团团购“收益明细”工作表，按收益时间结算，并同步生成菜品绑定来源。'
  if (platform.value === '抖音团购') return '读取抖音团购“分账明细-正向/退款-团购”两张表，核销时间归属日期，订单编号自动抵销，并同步生成菜品绑定来源。'
  return `${platform.value || '当前平台'}的导入规则、字段说明与文件记录独立展示。`
})
const platformTabs = computed(() => mode.value === 'pos'
  ? [{ value: '收银系统', label: '收银系统', short: 'POS', note: '综合营业统计 / 标准模板' }]
  : config.value.platforms.map(name => ({
    value: name,
    label: name,
    short: name === '美团外卖' ? 'MT' : name === '淘宝闪购' ? 'TB' : name === '京东外卖' ? 'JD' : name === '美团团购' ? '团' : name === '抖音团购' ? 'DY' : '免',
    note: name === '美团外卖' ? '结算账单 · 营业日报 · 商品销量' : name === '淘宝闪购' ? '账单汇总 · 日报 · 商品销量' : name === '京东外卖' ? '营业日报 · 商品销量' : name === '美团团购' ? '收益明细（仅此工作表）' : name === '抖音团购' ? '分账明细 · 正向 / 退款' : '平台结算与商品数据',
  })))
const allPlatformTabs = [
  { value: '收银系统', label: '收银系统' }, { value: '美团外卖', label: '美团外卖' }, { value: '淘宝闪购', label: '淘宝闪购' }, { value: '京东外卖', label: '京东外卖' }, { value: '美团团购', label: '美团团购' }, { value: '抖音团购', label: '抖音团购' }, { value: '免费试', label: '免费试' },
]
const canSubmit = computed(() => file.value && (mode.value === 'pos' || platform.value))
const isMeituanDelivery = computed(() => mode.value === 'delivery' && ['美团外卖', '淘宝闪购', '京东外卖'].includes(platform.value))
const isMeituanGroupBuy = computed(() => mode.value === 'group-buy' && platform.value === '美团团购' && groupReportKind.value === 'benefit')
const isMeituanGroupOperation = computed(() => mode.value === 'group-buy' && platform.value === '美团团购' && groupReportKind.value === 'operation')
const isMeituanGroupPlatform = computed(() => mode.value === 'group-buy' && platform.value === '美团团购')
const isDouyinGroupBuy = computed(() => mode.value === 'group-buy' && platform.value === '抖音团购')
const isDirectSource = computed(() => isMeituanDelivery.value || isMeituanGroupPlatform.value || isDouyinGroupBuy.value)
const deliveryReportOptions = computed(() => [
  { key: 'operating', title: '营业数据表', description: '营业额、收入、订单量及流量转化数据。', destination: '经营看板', icon: TrendCharts, tone: 'revenue', hint: '请选择平台导出的营业数据表（营业额、收入、订单量）。' },
  { key: 'products', title: '商品销量表', description: '按门店、日期和商品名称归集销量与销售额。', destination: '菜品销量', icon: Tickets, tone: 'products', hint: '请选择平台导出的商品销量表。' },
  { key: 'settlement', title: '真实到账表', description: platform.value === '京东外卖' ? '平台已结算到账金额，不再重复扣除第三方费用。' : '平台结算金额，用于确定真实到账口径。', destination: '结算核对', icon: Money, tone: 'revenue', hint: '请选择平台导出的真实到账结算表。' },
])
const selectedDeliveryReport = computed(() => deliveryReportOptions.value.find(item => item.key === deliveryReportKind.value))
const douyinReportOptions = [
 {key:'benefit',title:'分账明细',description:'营业额、实收与费用按分账明细汇总。',destination:'结算与菜品分析',icon:Money,tone:'revenue'},
 {key:'operation',title:'门店经营数据',description:'访问人数、购买人数、门店评分、累计评价数；自动计算下单转化率。',destination:'门店经营看板',icon:TrendCharts,tone:'revenue'}
]
const groupReportOptions = [
  { key: 'benefit', title: '收益明细', description: '生成实际到账、费用明细与团购菜品来源。', destination: '结算与菜品分析', icon: Money, tone: 'revenue' },
  { key: 'operation', title: '门店基础数据', description: '导入营业额、收入、订单量、流量与评分。实际到账自动取收益明细。', destination: '经营趋势看板', icon: TrendCharts, tone: 'revenue' },
]
const meituanReports = computed(() => platform.value === '淘宝闪购'
  ? [
    { title: '真实到账 · 账单汇总', description: '归集推广、保障、配送、红包、余额变动等平台费用，全部账单类型相加为最终到账。', destination: '进入经营分析（补齐费用与到账）', icon: Money, tone: 'revenue' },
    { title: '运营日报 · 流量转化', description: '提供营业额、优惠后收入、订单及曝光/进店/下单转化；实际到账以账单汇总为准。', destination: '进入经营分析', icon: TrendCharts, tone: 'revenue' },
  ]
  : platform.value === '美团外卖'
    ? [
      { title: '真实到账 · 结算账单', description: '美团“订单明细”导出：按 D交易类型 + R商家应收款 归集费用与到账，全部类型相加为真实到账。', destination: '进入经营分析（补齐费用与到账）', icon: Money, tone: 'revenue' },
      { title: '营业额 · 收入 · 单量', description: '按门店、日期写入平台营收与有效订单；与结算账单自动合并。', destination: '进入经营分析', icon: TrendCharts, tone: 'revenue' },
      { title: '商品销量', description: '按门店、日期、商品归并销量与商品销售额。', destination: '进入菜品销量', icon: Tickets, tone: 'products' },
    ]
    : [
      { title: '营业额 · 收入 · 单量', description: '按门店、日期写入平台营收与有效订单。', destination: '进入经营分析', icon: TrendCharts, tone: 'revenue' },
      { title: '商品销量', description: '按门店、日期、商品归并销量与商品销售额。', destination: '进入菜品销量', icon: Tickets, tone: 'products' },
    ])
const meituanGroupByPlatform = {
  '淘宝闪购': [
    { title: '真实到账 · 账单汇总', fields: [{ name: '门店ID（B列）', required: true, note: '用于关联第三方平台档案' }, { name: '账单日期（D列）', required: true, note: '营业归属日期' }, { name: '账单类型（G列）', required: true, note: '“外卖”代表优惠后收入；推广/保障/配送/红包/余额变动归平台费用' }, { name: '结算金额（E列）', required: true, note: '正数为收入、负数为费用扣款；全部类型相加为最终到账' }, { name: '结算入账ID / 门店名称 / 结算日期', note: '随行保留；新增列自动收录，不丢失' }] },
    { title: '运营日报 · 流量转化', fields: [{ name: '日期 / 门店编号', required: true, note: '平台报表中的营业日期与门店编号' }, { name: '营业额 / 收入 / 有效订单', note: '收入是优惠后收入；实际到账由账单汇总扣除第三方费用后确定' }, { name: '曝光人数 / 进店人数 / 下单人数 / 曝光次数', note: '进入淘宝闪购经营漏斗，人数与次数按日期、门店汇总' }] },
    { title: '商品销量报表', fields: [{ name: '日期 / 门店编号 / 商品名称', required: true, note: '三项共同确定一条商品销量记录' }, { name: '商品销量 / 商品销售额', note: '商品按日汇总后进入菜品绑定和规格拆分' }] },
  ],
  '美团外卖': [
    { title: '真实到账 · 结算账单', fields: [{ name: '交易类型（D列）', required: true, note: '外卖订单/保险/推广/津贴/退款等' }, { name: '商家应收款（R列）', required: true, note: '正数为收入、负数为费用扣款；全部类型相加为真实到账' }, { name: '账单日期（P列） / 门店id（A列）', required: true, note: '营业归属日期与美团门店 ID' }, { name: '门店名称 / 交易描述', note: '随行保留；新增列自动收录，不丢失' }] },
    { title: '营业额收入单量报表', fields: [{ name: '日期', required: true, note: '平台报表中的营业日期' }, { name: '门店id', required: true, note: '用于关联第三方平台档案' }, { name: '营业收入 / 优惠前总额', note: '分别写入实收与优惠前金额' }, { name: '有效订单', note: '写入门店当日外卖订单量' }] },
    { title: '商品销量报表', fields: [{ name: '日期 / 门店id / 商品名', required: true, note: '三项共同确定一条商品销量记录' }, { name: '商品销量 / 商品销售额', note: '同一商品的重复行会自动合并' }] },
  ],
  '京东外卖': [
    { title: '运营日报 · 流量转化', fields: [{ name: '日期', required: true, note: '平台报表中的营业日期' }, { name: '门店id', required: true, note: '用于关联第三方平台档案' }, { name: '收入 / 营业额 / 有效订单', note: '分别写入营业收入、营业额与门店当日外卖订单量' }, { name: '曝光人数 / 入店人数 / 曝光次数 / 入店转化率 / 下单转化率', note: '进入京东外卖经营漏斗，金额和人数求和，转化率按漏斗口径重算' }] },
    { title: '真实到账结算明细', fields: [{ name: '门店编号 / 订单完成时间', required: true, note: '第二行表头自动识别，按门店和完成日期汇总' }, { name: 'X 列应结金额', required: true, note: '已扣除第三方费用，直接写入实际到账，不再重复扣费' }] },
    { title: '商品销量报表', fields: [{ name: '日期 / 门店id / 商品名称', required: true, note: '三项共同确定一条商品销量记录' }, { name: '商品销量 / 商品销售额', note: '同一商品的重复行会自动合并' }] },
  ],
}
const meituanGroupOperationGroups = [{ title: '门店基础数据（只读取明细表）', fields: [{ name: '日期 / 美团门店ID / 门店名称', required: true, note: '按日期和美团团购门店 ID 精确归属' }, { name: '曝光人数 / 访问人数 / 购买人数', required: true, note: '进入流量转化趋势；两个转化率由人数重新计算，不读取原表百分比' }, { name: '成交金额 / 核销金额', required: true, note: '分别映射为营业额、收入；原字段名不在看板展示' }, { name: '美团星级 / 点评星级 / 全部评价数', note: '独立进入评分评价趋势组' }, { name: '退款金额', note: '只保留在原始行追溯，不参与本经营看板' }] }]
const meituanGroupBenefitGroups = [{ title: '收益明细（仅此工作表）', fields: [{ name: '收益时间（C列）/ 美团门店ID（J列）', required: true, note: '收益时间是唯一结算归属日期；门店严格按美团团购 ID 匹配' }, { name: '项目名称（L列）', required: true, note: '消费与撤销流水自动进入“团购菜品绑定”，关联堂食菜品成本' }, { name: '售价（T列）/ 商家应得（AP列）', required: true, note: '售价计营业额；商家应得计真实结算收入' }, { name: 'U–AO 全部费用', required: true, note: '全量保留并纳入平台费用，保险、退款、推广等按原始字段可追溯' }, { name: 'AQ 美团补贴 / AR 顾客支付 / AS 售卖方式', note: '补贴不算商家费用；线上交易、线下买单分别保留' }] }]
const douyinGroupSettlementGroups = [{ title: '分账明细（必须同时存在两张表）', fields: [{ name: '核销时间（A列）/ 订单编号（B列）', required: true, note: '核销时间决定营业日期，订单编号连接正向与退款流水' }, { name: '核销门店 ID（K列）/ 订单商品（N列）', required: true, note: '门店严格按抖音团购 ID 匹配；商品自动进入团购菜品绑定' }, { name: '售卖金额（U列）/ 到手金额（BK列）', required: true, note: '售卖金额计营业额，到手金额是最终真实结算收入' }, { name: 'X–BI 第三方费用与费率', required: true, note: '金额字段逐项保留用于费用看板；费率仅作原始追溯，不参与二次扣减' }] }]
const douyinOperationGroups = [{title:'门店经营数据',fields:[{name:'门店ID / 天',required:true,note:'按抖音平台门店ID和日期关联'},{name:'访问人数 / 购买人数',required:true,note:'下单转化率按购买人数除以访问人数计算'},{name:'门店评分 / 累计评价数',required:true,note:'查询期末快照；累计评价不按每日重复相加'}]}]
const activeGroups = computed(() => isDouyinGroupBuy.value && groupReportKind.value === 'operation' ? douyinOperationGroups : isMeituanGroupOperation.value ? meituanGroupOperationGroups : isMeituanGroupBuy.value ? meituanGroupBenefitGroups : isDouyinGroupBuy.value ? douyinGroupSettlementGroups : isMeituanDelivery.value ? (meituanGroupByPlatform[platform.value] || []) : config.value.groups)
const activeFormula = computed(() => isDouyinGroupBuy.value && groupReportKind.value === 'operation' ? '下单转化率 = 购买人数 ÷ 访问人数；营业额、实收继续读取分账明细。' : isMeituanGroupOperation.value
  ? '营业额 = 成交金额；收入 = 核销金额；订单量 = 购买人数；曝光-访问转化率 = 访问人数 ÷ 曝光人数；访问-购买转化率 = 购买人数 ÷ 访问人数；实际到账 = 同门店、同日期收益明细的商家应得。'
  : isMeituanGroupBuy.value
  ? '营业额 = 售价（T）；平台费用 = U–AO；商家应得（AP）= 售价 − 平台费用。AQ 美团补贴只计算顾客实际支付（AR），不计为商家成本。'
  : isDouyinGroupBuy.value
  ? '营业额 = U列售卖金额（正向 − 退款）；实际收入 = BK列到手金额（正向 − 退款）。X–BI 费用字段仅展示构成，不从 BK 再次扣减。'
  : isMeituanDelivery.value
  ? platform.value === '淘宝闪购'
    ? '营业额 − 客户优惠 = 优惠后收入；优惠后收入 − 平台费用 = 真实到账。日报与账单按门店、日期自动合并。'
    : platform.value === '美团外卖'
      ? '真实到账 = 结算账单全部“交易类型（D列）”的“商家应收款（R列）”之和；营业额、优惠与单量仍由营业额日报提供。'
      : '营业报表按门店、日期更新平台营收；商品报表按门店、日期、商品汇总，重复商品自动合并。'
  : config.value.formula)
const activeWorkflow = computed(() => isDouyinGroupBuy.value && groupReportKind.value === 'operation' ? [{title:'匹配门店与日期',note:'按抖音门店ID精确匹配'}, {title:'导入经营指标',note:'访问人数、购买人数、门店评分、累计评价数'}, {title:'计算下单转化率',note:'购买人数除以访问人数，按当前筛选范围重算'}] : isMeituanGroupOperation.value
  ? [{ title: '读取门店基础明细', note: '只读取含美团门店 ID 的明细表，不读取汇总页，避免重复累计' }, { title: '重算转化率', note: '曝光—访问、访问—购买均以汇总人数重新计算' }, { title: '关联收益明细', note: '实际到账自动读取同门店、同日期已导入收益明细的商家应得' }]
  : isMeituanGroupBuy.value
  ? [{ title: '仅识别收益明细', note: '同文件的其他工作表不会读取或入库' }, { title: '按收益时间汇总', note: '消费、保险、撤销、退保等所有结算流水共同生成日账' }, { title: '生成菜品成本入口', note: '仅消费和撤销的项目名称进入团购菜品绑定' }]
  : isDouyinGroupBuy.value
  ? [{ title: '校验正向与退款两表', note: '缺少任一工作表将拒绝导入，避免退款漏算' }, { title: '按核销时间和订单编号抵销', note: '同订单正向与退款自动归到同一营业日和门店' }, { title: '生成费用与菜品数据', note: 'X–BI 保留费用字段，订单商品进入团购菜品绑定' }]
  : isMeituanDelivery.value
  ? platform.value === '淘宝闪购'
    ? [{ title: '导出闪购日报与“账单汇总”', note: '日报提供营业额、收入、单量；账单汇总提供费用与到账' }, { title: '按门店、日期自动合并', note: '账单“外卖”对应优惠后收入，其他类型分类计入平台费用' }, { title: '生成完整口径', note: '营业额、优惠、收入、费用、实际到账分层展示，不互相覆盖' }]
    : platform.value === '美团外卖'
      ? [{ title: '导出美团“订单明细”结算账单', note: '含交易类型(D列)与商家应收款(R列)，可整月导出' }, { title: '按交易类型归集到账', note: '外卖订单=收入，保险/推广/津贴/退款等分类计入费用' }, { title: '与日报合并生成口径', note: '营业额日报 + 结算账单 = 完整分层数据' }]
      : [{ title: '导出平台原表', note: '无需转换字段或另行整理模板' }, { title: '上传自动识别', note: '营业报表与商品报表分别进入对应数据表' }, { title: '按门店 ID 入看板', note: '已匹配数据立即参与平台分析' }]
  : config.value.workflow)

function detectDeliveryFile(fileName) {
  const text = String(fileName || '').replace(/\s/g, '').toLowerCase()
  // 美团后台的标准 CSV 文件名为“门店_全部门店_*”与“商品_全部门店_*”，
  // 文件名本身不含“美团”“营业”“销量”，需要单独识别，否则会保留默认报表类型而被后端校验拒绝。
  const isMeituanStandardExport = /(?:^|[_-])(门店|商品)_全部门店(?:[_-]|$)/.test(text)
  // 淘宝闪购与京东的后台标准导出也常不带平台名：按稳定的文件名前缀补足识别。
  const isJdSettlementExport = /京东|jd|秒送|对账单下载/.test(text)
  const isTaobaoStandardExport = /门店下载_|商品下载_|到家.*账单/.test(text)
  const isTaobaoSettlement = /到家.*账单|闪购.*账单/.test(text)
  const isTaobaoProduct = /商品下载_/.test(text)
  const isTaobaoOperation = /门店下载_/.test(text)
  // “门店_日期区间_鹅太公总商_时间戳”与“商品_日期区间_鹅太公总商_时间戳”是京东外卖和淘宝闪购共用的导出名，
  // 只能确定报表类型，平台必须等到导入时按表内门店 ID 判定，这里不再猜测，避免京东数据被当成淘宝闪购。
  const isSharedStoreExport = /(?:^|_)门店_/.test(text) && /鹅太公总商/.test(text)
  const isSharedProductExport = /(?:^|_)商品_/.test(text) && /鹅太公总商/.test(text)
  const detectedPlatform = isJdSettlementExport ? '京东外卖'
    : (isTaobaoStandardExport || /淘宝|闪购|饿了么/.test(text)) ? '淘宝闪购'
      : (isMeituanStandardExport || /美团|大众点评|mt/.test(text)) ? '美团外卖' : ''
  const detectedReport = (isTaobaoProduct || isSharedProductExport || /商品_全部门店|商品.*(销量|销售)|菜品.*(销量|销售)|商品销量/.test(text)) ? 'products'
    : isJdSettlementExport || isTaobaoSettlement || /真实到账|到账收入|结算明细|结算账单|订单明细|账单汇总/.test(text) ? 'settlement'
      : isTaobaoOperation || isSharedStoreExport || /门店_全部门店|营业|收入|单量|运营日报/.test(text) ? 'operating' : ''
  return { platform: detectedPlatform, report: detectedReport }
}

function applyFile(nextFile) {
  fileDropActive.value = false
  if (!nextFile) return
  if (!/\.(xlsx|xls|csv)$/i.test(nextFile.name)) {
    ElMessage.warning('请拖入 Excel 或 CSV 文件（.xlsx、.xls、.csv）')
    return
  }
  file.value = nextFile
  result.value = null
  detectedFileLabel.value = ''
  if (mode.value === 'delivery') {
    // 选择/拖入文件时不做识别：报表识别放到点击「开始导入」之后，随导入过程一起完成
    detectedFileLabel.value = '已选择文件，点击「开始导入」后自动识别平台与报表类型'
  } else if (isDouyinGroupBuy.value && groupReportKind.value === 'operation') {
    detectedFileLabel.value = '导入时校验门店经营指标；不录入成交、核销和退款金额'
  } else if (isMeituanGroupOperation.value || /门店基础数据/.test(nextFile.name)) {
    detectedFileLabel.value = '导入时校验门店基础数据字段，并重算转化率'
  } else if (isMeituanGroupBuy.value || /美团.*团购|团购.*收益明细/.test(nextFile.name)) {
    detectedFileLabel.value = '导入时自动校验“收益明细”工作表'
  } else if (isDouyinGroupBuy.value || /抖音.*账单|抖音.*团购/.test(nextFile.name)) {
    detectedFileLabel.value = '导入时校验“分账明细-正向/退款-团购”两张工作表'
  }
}

function selectFile(event) { applyFile(event.target.files?.[0]) }
function dropFile(event) { applyFile(event.dataTransfer?.files?.[0]) }
function selectPlatform(value) { platform.value = value; deliveryReportKind.value = 'operating'; groupReportKind.value = 'benefit'; file.value = null; detectedFileLabel.value = ''; result.value = null }
function selectDeliveryReport(value) { deliveryReportKind.value = value; file.value = null; detectedFileLabel.value = ''; result.value = null }
function selectGroupReport(value) { groupReportKind.value = value; file.value = null; detectedFileLabel.value = ''; result.value = null }
function fileSize(bytes) { return bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB` }
function formatMoney(value) { const n = Number(value || 0); return Number.isFinite(n) ? n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00' }
function formatDateTime(value) { return String(value || '—').replace('T', ' ').replace(/\.\d{3}Z$/, '') }
function readFile(raw) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(raw) }) }

async function loadImportBatches() {
  historyLoading.value = true
  try {
    const response = await getBusinessImportBatches({ platform: batchPlatformFilter.value, page: importBatchPage.value, page_size: importBatchPageSize.value })
    importBatches.value = response.batches || []
    importBatchTotal.value = Number(response.total || 0)
  }
  catch (error) { ElMessage.error(`读取导入记录失败：${error.message}`) }
  finally { historyLoading.value = false }
}
function resetImportHistoryPage() { importBatchPage.value = 1; loadImportBatches() }

async function submitImport() {
  if (!canSubmit.value) return
  importing.value = true
  result.value = null
  try {
    // 报表识别随导入开始：先按文件识别平台与报表类型，再进入内容校验与入库
    if (mode.value === 'delivery') {
      importStage.value = '正在识别报表类型…'
      await new Promise(resolve => setTimeout(resolve, 0))
      const detected = detectDeliveryFile(file.value.name)
      if (detected.platform) platform.value = detected.platform
      if (detected.report) deliveryReportKind.value = detected.report
      const reportText = detected.report ? ({ operating: '营业数据表', products: '商品销量表', settlement: '真实到账表' })[detected.report] : '按当前选择校验'
      detectedFileLabel.value = detected.platform
        ? `已识别：${detected.platform} · ${reportText}`
        : detected.report
          ? `已识别报表类型：${reportText}；平台由文件内门店 ID 判定`
          : '未从文件名识别到归属，按当前选择导入并校验'
      importStage.value = '正在导入并校验内容…'
    } else {
      importStage.value = '正在导入并校验内容…'
    }
    const payload = { source_type: mode.value === 'pos' ? 'pos' : 'platform', platform: platform.value, report_kind: isMeituanDelivery.value ? deliveryReportKind.value : (isDouyinGroupBuy.value ? groupReportKind.value : ''), file_name: file.value.name, data: await readFile(file.value) }
    const response = isMeituanGroupOperation.value
      ? await importMeituanGroupOperationData(payload)
      : isMeituanGroupBuy.value
      ? await importMeituanGroupBuyData(payload)
      : isDouyinGroupBuy.value
      ? await importDouyinGroupBuyData(payload)
      : mode.value === 'delivery' && platform.value === '美团外卖'
      ? await importMeituanDeliveryData(payload)
      : mode.value === 'delivery' && platform.value === '京东外卖'
        ? await importJdDeliveryData(payload)
      : mode.value === 'delivery' && platform.value === '淘宝闪购'
        ? await importTaobaoFlashData(payload)
        : await importBusinessData(payload)
    const imported = Number(response.imported || 0)
    const skipped = Number(response.skipped || 0)
    // 后端按文件内门店 ID 复核平台，必要时自动改判（京东与淘宝闪购的同名导出靠这一步区分）。
    const platformSwitch = response.platform_switch || null
    if (response.platform) platform.value = response.platform
    // 淘宝“账单汇总”和美团“结算账单”都采用同一套分层结果字段。
    // 兼容此前已部署的 flash_bills 返回值，避免前后端短暂不同步时丢失结果提示。
    const settlementBills = ['settlement_bills', 'flash_bills'].includes(response.data_kind)
    const settlementLabel = platform.value === '淘宝闪购' ? '账单汇总' : '结算账单'
    const stats = ['meituan_group_operation', 'douyin_group_operation'].includes(response.data_kind)
      ? [{ label: '经营明细', value: `${imported} 条` }, { label: '原始记录', value: `${response.raw_imported || 0} 条` }, { label: '匹配门店', value: `${response.matched_stores || 0} 家` }, { label: '运营周期', value: response.date_from && response.date_to ? `${response.date_from} 至 ${response.date_to}` : '—' }]
      : response.data_kind === 'meituan_group_benefit'
      ? [{ label: '已写入日账', value: `${imported} 条` }, { label: '原始收益流水', value: `${response.raw_imported || 0} 条` }, { label: '团购菜品', value: `${response.product_rows || 0} 条` }, { label: '营业额', value: `¥${formatMoney(response.gross_total)}` }, { label: '第三方费用', value: `¥${formatMoney(response.fee_total)}` }, { label: '商家应得', value: `¥${formatMoney(response.net_total)}` }]
      : response.data_kind === 'douyin_group_settlement'
      ? [{ label: '已写入日账', value: `${imported} 条` }, { label: '正向/退款流水', value: `${response.raw_imported || 0} 条` }, { label: '团购菜品', value: `${response.product_rows || 0} 条` }, { label: '营业额', value: `¥${formatMoney(response.gross_total)}` }, { label: '第三方费用', value: `¥${formatMoney(response.fee_total)}` }, { label: '到手收入', value: `¥${formatMoney(response.net_total)}` }]
      : response.data_kind === 'cashier_composite'
      ? [{ label: '已写入收银记录', value: `${imported} 条` }, { label: '原始明细行', value: `${response.raw_imported || 0} 条` }, { label: '匹配门店', value: `${response.matched_stores || 0} 家` }, { label: '本次识别列', value: `${response.extracted_columns?.gross || '—'} / ${response.extracted_columns?.recorded || '—'} / ${response.extracted_columns?.orders || '—'}` }]
      : response.data_kind === 'product_sales'
      ? [{ label: '已写入商品', value: `${response.product_rows || imported} 条` }, { label: '原始记录', value: `${response.raw_imported || 0} 条` }, { label: '匹配门店', value: `${response.matched_stores || 0} 家` }]
      : response.data_kind === 'delivery_operation'
      ? [{ label: '运营日报', value: `${imported} 条` }, { label: '原始记录', value: `${response.raw_imported || 0} 条` }, { label: '匹配门店', value: `${response.matched_stores || 0} 家` }, { label: '运营周期', value: response.date_from && response.date_to ? `${response.date_from} 至 ${response.date_to}` : '—' }]
      : settlementBills
        ? [{ label: '已写入日账', value: `${response.revenue_records || 0} 条` }, { label: '优惠后收入', value: `¥${formatMoney(response.delivery_amount_total)}` }, { label: '平台费用', value: `¥${formatMoney(response.fee_total)}` }, { label: '真实实收', value: `¥${formatMoney(response.net_total)}` }, { label: '账单原始明细', value: `${response.raw_imported || 0} 条` }, { label: '匹配门店', value: `${response.matched_stores || 0} 家` }]
        : [{ label: '已写入日报', value: `${imported} 条` }, { label: '原始记录', value: `${response.raw_imported || 0} 条` }, { label: '匹配门店', value: `${response.matched_stores || 0} 家` }]
    result.value = {
      type: imported > 0 ? 'success' : 'error',
      title: imported > 0 ? '导入完成' : '未导入有效数据',
      message: (platformSwitch ? `已按文件内门店 ID 自动识别为「${platformSwitch.to}」（原选择「${platformSwitch.from}」），本次数据记入 ${platformSwitch.to}。` : '') + (imported > 0
        ? response.data_kind === 'douyin_group_operation'
          ? `已保存 ${response.raw_imported || 0} 条经营记录，其中 ${imported} 条已匹配门店；仅录入访问人数、购买人数、门店评分和累计评价数，下单转化率自动计算。营业额和实收仍取分账明细，不受本次导入影响。${response.unmatched ? ` ${response.unmatched} 条未匹配门店暂不参与看板，请核对门店的抖音 ID。` : ''}`
          : response.data_kind === 'meituan_group_benefit'
          ? `仅“收益明细”工作表已入库：${response.raw_imported || 0} 条原始流水汇总为 ${imported} 条门店日账；售价 ¥${formatMoney(response.gross_total)} − U–AO 第三方费用 ¥${formatMoney(response.fee_total)} = 商家应得 ¥${formatMoney(response.net_total)}。AQ 美团补贴 ¥${formatMoney(response.customer_promotion_total)} 与 AR 顾客实际支付 ¥${formatMoney(response.customer_paid_total)} 已单独保留；消费/撤销项目已写入团购菜品绑定。${response.unmatched ? ` ${response.unmatched} 条未匹配门店暂不参与看板。` : ''}`
          : response.data_kind === 'douyin_group_settlement'
          ? `已读取抖音团购正向/退款两张分账明细：${response.raw_imported || 0} 条流水汇总为 ${imported} 条门店日账；U列售卖金额 ¥${formatMoney(response.gross_total)}，BK列到手收入 ¥${formatMoney(response.net_total)}。X–BI 的费用金额已逐项保留用于费用明细展示，不会从到手收入重复扣减；${response.product_rows || 0} 条团购菜品已进入绑定来源。${response.unmatched ? ` ${response.unmatched} 条未匹配门店暂不参与看板。` : ''}`
          : settlementBills
          ? `已写入 ${response.revenue_records || 0} 条结算记录；${settlementLabel}原始明细 ${response.raw_imported || 0} 条${response.unmatched ? `，${response.unmatched} 条因未登记${platform.value}门店 ID 暂未计入` : '，全部匹配门店'}。优惠后收入 ¥${formatMoney(response.delivery_amount_total)} − 平台费用 ¥${formatMoney(response.fee_total)} = 真实实收 ¥${formatMoney(response.net_total)}；营业额和客户优惠继续由日报提供。${response.extra_headers?.length ? `本次发现新增列：${response.extra_headers.join('、')}，已随原始行自动收录。` : ''}${skipped ? `；跳过 ${skipped} 行异常数据` : ''}`
          : response.data_kind === 'cashier_composite'
          ? `已识别收银系统“综合营业统计”原表，按“淘宝闪购 → 营业额 / 营业收入 / 订单量”动态定位所需字段；已写入 ${imported} 条收银侧核对记录${skipped ? `；跳过 ${skipped} 行未匹配门店` : ''}。`
          : response.data_kind === 'product_sales'
          ? `写入 ${response.product_rows || imported} 条${platform.value}商品销量${response.raw_imported ? `；原始商品记录已存储 ${response.raw_imported} 条${response.source_rows && response.source_rows !== response.raw_imported ? `（源文件 ${response.source_rows} 行已合并重复商品）` : ''}` : ''}${response.unmatched ? `；${response.unmatched} 条因未登记${platform.value}门店 ID 暂未计入看板` : ''}${skipped ? `；跳过 ${skipped} 行异常数据` : ''}。`
          : response.data_kind === 'delivery_operation'
          ? `已写入 ${imported} 条${platform.value}运营日报，包含营业额、收入、订单、曝光、进店与转化漏斗。${platform.value === '淘宝闪购' ? '“收入”仅作为优惠后收入，实际到账以账单汇总扣除第三方费用后展示。' : ''}${response.unmatched ? `${response.unmatched} 条未匹配门店暂不参与看板。` : ''}${skipped ? ` 跳过 ${skipped} 行异常数据。` : ''}`
          : `写入 ${imported} 条营收记录${response.raw_imported ? `；原始日报已存储 ${response.raw_imported} 条` : ''}${response.unmatched ? `；${response.unmatched} 条因未登记${platform.value}门店 ID 暂未计入分析` : ''}${response.product_rows ? `、${response.product_rows} 条商品销量` : ''}${skipped ? `；跳过 ${skipped} 行异常数据` : ''}。`
        : `文件中的 ${skipped || '所有'} 行均未通过校验，请按下方原因修正后重新上传。`),
      errors: response.errors || [],
      stats: imported > 0 ? stats : [],
    }
    if (imported > 0) { file.value = null; resetImportHistoryPage() }
  } catch (error) {
    result.value = { type: 'error', title: '导入失败', message: error.message }
  } finally { importing.value = false; importStage.value = '' }
}

async function downloadTemplate() {
  try {
    const response = await getBusinessTemplate(mode.value === 'pos' ? 'pos' : 'platform')
    const bytes = Uint8Array.from(atob(response.data), char => char.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
    const link = document.createElement('a'); link.href = url; link.download = mode.value === 'pos' ? response.file_name : `${config.value.title}模板.xlsx`; link.click(); URL.revokeObjectURL(url)
  } catch (error) { ElMessage.error(error.message) }
}

if (!platform.value) platform.value = mode.value === 'pos' ? '收银系统' : config.value.platforms[0] || ''
onMounted(loadImportBatches)
</script>

<style scoped>
.business-import-page{--accent:#3b82f6;--accent-soft:#eff6ff;--ink:#172033;--muted:#7a8699;--line:#e5e9f0;color:var(--ink)}.business-import-page.mode-group-buy{--accent:#8b5cf6;--accent-soft:#f5f1ff}.business-import-page.mode-delivery{--accent:#0d9488;--accent-soft:#ecfdf8}
.import-hero{display:flex;align-items:flex-end;justify-content:space-between;gap:22px;margin-bottom:16px;padding:27px 30px;border-radius:18px;color:#fff;background:radial-gradient(circle at 90% 0,rgba(255,255,255,.2),transparent 34%),linear-gradient(125deg,#172b5f,var(--accent));box-shadow:0 16px 36px color-mix(in srgb,var(--accent) 20%,transparent)}.eyebrow{color:rgba(255,255,255,.7);font-size:10px;font-weight:800;letter-spacing:.18em}.import-hero h2{margin:7px 0 6px;font-size:26px}.import-hero p{margin:0;color:rgba(255,255,255,.75);font-size:13px}.import-hero :deep(.el-button),.direct-source-tag{border-color:rgba(255,255,255,.35);background:rgba(255,255,255,.12);color:#fff}.direct-source-tag{height:30px;padding:0 12px;font-size:11px}
.import-layout{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(420px,.95fr);gap:14px}.upload-panel,.requirements-panel,.workflow-panel{border:1px solid var(--line);border-radius:15px;background:#fff;box-shadow:0 7px 22px rgba(33,48,78,.055)}.upload-panel,.requirements-panel{min-height:570px;padding:20px}.upload-panel>header,.requirements-panel>header{display:flex;align-items:flex-start;gap:11px;margin-bottom:19px}.step-no{display:grid;flex:0 0 auto;width:32px;height:32px;place-items:center;border-radius:9px;background:var(--accent-soft);color:var(--accent);font-size:10px;font-weight:800}.import-layout h3{margin:1px 0 4px;font-size:14px}.import-layout header p{margin:0;color:#929cad;font-size:10px;line-height:1.55}.report-type-section{margin:-1px 0 18px}.section-caption{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;color:#526176;font-size:10px;font-weight:700}.section-caption small{color:#94a0b3;font-size:9px;font-weight:400}.report-type-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.report-type-card{position:relative;min-height:92px;padding:12px 12px 25px;border:1px solid #d9e6e4;border-radius:11px;background:#fbfefd;overflow:hidden}.report-type-card.revenue{border-color:#bfe5dd;background:linear-gradient(135deg,#f0fdfa,#fbfffe)}.report-type-card.products{border-color:#c9dafa;background:linear-gradient(135deg,#f4f8ff,#fbfdff)}.report-type-card>div{padding-left:30px}.report-type-card b,.report-type-card small{display:block}.report-type-card b{color:#294452;font-size:11px}.report-type-card small{margin-top:5px;color:#7f8d9e;font-size:9px;line-height:1.5}.report-type-card em{position:absolute;bottom:9px;left:12px;color:var(--accent);font-size:9px;font-style:normal;font-weight:700}.report-type-icon{position:absolute;top:12px;left:12px;display:grid;width:22px;height:22px;place-items:center;border-radius:7px;background:#d8f3ed;color:#0f766e;font-size:13px}.products .report-type-icon{background:#e3edff;color:#3673d9}.file-drop{display:flex;flex-direction:column;align-items:center;width:100%;padding:37px 20px;border:1px dashed #cbd5e1;border-radius:13px;background:#fafcff;cursor:pointer;transition:.2s}.file-drop:hover,.file-drop.selected{border-color:var(--accent);background:var(--accent-soft)}.file-drop input{display:none}.file-icon{display:grid;width:48px;height:48px;margin-bottom:11px;place-items:center;border-radius:14px;background:#fff;color:var(--accent);box-shadow:0 7px 18px rgba(40,59,92,.1);font-size:24px}.file-drop b{font-size:12px}.file-drop small{margin-top:6px;color:#98a2b3;font-size:10px}.upload-panel footer{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:20px;padding-top:17px;border-top:1px solid #edf0f4}.upload-panel footer span{max-width:340px;color:#8792a4;font-size:10px;line-height:1.6}.upload-panel footer :deep(.el-button){min-width:120px}.import-result{display:flex;align-items:flex-start;gap:10px;margin-top:14px;padding:12px 13px;border-radius:10px}.import-result.success{background:#edf9f4;color:#147a57}.import-result.error{background:#fff3f1;color:#c54d43}.import-result .el-icon{margin-top:1px;font-size:18px}.import-result b{font-size:11px}.import-result p{margin:4px 0 0;font-size:10px;line-height:1.55}
.import-result>div{min-width:0}.result-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;margin-top:10px;border:1px solid rgba(20,122,87,.16);border-radius:8px;overflow:hidden;background:rgba(255,255,255,.58)}.result-stats span{padding:7px 9px;border-right:1px solid rgba(20,122,87,.12)}.result-stats span:last-child{border-right:0}.result-stats small,.result-stats b{display:block}.result-stats small{color:#5f8d7d;font-size:8px}.result-stats b{margin-top:2px;color:#176447;font-size:10px}.import-errors{display:grid;gap:4px;max-height:132px;margin:9px 0 0;padding:9px 10px 9px 26px;overflow:auto;border-radius:8px;background:rgba(255,255,255,.62);font-size:10px;line-height:1.5}.import-errors li::marker{color:currentColor}
.field-groups{display:grid;gap:15px}.field-groups section+section{padding-top:14px;border-top:1px solid #edf0f4}.field-groups h4{margin:0 0 9px;color:#4c5a70;font-size:11px}.field-list{display:grid;grid-template-columns:1fr 1fr;gap:8px}.field-list>div{padding:10px;border-radius:9px;background:#f7f9fc}.field-list span,.field-list small{display:block}.field-list span{font-size:10px;font-weight:700}.field-list em{margin-left:5px;padding:2px 4px;border-radius:4px;background:#fff0ed;color:#d45949;font-size:8px;font-style:normal}.field-list small{margin-top:4px;color:#929cad;font-size:8px;line-height:1.45}.formula-card{margin-top:16px;padding:13px 14px;border-left:3px solid var(--accent);border-radius:0 9px 9px 0;background:var(--accent-soft)}.formula-card span,.formula-card b{display:block}.formula-card span{color:var(--accent);font-size:9px;font-weight:700}.formula-card b{margin-top:5px;font-size:10px;line-height:1.6}
.workflow-panel{display:grid;grid-template-columns:repeat(3,1fr);gap:0;margin-top:14px;padding:17px 20px}.workflow-panel>div{display:flex;align-items:center;gap:10px;padding:5px 18px;border-right:1px solid #e9edf3}.workflow-panel>div:last-child{border-right:0}.workflow-panel>div>span{color:var(--accent);font-size:16px;font-weight:800}.workflow-panel b,.workflow-panel small{display:block}.workflow-panel b{font-size:11px}.workflow-panel small{margin-top:3px;color:#929cad;font-size:9px}
.platform-switcher{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;margin-bottom:14px}.platform-entry{display:flex;align-items:center;gap:10px;min-height:64px;padding:11px 13px;border:1px solid #e2e8f0;border-radius:12px;background:#fff;color:#526176;cursor:pointer;text-align:left;transition:border-color .16s ease,box-shadow .16s ease,transform .16s ease}.platform-entry:hover{border-color:color-mix(in srgb,var(--accent) 48%,#dce4ef);box-shadow:0 6px 16px rgba(31,55,93,.07);transform:translateY(-1px)}.platform-entry.active{border-color:var(--accent);background:var(--accent-soft);box-shadow:0 6px 18px color-mix(in srgb,var(--accent) 13%,transparent)}.platform-entry-icon{display:grid;flex:0 0 auto;width:34px;height:34px;place-items:center;border-radius:10px;background:#edf2f8;color:#46627d;font-size:10px;font-weight:800}.platform-entry.active .platform-entry-icon{background:var(--accent);color:#fff}.platform-entry b,.platform-entry small{display:block}.platform-entry b{color:#344054;font-size:12px}.platform-entry small{margin-top:4px;color:#8a96a8;font-size:9px;line-height:1.3}.platform-entry em{margin-left:auto;color:var(--accent);font-size:9px;font-style:normal;font-weight:750;white-space:nowrap}.import-history-panel{margin-top:14px;padding:20px;border:1px solid var(--line);border-radius:15px;background:#fff;box-shadow:0 7px 22px rgba(33,48,78,.055)}.import-history-panel>header{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;margin-bottom:15px}.import-history-panel .eyebrow{color:var(--accent);font-size:9px}.import-history-panel h3{margin:5px 0 4px;font-size:16px}.import-history-panel p{margin:0;color:#8a96a8;font-size:10px}.history-actions{display:flex;gap:8px}.history-actions :deep(.el-select){width:150px}.import-history-table{border:1px solid #edf0f4;border-radius:10px;overflow:hidden}.import-history-table :deep(th.el-table__cell){height:42px;background:#f8fafc;color:#718096;font-size:10px}.import-history-table :deep(td.el-table__cell){height:46px;color:#526176;font-size:11px}.history-platform-chip{display:inline-flex;padding:4px 8px;border-radius:12px;background:#eef4ff;color:#3569bd;font-size:10px;font-weight:700}
.file-drop.dragging{border-color:var(--accent);background:var(--accent-soft);box-shadow:inset 0 0 0 2px color-mix(in srgb,var(--accent) 16%,transparent);transform:scale(1.002)}
@media(max-width:1050px){.import-layout{grid-template-columns:1fr}.upload-panel,.requirements-panel{min-height:auto}}
@media(max-width:700px){.import-hero{align-items:flex-start;flex-direction:column;padding:22px 20px}.field-list,.report-type-grid{grid-template-columns:1fr}.section-caption{align-items:flex-start;flex-direction:column;gap:3px}.workflow-panel{grid-template-columns:1fr}.workflow-panel>div{border-right:0;border-bottom:1px solid #e9edf3}.workflow-panel>div:last-child{border-bottom:0}.upload-panel footer{align-items:stretch;flex-direction:column}.upload-panel footer :deep(.el-button){width:100%}.result-stats{grid-template-columns:1fr}.result-stats span{border-right:0;border-bottom:1px solid rgba(20,122,87,.12)}.result-stats span:last-child{border-bottom:0}.platform-switcher{grid-template-columns:1fr}.import-history-panel>header{align-items:flex-start;flex-direction:column}.history-actions{width:100%}.history-actions :deep(.el-select),.history-actions :deep(.el-button){flex:1}}
.report-type-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.report-type-card{color:inherit;cursor:pointer;text-align:left;transition:border-color .16s ease,box-shadow .16s ease,transform .16s ease}.report-type-card:hover{transform:translateY(-1px);box-shadow:0 7px 16px rgba(27,62,73,.08)}.report-type-card.active{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 16%,transparent)}.history-pagination{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:14px;color:#8a96a8;font-size:11px}.history-pagination :deep(.el-pagination){justify-content:flex-end}@media(max-width:700px){.history-pagination{align-items:flex-start;flex-direction:column}.history-pagination :deep(.el-pagination){justify-content:flex-start;flex-wrap:wrap}}
</style>
