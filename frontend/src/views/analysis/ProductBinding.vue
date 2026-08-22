<template>
  <div class="binding-page">
    <section class="binding-hero">
      <div class="binding-hero-copy">
        <span class="binding-eyebrow">SKU MAPPING CENTER</span>
        <h2>{{ isGroupBuy ? '团购菜品绑定' : '外卖菜品绑定' }}</h2>
        <p>以本地「菜品名 + 规格 + 做法」为唯一 SKU 进行关联。上庄、下庄、半只等不同售价规格会被分别展示，避免误绑。</p>
      </div>
      <div class="binding-hero-side">
        <div class="mapping-progress">
          <div class="mapping-progress-top"><span>绑定完成度</span><b>{{ bindingRate }}%</b></div>
          <div class="progress-track"><i :style="{ width: `${bindingRate}%` }" /></div>
          <small>{{ mappedCount }} 个已绑定 · {{ unmappedCount }} 个待处理</small>
        </div>
        <button type="button" class="hero-bind-btn" :disabled="autoBinding" @click="autoBind">
          {{ autoBinding ? '正在智能匹配…' : '⚡ 智能匹配未绑定商品' }}
        </button>
      </div>
    </section>

    <section class="mapping-summary">
      <div class="summary-card"><span class="summary-icon blue">⌘</span><div><b>{{ totalProducts }}</b><small>平台商品 SKU</small></div></div>
      <div class="summary-card"><span class="summary-icon green">✓</span><div><b>{{ mappedCount }}</b><small>已完成关联</small></div></div>
      <div class="summary-card"><span class="summary-icon amber">!</span><div><b>{{ unmappedCount }}</b><small>需要选择本地 SKU</small></div></div>
      <p>关联后将按本地 SKU 的成本自动核算商品成本和毛利。</p>
    </section>

    <!-- 工具栏 -->
    <section class="binding-toolbar">
      <el-select v-model="platformFilter" clearable placeholder="全部平台" class="platform-select">
        <el-option v-for="p in platforms" :key="p" :label="p" :value="p" />
      </el-select>
      <el-input v-model="search" clearable placeholder="搜索第三方商品名称" class="search-input" />
      <el-select v-model="mappedFilter" style="width:120px;">
        <el-option label="全部状态" value="" />
        <el-option label="未绑定" value="unbound" />
        <el-option label="已绑定" value="bound" />
      </el-select>
      <el-button v-if="selectedRows.length" type="primary" plain @click="openBatchDialog">批量绑定 {{ selectedRows.length }} 个 SKU</el-button>
      <span class="binding-hint">请确认左侧商品与右侧本地 SKU 的规格一致</span>
    </section>

    <!-- 商品表格 -->
    <section class="binding-panel">
      <el-table v-loading="loading" :data="filteredProducts" class="binding-table" row-key="product_name" @selection-change="onSelectionChange">
        <el-table-column type="selection" width="46" :selectable="row => !row.mapped" />
        <el-table-column prop="platform" label="来源平台" width="116">
          <template #default="{ row }"><span class="platform-chip">{{ row.platform }}</span></template>
        </el-table-column>
        <el-table-column label="第三方商品" min-width="220">
          <template #default="{ row }">
            <div class="external-product">
              <b>{{ row.product_name }}</b>
              <small>平台侧商品名称</small>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="96" align="center">
          <template #default="{ row }">
            <span :class="['status-pill', row.mapped ? 'on' : 'off']">{{ row.mapped ? '已绑定' : '未绑定' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="对应本地 SKU（菜品名 · 规格 · 做法）" min-width="350">
          <template #default="{ row }">
            <div v-if="row.mapped" class="mapped-dish sku-card">
              <div class="sku-card-title"><i>本地 SKU</i><b>{{ row.menu_sku_label || row.menu_name }}</b></div>
              <div class="sku-card-meta">
                <span>{{ row.menu_category || '未分类' }}</span>
                <span>{{ row.menu_sku_price_summary || '价格未设置' }}</span>
                <span>成本 {{ money(row.unit_cost) }}</span>
              </div>
            </div>
            <div v-else class="sku-empty"><span>未选择本地 SKU</span><small>请绑定到对应规格，避免使用错误成本</small></div>
          </template>
        </el-table-column>
        <el-table-column label="销量 / 销售额" width="148" align="right">
          <template #default="{ row }"><div class="sales-numbers"><b>{{ row.quantity || 0 }}</b><small>{{ money(row.sales_amount) }}</small></div></template>
        </el-table-column>
        <el-table-column label="操作" width="140" fixed="right" align="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openBindDialog(row)">{{ row.mapped ? '更换' : '绑定' }}</el-button>
            <el-button v-if="row.mapped" link type="danger" @click="unbind(row)">解绑</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="!loading && !filteredProducts.length" class="binding-empty">
        {{ search || platformFilter ? '没有符合条件的商品' : '暂无平台商品数据，请先在「数据导入」导入团购/外卖营业数据' }}
      </div>
    </section>

    <!-- 绑定对话框 -->
    <el-dialog v-model="dialogVisible" :title="`选择本地 SKU`" width="600px" align-center class="binding-dialog">
      <div v-if="current" class="bind-target">
        <span>要关联的平台商品</span>
        <b>{{ current.product_name }}</b>
        <small>{{ current.platform }} · 请选择名称、规格和做法都匹配的本地 SKU</small>
      </div>
      <el-form label-position="top">
        <el-form-item label="本地标准菜品 SKU">
          <el-select v-model="selectedMenuId" filterable clearable :teleported="false" placeholder="输入菜品名、规格或做法，例如：烧鹅 上庄" style="width:100%;">
            <el-option v-for="m in menuOptions" :key="m.id" :label="menuLabel(m)" :value="m.id">
              <div class="menu-option sku-option">
                <div><b>{{ m.sku_label }}</b><em>{{ m.category || '未分类' }}</em></div>
                <small>{{ m.sku_price_summary }}<span>成本 {{ money(m.cost) }}</span></small>
              </div>
            </el-option>
          </el-select>
        </el-form-item>
      </el-form>
      <div v-if="selectedMenu" class="selection-preview">
        <span>将要绑定到</span><b>{{ selectedMenu.sku_label }}</b><small>{{ selectedMenu.sku_price_summary }} · 单位成本 {{ money(selectedMenu.cost) }}</small>
      </div>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" :disabled="!selectedMenuId" @click="saveBinding">确认绑定</el-button>
      </template>
    </el-dialog>

    <!-- 批量绑定对话框 -->
    <el-dialog v-model="batchDialogVisible" title="批量绑定本地 SKU" width="600px" align-center class="binding-dialog">
      <div v-if="selectedRows.length" class="bind-target">
        <span>将以下 {{ selectedRows.length }} 个商品统一关联到同一个本地菜品</span>
        <div class="batch-names">{{ selectedNamesText }}</div>
      </div>
      <el-form label-position="top">
        <el-form-item label="选择统一关联的本地 SKU">
          <el-select v-model="batchMenuId" filterable clearable :teleported="false" placeholder="输入菜品名、规格或做法" style="width:100%;">
            <el-option v-for="m in menuOptions" :key="m.id" :label="menuLabel(m)" :value="m.id">
              <div class="menu-option sku-option">
                <div><b>{{ m.sku_label }}</b><em>{{ m.category || '未分类' }}</em></div>
                <small>{{ m.sku_price_summary }}<span>成本 {{ money(m.cost) }}</span></small>
              </div>
            </el-option>
          </el-select>
        </el-form-item>
      </el-form>
      <div v-if="batchSelectedMenu" class="selection-preview">
        <span>全部商品将绑定到</span><b>{{ batchSelectedMenu.sku_label }}</b><small>{{ batchSelectedMenu.sku_price_summary }} · 单位成本 {{ money(batchSelectedMenu.cost) }}</small>
      </div>
      <template #footer>
        <el-button @click="batchDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="batchSaving" :disabled="!batchMenuId" @click="saveBatch">确认批量绑定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  getBusinessProductMappings,
  saveBusinessProductMapping,
  batchSaveBusinessProductMappings,
  deleteBusinessProductMapping,
  autoBindBusinessProductMappings,
} from '@/api'

const route = useRoute()
const groupPlatforms = ['美团团购', '抖音团购', '免费试']
const deliveryPlatforms = ['美团外卖', '淘宝闪购', '京东外卖']

const isGroupBuy = computed(() => (route.meta.analysisScope || 'group-buy') === 'group-buy')
const scope = computed(() => isGroupBuy.value ? 'group-buy' : 'delivery')
const platforms = computed(() => isGroupBuy.value ? groupPlatforms : deliveryPlatforms)

const products = ref([])
const menuItems = ref([])
const loading = ref(false)
const saving = ref(false)
const autoBinding = ref(false)
const search = ref('')
const platformFilter = ref('')
const mappedFilter = ref('')
const dialogVisible = ref(false)
const current = ref(null)
const selectedMenuId = ref(null)
const selectedRows = ref([])
const batchDialogVisible = ref(false)
const batchMenuId = ref(null)
const batchSaving = ref(false)

const filteredProducts = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  return products.value.filter(p => {
    if (platformFilter.value && p.platform !== platformFilter.value) return false
    if (mappedFilter.value === 'bound' && !p.mapped) return false
    if (mappedFilter.value === 'unbound' && p.mapped) return false
    if (keyword && !String(p.product_name || '').toLowerCase().includes(keyword)) return false
    return true
  })
})
const totalProducts = computed(() => products.value.length)
const mappedCount = computed(() => products.value.filter(p => p.mapped).length)
const unmappedCount = computed(() => totalProducts.value - mappedCount.value)
const bindingRate = computed(() => totalProducts.value ? Math.round(mappedCount.value / totalProducts.value * 100) : 0)
const menuOptions = computed(() => [...menuItems.value].sort((a, b) => String(a.sku_label || a.name).localeCompare(String(b.sku_label || b.name), 'zh-CN')))
const selectedMenu = computed(() => menuItems.value.find(item => item.id === selectedMenuId.value) || null)
const batchSelectedMenu = computed(() => menuItems.value.find(item => item.id === batchMenuId.value) || null)
const selectedNamesText = computed(() => {
  const names = selectedRows.value.map(r => r.product_name)
  return names.length > 6 ? `${names.slice(0, 6).join('、')} 等 ${names.length} 个` : names.join('、')
})

