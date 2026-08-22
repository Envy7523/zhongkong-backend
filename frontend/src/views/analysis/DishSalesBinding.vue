<template>
  <div class="binding-page">
    <!-- 顶部横幅 -->
    <section class="binding-hero">
      <div class="binding-hero-copy">
        <span class="binding-eyebrow">DISH SKU MAPPING</span>
        <h2>堂食菜品绑定</h2>
        <p>按“菜品名 + 规格 + 做法”选择本地 SKU。上庄、下庄、半只等不同售价规格会分别展示，避免绑定到错误成本。</p>
      </div>
      <div class="binding-hero-metrics">
        <div><strong>{{ totalCount }}</strong><span>堂食菜品</span></div>
        <div><strong>{{ mappedCount }}</strong><span>已绑定</span></div>
        <div><strong class="warn">{{ unmappedCount }}</strong><span>待绑定</span></div>
        <button type="button" class="hero-bind-btn" :disabled="autoBinding" @click="autoBind">
          {{ autoBinding ? '绑定中…' : '⚡ 一键绑定' }}
        </button>
      </div>
    </section>

    <!-- 工具栏 -->
    <section class="binding-toolbar">
      <el-input v-model="search" clearable placeholder="搜索菜品名称 / 编码" class="search-input" @keyup.enter="loadData" @clear="loadData" />
      <el-select v-model="mappedFilter" style="width:120px;" @change="page = 1; loadData()">
        <el-option label="全部状态" value="" />
        <el-option label="未绑定" value="unbound" />
        <el-option label="已绑定" value="bound" />
      </el-select>
      <el-button type="primary" plain @click="loadData">查询</el-button>
      <el-button v-if="selectedRows.length" type="primary" plain @click="openBatchDialog">批量绑定 {{ selectedRows.length }} 个 SKU</el-button>
      <span class="binding-hint">请确认销售规格与本地 SKU 的规格一致</span>
    </section>

    <!-- 菜品表格 -->
    <section class="binding-panel">
      <el-table v-loading="loading" :data="items" class="binding-table" row-key="product_code" @selection-change="onSelectionChange">
        <el-table-column type="selection" width="46" :selectable="row => !row.mapped" />
        <el-table-column prop="product_code" label="菜品编码" width="120" show-overflow-tooltip />
        <el-table-column label="销售菜品" min-width="205">
          <template #default="{ row }"><div class="sales-dish"><b>{{ row.product_name }}</b><small>销售规格：{{ row.spec && row.spec !== '--' ? row.spec : '无' }}</small></div></template>
        </el-table-column>
        <el-table-column label="规格" min-width="80">
          <template #default="{ row }">{{ row.spec && row.spec !== '--' ? row.spec : '—' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90" align="center">
          <template #default="{ row }">
            <span :class="['status-pill', row.mapped ? 'on' : 'off']">{{ row.mapped ? '已绑定' : '未绑定' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="对应本地 SKU（菜品名 · 规格 · 做法）" min-width="330">
          <template #default="{ row }">
            <div v-if="row.mapped" class="mapped-dish sku-card">
              <div class="sku-card-title"><i>本地 SKU</i><b>{{ row.menu_sku_label || row.menu_name }}</b></div>
              <div class="sku-card-meta"><span>{{ row.menu_category || '未分类' }}</span><span>{{ row.menu_sku_price_summary || '价格未设置' }}</span><span>成本 {{ money(row.unit_cost) }}</span></div>
            </div>
            <div v-else class="sku-empty"><span>未选择本地 SKU</span><small>请选择对应规格后再绑定</small></div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="140" fixed="right" align="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openBindDialog(row)">{{ row.mapped ? '更换' : '绑定' }}</el-button>
            <el-button v-if="row.mapped" link type="danger" @click="unbind(row)">解绑</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="!loading && !items.length" class="binding-empty">
        {{ search ? '没有符合条件的菜品' : '暂无菜品销售数据，请先导入菜品销售明细' }}
      </div>
      <footer v-if="total > 0" class="binding-footer">
        <span>共 {{ total }} 个菜品</span>
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :page-sizes="[10, 20, 50]"
          :total="total"
          layout="total, sizes, prev, pager, next"
          background
          @current-change="loadData"
          @size-change="page = 1; loadData()"
        />
      </footer>
    </section>

    <!-- 绑定对话框 -->
    <el-dialog v-model="dialogVisible" title="选择本地 SKU" width="600px" align-center class="binding-dialog">
      <div v-if="current" class="bind-target">
        <span>要关联的堂食销售 SKU</span>
        <b>{{ current.product_name }}</b>
        <small>{{ current.product_code }} · 销售规格：{{ current.spec && current.spec !== '--' ? current.spec : '无' }}</small>
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
      <div v-if="selectedMenu" class="selection-preview"><span>将要绑定到</span><b>{{ selectedMenu.sku_label }}</b><small>{{ selectedMenu.sku_price_summary }} · 单位成本 {{ money(selectedMenu.cost) }}</small></div>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" :disabled="!selectedMenuId" @click="saveBinding">确认绑定</el-button>
      </template>
    </el-dialog>

    <!-- 批量绑定对话框 -->
    <el-dialog v-model="batchDialogVisible" title="批量绑定本地 SKU" width="600px" align-center class="binding-dialog">
      <div v-if="selectedRows.length" class="bind-target">
        <span>将以下 {{ selectedRows.length }} 个菜品统一关联到同一个本地菜品</span>
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
      <div v-if="batchSelectedMenu" class="selection-preview"><span>全部菜品将绑定到</span><b>{{ batchSelectedMenu.sku_label }}</b><small>{{ batchSelectedMenu.sku_price_summary }} · 单位成本 {{ money(batchSelectedMenu.cost) }}</small></div>
      <template #footer>
        <el-button @click="batchDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="batchSaving" :disabled="!batchMenuId" @click="saveBatch">确认批量绑定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { getDishSalesMappings, saveDishSalesMapping, batchSaveDishSalesMappings, deleteDishSalesMapping, autoBindDishSalesMappings } from '@/api'

const items = ref([])
const menuItems = ref([])
const loading = ref(false)
const saving = ref(false)
const autoBinding = ref(false)
const search = ref('')
const mappedFilter = ref('')
const page = ref(1)
const pageSize = ref(20)
const total = ref(0)
const dialogVisible = ref(false)
const current = ref(null)
const selectedMenuId = ref(null)
const selectedRows = ref([])
const batchDialogVisible = ref(false)
const batchMenuId = ref(null)
const batchSaving = ref(false)

const mappedCount = computed(() => items.value.filter(r => r.mapped).length)
const totalCount = computed(() => total.value)
const unmappedCount = computed(() => total.value - mappedCount.value)
const menuOptions = computed(() => [...menuItems.value].sort((a, b) => String(a.sku_label || a.name).localeCompare(String(b.sku_label || b.name), 'zh-CN')))
const selectedMenu = computed(() => menuItems.value.find(item => item.id === selectedMenuId.value) || null)
const batchSelectedMenu = computed(() => menuItems.value.find(item => item.id === batchMenuId.value) || null)
const selectedNamesText = computed(() => {
  const names = selectedRows.value.map(r => r.product_name)
  return names.length > 6 ? `${names.slice(0, 6).join('、')} 等 ${names.length} 个` : names.join('、')
})

function money(value) { return `¥${Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` }
function menuLabel(m) {
  return [m.sku_label || m.name, m.category, m.sku_price_summary, `成本 ${money(m.cost)}`].filter(Boolean).join(' · ')
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
    const res = await batchSaveDishSalesMappings({
      items: selectedRows.value.map(r => ({ product_code: r.product_code, product_name: r.product_name, spec: r.spec })),
      menu_item_id: batchMenuId.value,
    })
    ElMessage.success(`已批量绑定 ${res.bound} 个菜品`)
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
      '自动把「未绑定」的堂食菜品按名称匹配本地菜品：同名唯一直接绑定；同名多规格（如上庄/下庄）按规格精确匹配，无法区分的一律跳过，避免误绑。继续吗？',
      '一键绑定',
      { confirmButtonText: '开始绑定', cancelButtonText: '取消', type: 'info' }
    )
  } catch { return }
  autoBinding.value = true
  try {
    const res = await autoBindDishSalesMappings()
    const reasonText = [
      res.reasons?.no_name_match ? `无同名本地菜品 ${res.reasons.no_name_match} 个` : '',
      res.reasons?.ambiguous_spec ? `同规格多候选 ${res.reasons.ambiguous_spec} 个` : '',
      res.reasons?.no_spec_among_multi ? `同名多规格且无规格信息 ${res.reasons.no_spec_among_multi} 个` : '',
    ].filter(Boolean).join('；')
    ElMessage.success(`一键绑定完成：成功 ${res.bound} 个，跳过 ${res.skipped} 个${reasonText ? `（${reasonText}）` : ''}`)
    await loadData()
  } catch (error) {
    ElMessage.error('一键绑定失败：' + error.message)
  } finally {
    autoBinding.value = false
  }
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
    await saveDishSalesMapping({
      product_code: current.value.product_code,
      product_name: current.value.product_name,
      spec: current.value.spec,
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
      `确定解绑「${row.product_name}」与本地菜品「${row.menu_name}」的关联吗？解绑后将不再抓取该菜品成本。`,
      '解绑确认',
      { confirmButtonText: '解绑', cancelButtonText: '取消', type: 'warning' }
    )
  } catch { return }
  try {
    await deleteDishSalesMapping(row.mapping_id)
    ElMessage.success('已解绑')
    await loadData()
  } catch (error) {
    ElMessage.error('解绑失败：' + error.message)
  }
}