function money(value) { return `¥${Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` }
function menuLabel(m) {
  // label 同时用于 Element Plus 的搜索：规格、做法、价格和分类都可检索。
  return [m.sku_label || m.name, m.category, m.sku_price_summary, `成本 ${money(m.cost)}`].filter(Boolean).join(' · ')
}

function openBindDialog(row) {
  current.value = row
  selectedMenuId.value = row.menu_item_id || null
  dialogVisible.value = true
}

async function saveBinding() {
  if (!selectedMenuId.value || !current.value) return
  saving.value = true
  try {
    await saveBusinessProductMapping({
      scope: scope.value,
      platform: current.value.platform,
      external_product_name: current.value.product_name,
      menu_item_id: selectedMenuId.value,
    })
    dialogVisible.value = false
    ElMessage.success(`已绑定：${current.value.product_name}`)
    await loadData()
  } catch (error) {
    ElMessage.error('绑定失败：' + error.message)
  } finally {
    saving.value = false
  }
}

async function unbind(row) {
  try {
    await ElMessageBox.confirm(
      `确定解绑「${row.product_name}」与本地菜品「${row.menu_name}」的关联吗？解绑后将不再抓取该商品成本。`,
      '解绑确认',
      { confirmButtonText: '解绑', cancelButtonText: '取消', type: 'warning' }
    )
  } catch { return }
  try {
    await deleteBusinessProductMapping(row.mapping_id)
    ElMessage.success('已解绑')
    await loadData()
  } catch (error) {
    ElMessage.error('解绑失败：' + error.message)
  }
}

async function loadData() {
  loading.value = true
  try {
    const res = await getBusinessProductMappings(scope.value)
    products.value = res.products || []
    menuItems.value = res.menu_items || []
  } catch (error) {
    ElMessage.error('加载失败：' + error.message)
  } finally {
    loading.value = false
  }
}

function onSelectionChange(rows) {
  selectedRows.value = rows
}

function openBatchDialog() {
  if (!selectedRows.value.length) return
  batchMenuId.value = null
  batchDialogVisible.value = true
}

async function saveBatch() {
  if (!batchMenuId.value || !selectedRows.value.length) return
  batchSaving.value = true
  try {
    const res = await batchSaveBusinessProductMappings({
      scope: scope.value,
      items: selectedRows.value.map(r => ({ platform: r.platform, product_name: r.product_name })),
      menu_item_id: batchMenuId.value,
    })
    ElMessage.success(`已批量绑定 ${res.bound} 个商品`)
    batchDialogVisible.value = false
    selectedRows.value = []
    await loadData()
  } catch (error) {
    ElMessage.error('批量绑定失败：' + error.message)
  } finally {
    batchSaving.value = false
  }
}

async function autoBind() {
  if (autoBinding.value) return
  try {
    await ElMessageBox.confirm(
      `自动把「未绑定」的${isGroupBuy.value ? '团购' : '外卖'}平台商品按名称匹配本地菜品；同名多个本地菜品（无法区分规格）时自动跳过，避免误绑。继续吗？`,
      '一键绑定',
      { confirmButtonText: '开始绑定', cancelButtonText: '取消', type: 'info' }
    )
  } catch { return }
  autoBinding.value = true
  try {
    const res = await autoBindBusinessProductMappings(scope.value)
    const reasonText = [
      res.reasons?.no_name_match ? `无同名本地菜品 ${res.reasons.no_name_match} 个` : '',
      res.reasons?.ambiguous_name ? `同名多规格 ${res.reasons.ambiguous_name} 个` : '',
    ].filter(Boolean).join('；')
    ElMessage.success(`一键绑定完成：成功 ${res.bound} 个，跳过 ${res.skipped} 个${reasonText ? `（${reasonText}）` : ''}`)
    await loadData()
  } catch (error) {
    ElMessage.error('一键绑定失败：' + error.message)
  } finally {
    autoBinding.value = false
  }
}