async function loadData() {
  loading.value = true
  try {
    const res = await getDishSalesMappings({ keyword: search.value.trim() || undefined, mapped: mappedFilter.value || undefined, page: page.value, page_size: pageSize.value })
    items.value = res.items || []
    total.value = Number(res.total) || 0
    menuItems.value = res.menu_items || []
  } catch (error) {
    ElMessage.error('加载失败：' + error.message)
  } finally {
    loading.value = false
  }
}

onMounted(loadData)
</script>

<style scoped>
.binding-page { color: #1f2937; }
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
.binding-eyebrow { color: #abc2ff; font-size: 11px; font-weight: 800; letter-spacing: .2em; }
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
.search-input { width: 260px; }
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
.binding-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 10px 18px;
  border-top: 1px solid #edf0f4;
  background: #fafbfc;
  color: #7f8999;
  font-size: 12px;
}
.binding-footer :deep(.el-pagination) { --el-pagination-font-size: 12px; }
.binding-footer :deep(.el-pagination.is-background .btn-prev),
.binding-footer :deep(.el-pagination.is-background .btn-next),
.binding-footer :deep(.el-pagination.is-background .el-pager li) { border-radius: 7px; }
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
.sales-dish b, .sales-dish small { display: block; }
.sales-dish b { color: #2e3c52; font-size: 13px; }
.sales-dish small { margin-top: 4px; color: #8b99ab; font-size: 11px; }
.sku-card { min-width: 235px; padding: 8px 10px; border: 1px solid #dce7ff; border-radius: 9px; background: linear-gradient(105deg, #f8fbff, #f2f7ff); }
.sku-card-title { display: flex; align-items: center; gap: 7px; }
.sku-card-title i { flex: none; padding: 2px 5px; border-radius: 4px; background: #dce9ff; color: #4572cf; font-size: 9px; font-style: normal; font-weight: 700; letter-spacing: .04em; }
.sku-card-title b { color: #26426f; font-size: 12px; line-height: 1.35; }
.sku-card-meta { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 5px; }
.sku-card-meta span { color: #70819a; font-size: 10px; }
.sku-card-meta span + span::before { margin-right: 5px; color: #c4cfdd; content: '·'; }
.sku-empty { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border: 1px dashed #dbe1ea; border-radius: 9px; color: #8e99a9; }
.sku-empty span { color: #778497; font-size: 12px; }
.sku-empty small { color: #aab3c0; font-size: 10px; }
.binding-table td.el-table__cell { height: 68px; }
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
  .binding-hero { flex-direction: column; }
  .binding-toolbar { flex-wrap: wrap; }
  .binding-hint { margin-left: 0; width: 100%; }
  .binding-footer { align-items: flex-start; flex-direction: column; }
}
</style>