onMounted(loadData)
</script>

<style scoped>
.binding-page {
  color: #1f2937;
}
.binding-hero {
  position: relative;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 28px;
  min-height: 140px;
  margin-bottom: 16px;
  padding: 24px 28px;
  overflow: hidden;
  border-radius: 18px;
  color: #fff;
  background:
    radial-gradient(circle at 82% 0%, rgba(159, 187, 255, .3), transparent 34%),
    linear-gradient(125deg, #182b62, #3156b5 60%, #4f7cff);
  box-shadow: 0 18px 40px rgba(34, 66, 150, .16);
}
.binding-eyebrow {
  color: #abc2ff;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: .2em;
}
.binding-hero-copy h2 { margin: 7px 0 5px; font-size: 26px; }
.binding-hero-copy p { max-width: 560px; margin: 0; color: rgba(255, 255, 255, .7); font-size: 13px; line-height: 1.6; }
.binding-hero-metrics { display: flex; align-items: stretch; gap: 10px; }
.binding-hero-metrics > div {
  min-width: 86px;
  padding: 10px 12px;
  border: 1px solid rgba(255, 255, 255, .15);
  border-radius: 11px;
  background: rgba(255, 255, 255, .08);
}
.binding-hero-metrics strong, .binding-hero-metrics span { display: block; }
.binding-hero-metrics strong { font-size: 20px; font-variant-numeric: tabular-nums; }
.binding-hero-metrics strong.warn { color: #ffd083; }
.binding-hero-metrics span { margin-top: 3px; color: rgba(255, 255, 255, .65); font-size: 11px; }
.hero-bind-btn {
  display: inline-flex;
  align-items: center;
  align-self: center;
  height: 32px;
  padding: 0 14px;
  border: 1px solid rgba(255, 255, 255, .4);
  border-radius: 9px;
  background: rgba(255, 255, 255, .14);
  color: #fff;
  cursor: pointer;
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
  transition: background .15s ease, border-color .15s ease;
}
.hero-bind-btn:hover:not(:disabled) { background: rgba(255, 255, 255, .26); border-color: rgba(255, 255, 255, .7); }
.hero-bind-btn:disabled { cursor: default; opacity: .65; }
.binding-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
  padding: 14px 16px;
  border: 1px solid #e7eaf0;
  border-radius: 14px;
  background: #fff;
  box-shadow: 0 6px 18px rgba(27, 39, 67, .04);
}
.platform-select { width: 170px; }
.search-input { width: 240px; }
.binding-hint { margin-left: auto; color: #98a2b1; font-size: 12px; }
.binding-panel {
  overflow: hidden;
  border: 1px solid #e7eaf0;
  border-radius: 16px;
  background: #fff;
  box-shadow: 0 10px 28px rgba(27, 39, 67, .055);
}
.binding-table th.el-table__cell {
  height: 46px;
  background: #fafbfc !important;
  color: #717c8e;
  font-size: 12px;
  font-weight: 650;
}
.binding-table td.el-table__cell { height: 58px; border-bottom-color: #f0f2f5; }
.binding-table .el-table__row:hover > td.el-table__cell { background: #f8faff !important; }
.platform-chip {
  display: inline-block;
  padding: 4px 9px;
  border-radius: 13px;
  background: #eef2fb;
  color: #4568d0;
  font-size: 11px;
  font-weight: 600;
}
.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border-radius: 15px;
  font-size: 11px;
  font-weight: 600;
}
.status-pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.status-pill.on { color: #208b69; background: #e9f8f3; }
.status-pill.off { color: #8b95a4; background: #f0f2f5; }
.mapped-dish b, .mapped-dish small { display: block; }
.mapped-dish b { color: #344054; font-size: 13px; }
.mapped-dish small { margin-top: 3px; color: #8f99a9; font-size: 11px; }
.muted { color: #c0c6cf; }
.profit { font-weight: 700; font-variant-numeric: tabular-nums; }
.profit.good { color: #1f9d75; }
.profit.bad { color: #dd5b58; }
.binding-empty { padding: 54px 20px; color: #9aa3b1; text-align: center; }
.bind-target {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-bottom: 16px;
  padding: 13px 14px;
  border: 1px solid #e7eaf0;
  border-radius: 11px;
  background: #f8f9fb;
}
.bind-target span { color: #7e899a; font-size: 11px; }
.bind-target b { color: #344054; font-size: 15px; }
.bind-target small { color: #8f99a9; font-size: 11px; }
.batch-names { max-height: 90px; margin-top: 6px; overflow-y: auto; color: #4568d0; font-size: 12px; line-height: 1.7; }
.menu-option b, .menu-option small { display: block; }
.menu-option small { margin-top: 2px; color: #8f99a9; font-size: 11px; }
.menu-option .spec-em { color: #4568d0; font-weight: 700; }
.binding-hero-side { display: flex; align-items: center; gap: 18px; }
.mapping-progress {
  width: 182px;
  padding: 11px 13px;
  border: 1px solid rgba(255, 255, 255, .18);
  border-radius: 12px;
  background: rgba(9, 22, 72, .16);
}
.mapping-progress-top { display: flex; justify-content: space-between; color: rgba(255, 255, 255, .78); font-size: 11px; }
.mapping-progress-top b { color: #fff; font-size: 14px; }
.progress-track { height: 6px; margin: 8px 0 6px; overflow: hidden; border-radius: 99px; background: rgba(255, 255, 255, .2); }
.progress-track i { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #85e8d5, #e4fdb8); transition: width .25s ease; }
.mapping-progress small { color: rgba(255, 255, 255, .62); font-size: 10px; }
.mapping-summary {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 14px;
}
.summary-card {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 142px;
  padding: 10px 12px;
  border: 1px solid #e7eaf0;
  border-radius: 12px;
  background: #fff;
}
.summary-icon { display: grid; width: 25px; height: 25px; place-items: center; border-radius: 8px; font-size: 13px; font-weight: 800; }
.summary-icon.blue { color: #3868d8; background: #ebf1ff; }
.summary-icon.green { color: #168567; background: #e8f8f2; }
.summary-icon.amber { color: #b86e15; background: #fff5df; }
.summary-card b, .summary-card small { display: block; }
.summary-card b { color: #26374d; font-size: 16px; line-height: 1.05; }
.summary-card small { margin-top: 3px; color: #8a96a7; font-size: 10px; }
.mapping-summary > p { margin: 0 0 0 auto; color: #8090a4; font-size: 12px; }
.external-product b, .external-product small { display: block; }
.external-product b { color: #2e3c52; font-size: 13px; }
.external-product small { margin-top: 4px; color: #98a3b3; font-size: 11px; }
.sku-card { min-width: 240px; padding: 8px 10px; border: 1px solid #dce7ff; border-radius: 9px; background: linear-gradient(105deg, #f8fbff, #f2f7ff); }
.sku-card-title { display: flex; align-items: center; gap: 7px; }
.sku-card-title i { flex: none; padding: 2px 5px; border-radius: 4px; background: #dce9ff; color: #4572cf; font-size: 9px; font-style: normal; font-weight: 700; letter-spacing: .04em; }
.sku-card-title b { color: #26426f; font-size: 12px; line-height: 1.35; }
.sku-card-meta { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 5px; }
.sku-card-meta span { color: #70819a; font-size: 10px; }
.sku-card-meta span + span::before { margin-right: 5px; color: #c4cfdd; content: '·'; }
.sku-empty { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border: 1px dashed #dbe1ea; border-radius: 9px; color: #8e99a9; }
.sku-empty span { color: #778497; font-size: 12px; }
.sku-empty small { color: #aab3c0; font-size: 10px; }
.sales-numbers b, .sales-numbers small { display: block; font-variant-numeric: tabular-nums; }
.sales-numbers b { color: #31415a; font-size: 13px; }
.sales-numbers small { margin-top: 4px; color: #8a97a8; font-size: 11px; }
.binding-table td.el-table__cell { height: 70px; }
.selection-preview { display: flex; flex-direction: column; gap: 3px; margin-top: 4px; padding: 11px 13px; border: 1px solid #cfe0ff; border-radius: 10px; background: #f4f8ff; }
.selection-preview span { color: #71809a; font-size: 10px; }
.selection-preview b { color: #2b4c7f; font-size: 13px; }
.selection-preview small { color: #7488a5; font-size: 11px; }
.sku-option { min-width: 420px; padding: 3px 0; }
.sku-option > div { display: flex; align-items: center; gap: 7px; }
.sku-option b { color: #263b5d; font-size: 12px; }
.sku-option em { padding: 1px 5px; border-radius: 4px; background: #f0f3f8; color: #8491a3; font-size: 10px; font-style: normal; }
.sku-option small { display: flex; justify-content: space-between; gap: 18px; color: #75849a; font-size: 10px; }
.sku-option small span { color: #a06a25; }
@media (max-width: 980px) {
  .binding-hero, .binding-hero-side { flex-direction: column; align-items: flex-start; }
  .mapping-summary { flex-wrap: wrap; }
  .mapping-summary > p { margin-left: 0; width: 100%; }
  .binding-toolbar { flex-wrap: wrap; }
  .binding-hint { margin-left: 0; width: 100%; }
}
</style>
