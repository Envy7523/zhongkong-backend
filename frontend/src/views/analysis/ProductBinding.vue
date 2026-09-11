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
      <div class="binding-kpi-card"><span class="summary-icon blue">⌘</span><div><b>{{ totalProducts }}</b><small>平台商品 SKU</small></div></div>
      <div class="binding-kpi-card"><span class="summary-icon green">✓</span><div><b>{{ mappedCount }}</b><small>已完成关联</small></div></div>
      <div class="binding-kpi-card"><span class="summary-icon amber">!</span><div><b>{{ unmappedCount }}</b><small>待选择本地 SKU</small></div></div>
      <p><i>成本核算</i>关联后按对应本地 SKU 自动抓取成本与毛利</p>
    </section>

    <!-- 工具栏 -->
    <section class="binding-toolbar">
      <div class="binding-platform-tabs" role="tablist" aria-label="来源平台筛选">
        <button type="button" :class="{ active: !platformFilter }" @click="setPlatformFilter('')">全部平台</button>
        <button v-for="p in platforms" :key="p" type="button" :class="{ active: platformFilter === p }" @click="setPlatformFilter(p)">{{ p }}</button>
      </div>
      <el-input v-model="search" clearable placeholder="搜索第三方商品名称" class="search-input" />
      <el-select v-model="mappedFilter" style="width:120px;">
        <el-option label="全部状态" value="" />
        <el-option label="未绑定" value="unbound" />
        <el-option label="已绑定" value="bound" />
      </el-select>
      <el-button v-if="selectedRows.length" type="primary" plain @click="openBatchDialog">批量绑定 {{ selectedRows.length }} 个 SKU</el-button>
      <el-button v-if="!isGroupBuy" type="primary" plain @click="openSpecDialog">规格拆分配置（美团 / 淘宝）</el-button>
      <span class="binding-hint">请确认左侧商品与右侧本地 SKU 的规格一致</span>
    </section>

    <!-- 商品表格 -->
    <section class="binding-panel">
      <el-table v-loading="loading" :data="pagedProducts" class="binding-table" :row-key="rowKey" reserve-selection @selection-change="onSelectionChange">
        <el-table-column type="selection" width="46" :selectable="row => !row.mapped" />
        <el-table-column prop="platform" label="来源平台" width="116">
          <template #default="{ row }"><span :class="['platform-chip', platformChipClass(row.platform)]">{{ row.platform }}</span></template>
        </el-table-column>
        <el-table-column v-if="isGroupBuy" label="平台ID（商品/套餐/项目）" min-width="170">
          <template #default="{ row }">
            <span :title="platformIdFull(row)" :class="['pid-cell', row.platform_product_id || row.platform_product_ids?.length ? '' : 'pid-empty']">{{ platformIdText(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="第三方商品" min-width="220">
          <template #default="{ row }">
            <div class="external-product">
              <b>{{ row.product_name }}</b>
              <small>平台侧商品名称</small>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="关联方式" width="108" align="center">
          <template #default="{ row }">
            <span :class="['status-pill', row.binding_mode === 'spec' ? 'spec' : (row.mapped ? 'on' : 'off')]">{{ bindingModeLabel(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="对应本地 SKU（菜品名 · 规格 · 做法）" min-width="350">
          <template #default="{ row }">
            <div v-if="row.binding_mode === 'spec'" class="spec-sku-card">
              <div class="sku-card-title"><i>规格拆分</i><b>{{ row.spec_link_count || row.spec_links?.length || 0 }} 个本地规格 SKU</b></div>
              <div class="spec-sku-list">
                <span v-for="link in row.spec_links || []" :key="`${link.menu_item_id}-${link.platform_price}`">
                  {{ specLinkLabel(link) }} <em>售价 {{ money(link.platform_price) }}</em><em>成本 {{ money(link.unit_cost) }}</em>
                </span>
              </div>
              <div :class="['spec-resolution', row.spec_unresolved_qty ? 'warning' : 'exact']">
                <template v-if="row.spec_unresolved_qty">
                  {{ row.spec_unresolved_qty }} 份无法唯一识别，暂不计成本{{ row.spec_unresolved_reasons?.[0] ? `：${row.spec_unresolved_reasons[0]}` : '' }}
                </template>
                <template v-else-if="row.spec_combination_qty">
                  {{ row.spec_unit_price_qty ? '部分单价命中；' : '' }}{{ row.spec_combination_qty }} 份由唯一售价组合识别
                </template>
                <template v-else>全部按平台售价精确识别规格</template>
              </div>
            </div>
            <div v-else-if="row.mapped" class="mapped-dish sku-card">
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
        <el-table-column label="操作" width="220" fixed="right" align="right">
          <template #default="{ row }">
            <template v-if="row.binding_mode === 'spec'">
              <el-button link type="primary" @click="openSpecDialog(row.product_name, row.platform)">编辑规格</el-button>
              <el-button link type="primary" @click="openBindDialog(row)">改为单品</el-button>
              <el-button link type="danger" @click="clearSpec(row)">取消拆分</el-button>
            </template>
            <template v-else>
              <el-button link type="primary" @click="openBindDialog(row)">{{ row.mapped ? '更换' : '绑定单品' }}</el-button>
              <el-button v-if="['美团外卖', '淘宝闪购'].includes(row.platform)" link type="primary" @click="openSpecDialog(row.product_name, row.platform)">规格拆分</el-button>
              <el-button v-if="row.mapped" link type="danger" @click="unbind(row)">解绑</el-button>
            </template>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="filteredProducts.length" class="binding-pagination">
        <span>共 {{ filteredProducts.length }} 个平台商品 · 每页 {{ productPageSize }} 条（已勾选 {{ selectedRows.length }} 个）</span>
        <el-pagination
          v-model:current-page="productPage"
          background
          small
          layout="prev, pager, next, jumper"
          :page-size="productPageSize"
          :total="filteredProducts.length"
        />
      </div>
      <div v-if="!loading && !filteredProducts.length" class="binding-empty">
        {{ search || platformFilter ? '没有符合条件的商品' : '暂无平台商品数据，请先在「数据导入」导入团购/外卖营业数据' }}
      </div>
    </section>

    <!-- 绑定对话框 -->
    <el-dialog v-model="dialogVisible" :title="`选择本地 SKU`" width="600px" align-center class="binding-dialog">
      <div v-if="current" class="bind-target">
        <span>要关联的平台商品</span>
        <b>{{ current.product_name }}</b>
        <small>{{ current.platform }} · 单品绑定会将该平台商品的全部销量、销售额统一计入一个本地 SKU</small>
      </div>
      <el-form label-position="top">
        <el-form-item label="本地标准菜品 SKU">
          <div class="menu-picker-tools"><el-select v-model="menuCategoryFilter" clearable placeholder="全部分类" class="menu-category-filter"><el-option v-for="category in menuCategories" :key="category" :label="category" :value="category" /></el-select><small>支持搜索菜品名、规格、做法；结果虚拟滚动，不需要翻长列表</small></div>
          <el-select v-model="selectedMenuId" filterable clearable placeholder="搜索，例如：烧鹅 上庄" style="width:100%;">
            <el-option v-for="menu in bindingMenuOptions" :key="menu.value" :label="menu.label" :value="menu.value" />
          </el-select>
        </el-form-item>
      </el-form>
      <div v-if="selectedMenu" class="selection-preview">
        <span>将要绑定到</span><b>{{ selectedMenu.sku_label }}</b><small>{{ selectedMenu.sku_price_summary }} · 单位成本 {{ money(selectedMenu.cost) }}</small>
      </div>
      <div v-if="['美团外卖', '淘宝闪购'].includes(current?.platform)" class="bind-mode-note">若该平台商品混合了上庄、下庄、半只等多个规格，请改用“规格拆分”；系统会按销量、销售额和各规格平台售价反解数量。淘宝闪购多解时会要求按门店、日期人工确认，不会猜测。</div>
      <template #footer>
        <el-button v-if="['美团外卖', '淘宝闪购'].includes(current?.platform)" @click="dialogVisible = false; openSpecDialog(current.product_name, current.platform)">改用规格拆分</el-button>
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
          <div class="menu-picker-tools"><el-select v-model="batchMenuCategoryFilter" clearable placeholder="全部分类" class="menu-category-filter"><el-option v-for="category in menuCategories" :key="category" :label="category" :value="category" /></el-select><small>先选分类，再搜索具体规格</small></div>
          <el-select v-model="batchMenuId" filterable clearable placeholder="搜索菜品名、规格或做法" style="width:100%;">
            <el-option v-for="menu in batchMenuOptions" :key="menu.value" :label="menu.label" :value="menu.value" />
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

    <!-- 规格拆分配置（平台同名合并规格 → 多个本地规格 SKU + 平台售价） -->
    <el-dialog v-model="specDialogVisible" :title="`规格拆分配置 · ${specPlatform}`" width="720px" align-center class="binding-dialog spec-dialog">
      <div class="spec-dialog-hint">平台不区分规格的同名商品，可在此配置它对应的多个本地规格 SKU 与平台售价；系统按 (销量, 销售额, 售价) 自动反解各规格数量。淘宝闪购出现多解时，需按门店、日期人工确认，绝不自动猜测。</div>
      <el-form label-position="top">
        <el-form-item label="平台">
          <el-radio-group v-model="specPlatform" :disabled="Boolean(specProductName)"><el-radio-button label="美团外卖" /><el-radio-button label="淘宝闪购" /></el-radio-group>
        </el-form-item>
        <el-form-item :label="`平台商品（${specPlatform}）`">
          <el-select v-model="specProductName" filterable clearable placeholder="选择需要规格拆分的平台商品" style="width:100%;">
            <el-option v-for="name in specProductOptions" :key="name" :label="name" :value="name" />
          </el-select>
        </el-form-item>
      </el-form>
      <template v-if="specProductName">
        <div class="menu-picker-tools spec-picker-tools"><el-select v-model="specMenuCategoryFilter" clearable placeholder="全部分类" class="menu-category-filter"><el-option v-for="category in menuCategories" :key="category" :label="category" :value="category" /></el-select><small>每一行均可搜索本地菜品 SKU，无需滚动查找</small></div>
        <div class="spec-rows">
          <div v-for="(item, index) in specRows" :key="index" class="spec-row">
            <el-select v-model="item.menu_item_id" filterable clearable placeholder="搜索本地规格 SKU" style="width:58%;">
              <el-option v-for="menu in specMenuOptions(item.menu_item_id)" :key="menu.value" :label="menu.label" :value="menu.value" />
            </el-select>
            <el-input-number v-model="item.platform_price" :min="0.01" :precision="2" :step="0.1" placeholder="平台售价" style="width:140px;" />
            <span v-if="specMenuOf(item)" class="spec-cost-preview">成本 {{ money(specMenuOf(item).cost) }}</span>
            <el-button link type="danger" :disabled="specRows.length <= 1" @click="specRows.splice(index, 1)">删除</el-button>
          </div>
          <el-button plain @click="addSpecRow">＋ 添加规格</el-button>
        </div>
      </template>
      <template #footer>
        <el-button @click="specDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="specSaving" :disabled="!specProductName" @click="saveSpec">保存规格配置</el-button>
      </template>
    </el-dialog>

    <!-- 智能匹配无法安全判定时，先由使用者校正，确认后才会一次性写入全部绑定。 -->
    <el-dialog v-model="manualBindVisible" title="人工校正菜品绑定" width="920px" align-center class="binding-dialog manual-bind-dialog" :close-on-click-modal="false" @closed="autoBinding = false">
      <div class="manual-bind-intro">
        <div><b>无风险绑定 {{ manualAutoCount }} 个 · 待确认 {{ manualBindItems.length }} 个</b><small>无法识别、没有可靠候选的菜品不会进入本次执行；未校正的项目按“本次不绑定”处理，可直接点确认执行。</small>
          <small class="manual-progress">已校正 {{ manualSelectedCount }} · 已跳过 {{ manualSkippedCount }} · 未处理 {{ manualPendingCount }}（未处理将跳过）</small></div>
        <span>第 {{ manualPage }} / {{ manualPageCount }} 页</span>
      </div>
      <el-collapse v-if="safeBindItems.length" v-model="safePreviewOpen" class="safe-bind-preview">
        <el-collapse-item name="safe">
          <template #title><b>无风险绑定菜品</b><span>已识别 {{ safeBindItems.length }} 个，确认执行后统一绑定</span></template>
          <div class="safe-bind-list">
            <div v-for="item in safeBindItems" :key="`${item.platform}-${item.product_name}`"><span>{{ item.platform }} · {{ item.product_name }}</span><b>→ {{ item.target }}</b><small>{{ item.strategy }}</small></div>
          </div>
        </el-collapse-item>
      </el-collapse>
      <el-table :data="manualPageItems" class="manual-bind-table" max-height="430">
        <el-table-column label="平台菜品" min-width="190">
          <template #default="{ row }"><b>{{ row.product_name }}</b><small>{{ row.platform }}</small></template>
        </el-table-column>
        <el-table-column label="关联菜品明细" min-width="235">
          <template #default="{ row }">
            <div class="manual-candidates">
              <span v-for="candidate in row.candidates" :key="candidate.id">{{ candidate.name }}<i>{{ candidate.spec ? `${candidate.spec} · ` : '' }}{{ candidate.category }}</i></span>
              <em v-if="!row.candidates?.length">暂无安全候选，可直接搜索本地菜品校正</em>
            </div>
            <small class="manual-reason">{{ row.reason }}</small>
          </template>
        </el-table-column>
        <el-table-column label="校正为本地 SKU" min-width="265">
          <template #default="{ row }">
            <el-popover trigger="click" placement="bottom-start" :width="390" popper-class="manual-sku-picker" :disabled="manualSelections[row.key] === 'skip'">
              <template #reference>
                <button type="button" class="manual-sku-trigger" :disabled="manualSelections[row.key] === 'skip'">
                  <template v-if="manualSelectedMenu(row)"><b>{{ manualSelectedMenu(row).name }}{{ manualSelectedMenu(row).spec ? ` · ${manualSelectedMenu(row).spec}` : '' }}</b><small>{{ manualSelectedMenu(row).category }}</small></template>
                  <template v-else><span>选择本地 SKU</span><i>⌄</i></template>
                </button>
              </template>
              <div class="manual-sku-picker-body">
                <el-input v-model="manualSearch[row.key]" clearable placeholder="搜索菜品名、规格或做法" />
                <div v-if="manualCandidatesFor(row).length && !manualSearch[row.key]" class="manual-picker-caption">优先推荐</div>
                <div class="manual-sku-options">
                  <button v-for="menu in manualMenuOptionsFor(row)" :key="menu.id" type="button" :class="{ selected: Number(manualSelections[row.key]) === menu.id, recommended: manualCandidateIds(row).includes(menu.id) }" @click="selectManualMenu(row, menu.id)">
                    <b>{{ menu.name }}{{ menu.spec ? ` · ${menu.spec}` : '' }}</b><small>{{ menu.category }}</small>
                  </button>
                  <span v-if="!manualMenuOptionsFor(row).length" class="manual-picker-empty">没有匹配的本地 SKU</span>
                </div>
              </div>
            </el-popover>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="74" align="center">
          <template #default="{ row }">
            <el-button link type="danger" :title="manualSelections[row.key] === 'skip' ? '恢复校正' : '本次不绑定'" @click="toggleManualSkip(row)">{{ manualSelections[row.key] === 'skip' ? '恢复' : '✕' }}</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="manual-bind-footer-line">
        <span>✕ 表示本次不绑定该菜品；未校正的项目将按跳过处理，可直接确认执行，后续仍可在列表中单独绑定。</span>
        <el-pagination v-if="manualBindItems.length > 10" v-model:current-page="manualPage" small background layout="prev, pager, next" :page-size="10" :total="manualBindItems.length" />
      </div>
      <template #footer>
        <el-button @click="manualBindVisible = false">取消</el-button>
        <el-button type="primary" :loading="autoBinding" @click="executeManualAutoBind">确认执行</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  getBusinessProductMappings,
  saveBusinessProductMapping,
  batchSaveBusinessProductMappings,
  deleteBusinessProductMapping,
  previewAutoBindBusinessProductMappings,
  executeAutoBindBusinessProductMappings,
  getSpecLinks,
  saveSpecLinks,
  deleteSpecLinks,
} from '@/api'

const route = useRoute()
const groupPlatforms = ['美团团购', '抖音团购']
const deliveryPlatforms = ['美团外卖', '淘宝闪购', '京东外卖']

const isGroupBuy = computed(() => (route.meta.analysisScope || 'group-buy') === 'group-buy')
const scope = computed(() => isGroupBuy.value ? 'group-buy' : 'delivery')
const platforms = computed(() => isGroupBuy.value ? groupPlatforms : deliveryPlatforms)

const products = ref([])
const menuItems = ref([])
const loading = ref(false)
const saving = ref(false)
const autoBinding = ref(false)
const manualBindVisible = ref(false)
const manualBindItems = ref([])
const safeBindItems = ref([])
const safePreviewOpen = ref([])
const manualMenuItems = ref([])
const manualSelections = ref({})
const manualSearch = ref({})
const manualAutoCount = ref(0)
const manualPage = ref(1)
const search = ref('')
const platformFilter = ref('')
const mappedFilter = ref('')
// 商品列表分页：默认每页 20 条（外卖/团购共用同一列表）
const productPage = ref(1)
const productPageSize = ref(20)
const dialogVisible = ref(false)
const current = ref(null)
const selectedMenuId = ref(null)
const menuCategoryFilter = ref('')
const selectedRows = ref([])
const batchDialogVisible = ref(false)
const batchMenuId = ref(null)
const batchMenuCategoryFilter = ref('')
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
const pagedProducts = computed(() => {
  const start = (productPage.value - 1) * productPageSize.value
  return filteredProducts.value.slice(start, start + productPageSize.value)
})
// 搜索/平台/状态筛选或切换外卖-团购视角时回到第 1 页；结果变少时自动收敛到最后一页
watch([search, platformFilter, mappedFilter, scope], () => { productPage.value = 1 })
watch(() => filteredProducts.value.length, (len) => {
  const maxPage = Math.max(1, Math.ceil(len / productPageSize.value))
  if (productPage.value > maxPage) productPage.value = maxPage
})
const totalProducts = computed(() => products.value.length)
const mappedCount = computed(() => products.value.filter(p => p.mapped).length)
const unmappedCount = computed(() => totalProducts.value - mappedCount.value)
const bindingRate = computed(() => totalProducts.value ? Math.round(mappedCount.value / totalProducts.value * 100) : 0)
const manualPageCount = computed(() => Math.max(1, Math.ceil(manualBindItems.value.length / 10)))
// 校正进度：未处理的项目不阻塞确认，直接按“本次不绑定”处理
const manualSelectedCount = computed(() => manualBindItems.value.filter(row => Number(manualSelections.value[row.key]) > 0).length)
const manualSkippedCount = computed(() => manualBindItems.value.filter(row => manualSelections.value[row.key] === 'skip').length)
const manualPendingCount = computed(() => Math.max(0, manualBindItems.value.length - manualSelectedCount.value - manualSkippedCount.value))
const manualPageItems = computed(() => manualBindItems.value.slice((manualPage.value - 1) * 10, manualPage.value * 10))
const menuOptions = computed(() => [...menuItems.value])
const menuCategories = computed(() => [...new Set(menuItems.value.map(item => String(item.category || '未分类')))])
const selectedMenu = computed(() => menuItems.value.find(item => item.id === selectedMenuId.value) || null)
const batchSelectedMenu = computed(() => menuItems.value.find(item => item.id === batchMenuId.value) || null)
const bindingMenuOptions = computed(() => buildVirtualMenuOptions(menuCategoryFilter.value, selectedMenuId.value))
const batchMenuOptions = computed(() => buildVirtualMenuOptions(batchMenuCategoryFilter.value, batchMenuId.value))
const selectedNamesText = computed(() => {
  const names = selectedRows.value.map(r => r.product_name)
  return names.length > 6 ? `${names.slice(0, 6).join('、')} 等 ${names.length} 个` : names.join('、')
})

function money(value) { return `¥${Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` }
// 表格行 key：平台+商品名唯一，避免美团/京东等跨平台同名商品行冲突导致勾选、批量绑定串台
function rowKey(row) { return `${String(row.platform || '')}|${String(row.product_name || '')}` }
const PLATFORM_CHIP = { '美团外卖': 'mt', '淘宝闪购': 'tb', '京东外卖': 'jd', '美团团购': 'mg', '抖音团购': 'dy' }
function platformChipClass(platform) { return 'chip-' + (PLATFORM_CHIP[platform] || 'other') }
function platformIdList(row) {
  const list = Array.isArray(row?.platform_product_ids) && row.platform_product_ids.length
    ? row.platform_product_ids
    : (row?.platform_product_id ? [row.platform_product_id] : [])
  return list.filter(Boolean)
}
function platformIdText(row) {
  const list = platformIdList(row)
  if (!list.length) return '—'
  if (list.length === 1) return list[0]
  return `${list[0]} 等 ${list.length} 个`
}
function platformIdFull(row) {
  const list = platformIdList(row)
  return list.length > 1 ? `该商品名对应多个平台ID：${list.join('、')}` : (list[0] || '该导出未含平台商品ID，可在有 ID 的报表导入后自动带出')
}
function bindingModeLabel(row) {
  if (row.binding_mode === 'spec') return '规格拆分'
  return row.mapped ? '单品 SKU' : '未关联'
}
function setPlatformFilter(platform) {
  platformFilter.value = platform
  selectedRows.value = []
}
function specLinkLabel(link) {
  return [link.menu_name, link.menu_spec, link.menu_method].filter(Boolean).join(' · ') || `本地 SKU #${link.menu_item_id}`
}
function menuLabel(m) {
  // label 同时用于 Element Plus 的搜索：规格、做法、价格和分类都可检索。
  return [m.sku_label || m.name, m.category, m.sku_price_summary, `成本 ${money(m.cost)}`].filter(Boolean).join(' · ')
}
function buildVirtualMenuOptions(category = '', selectedId = null) {
  const rows = menuOptions.value.filter(menu => !category || String(menu.category || '未分类') === category)
  const selected = menuItems.value.find(menu => menu.id === selectedId)
  if (selected && !rows.some(menu => menu.id === selected.id)) rows.unshift(selected)
  return rows.map(menu => ({
    value: menu.id,
    label: [menu.sku_label || menu.name, menu.category || '未分类', menu.sku_price_summary || '价格未设置', `成本 ${money(menu.cost)}`].filter(Boolean).join(' · '),
  }))
}

function openBindDialog(row) {
  current.value = row
  selectedMenuId.value = row.menu_item_id || null
  menuCategoryFilter.value = row.menu_category || ''
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

async function clearSpec(row) {
  try {
    await ElMessageBox.confirm(
      `确定取消「${row.product_name}」的规格拆分吗？只会删除规格关联，不会删除平台商品、销量或本地菜品。`,
      '取消规格拆分',
      { confirmButtonText: '取消拆分', cancelButtonText: '保留', type: 'warning' }
    )
  } catch { return }
  try {
    await deleteSpecLinks({ platform: row.platform, external_product_name: row.product_name })
    ElMessage.success('已取消规格拆分，可重新绑定单品或重新配置规格')
    await loadData()
  } catch (error) {
    ElMessage.error('取消规格拆分失败：' + error.message)
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
  batchMenuCategoryFilter.value = ''
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

// ===== 规格拆分配置（平台同名合并规格 → 多个本地规格 SKU + 平台售价） =====
const specDialogVisible = ref(false)
const specPlatform = ref('美团外卖')
const specProductName = ref('')
const specRows = ref([])
const specSaving = ref(false)
const specMenuCategoryFilter = ref('')
const specProductOptions = computed(() => {
  const names = products.value.filter(p => p.platform === specPlatform.value && p.product_name).map(p => p.product_name)
  return [...new Set(names)].sort((a, b) => a.localeCompare(b, 'zh-CN'))
})
function specMenuOf(item) {
  return menuItems.value.find(m => m.id === item.menu_item_id) || null
}
function specMenuOptions(selectedId) {
  return buildVirtualMenuOptions(specMenuCategoryFilter.value, selectedId)
}
function addSpecRow() { specRows.value.push({ menu_item_id: null, platform_price: null }) }
async function openSpecDialog(productName = '', platform = '美团外卖') {
  specPlatform.value = ['美团外卖', '淘宝闪购'].includes(platform) ? platform : '美团外卖'
  specDialogVisible.value = true
  specRows.value = []
  specMenuCategoryFilter.value = ''
  if (productName && specProductName.value === productName) {
    await loadSpecRows()
  } else {
    specProductName.value = productName
  }
}
async function loadSpecRows() {
  specRows.value = []
  if (!specProductName.value) return
  try {
    const res = await getSpecLinks({ platform: specPlatform.value, external_product_name: specProductName.value })
    specRows.value = (res.links || []).map(link => ({ menu_item_id: link.menu_item_id, platform_price: Number(link.platform_price) }))
    if (!specRows.value.length) addSpecRow()
  } catch (error) { ElMessage.error('加载规格配置失败：' + error.message) }
}
watch([specProductName, specPlatform], () => loadSpecRows())
async function saveSpec() {
  const items = specRows.value.filter(item => item.menu_item_id && Number(item.platform_price) > 0)
  if (!specProductName.value) return ElMessage.warning('请选择平台商品')
  if (!items.length) return ElMessage.warning('请至少配置一个 规格SKU + 平台售价')
  specSaving.value = true
  try {
    await saveSpecLinks({ platform: specPlatform.value, external_product_name: specProductName.value, items })
    ElMessage.success('规格拆分配置已保存（成本实时取自所选 SKU）')
    specDialogVisible.value = false
    await loadData()
  } catch (error) {
    ElMessage.error('保存失败：' + error.message)
  } finally { specSaving.value = false }
}

async function autoBind() {
  if (autoBinding.value) return
  try {
    await ElMessageBox.confirm(
      '系统会先筛出可安全匹配的菜品；名称相近、候选不唯一或跨平台绑定冲突的项目将交给您校正，确认后才会统一执行。继续吗？',
      '智能匹配未绑定商品',
      { confirmButtonText: '开始识别', cancelButtonText: '取消', type: 'info' }
    )
  } catch { return }
  autoBinding.value = true
  try {
    const preview = await previewAutoBindBusinessProductMappings(scope.value)
    manualAutoCount.value = Number(preview.auto_count || 0)
    safeBindItems.value = preview.auto_items || []
    safePreviewOpen.value = []
    manualBindItems.value = preview.manual_items || []
    manualMenuItems.value = preview.menu_items || []
    manualSelections.value = {}
    manualSearch.value = {}
    manualPage.value = 1
    if (manualBindItems.value.length) {
      manualBindVisible.value = true
      // 打开校正弹窗后立即结束 loading：确认按钮随时可点，未校正的项目按“本次不绑定”处理
      autoBinding.value = false
      return
    }
    await executeManualAutoBind()
  } catch (error) {
    ElMessage.error('智能匹配失败：' + error.message)
  } finally {
    if (!manualBindVisible.value) autoBinding.value = false
  }
}

function toggleManualSkip(row) {
  manualSelections.value = {
    ...manualSelections.value,
    [row.key]: manualSelections.value[row.key] === 'skip' ? null : 'skip',
  }
}

function manualCandidateIds(row) {
  return (row.candidates || []).map(candidate => Number(candidate.id)).filter(Boolean)
}
function manualCandidatesFor(row) {
  const ids = new Set(manualCandidateIds(row))
  return manualMenuItems.value.filter(menu => ids.has(Number(menu.id)))
}
function manualSelectedMenu(row) {
  const id = Number(manualSelections.value[row.key])
  return id ? manualMenuItems.value.find(menu => Number(menu.id) === id) : null
}
function manualMenuOptionsFor(row) {
  const keyword = String(manualSearch.value[row.key] || '').trim().toLowerCase()
  const matched = manualMenuItems.value.filter(menu => {
    const text = `${menu.name || ''} ${menu.spec || ''} ${menu.category || ''}`.toLowerCase()
    return !keyword || text.includes(keyword)
  })
  const candidates = manualCandidatesFor(row).filter(menu => !keyword || `${menu.name || ''} ${menu.spec || ''} ${menu.category || ''}`.toLowerCase().includes(keyword))
  const candidateIds = new Set(candidates.map(menu => Number(menu.id)))
  return [...candidates, ...matched.filter(menu => !candidateIds.has(Number(menu.id)))].slice(0, 12)
}
function selectManualMenu(row, menuId) {
  manualSelections.value = { ...manualSelections.value, [row.key]: Number(menuId) }
}

async function executeManualAutoBind() {
  autoBinding.value = true
  try {
    const corrections = manualBindItems.value.map(row => ({
      platform: row.platform,
      product_name: row.product_name,
      menu_item_id: Number(manualSelections.value[row.key]) || null,
    }))
    const res = await executeAutoBindBusinessProductMappings({ scope: scope.value, corrections })
    const skipped = Number(res.skipped || 0)
    ElMessage.success(`绑定已执行：智能匹配 ${res.auto_bound || 0} 个，人工校正 ${res.corrected || 0} 个${skipped ? `，本次跳过 ${skipped} 个` : ''}`)
    manualBindVisible.value = false
    await loadData()
  } catch (error) {
    ElMessage.error('确认执行失败：' + error.message)
  } finally {
    autoBinding.value = false
  }
}

const refreshMenuCategoryOrder = () => loadData()
onMounted(() => {
  window.addEventListener('menu-category-order-changed', refreshMenuCategoryOrder)
  loadData()
})
onBeforeUnmount(() => window.removeEventListener('menu-category-order-changed', refreshMenuCategoryOrder))
</script>

<style scoped>
.binding-page {
  color: #1f2937;
}
.pid-cell { font-variant-numeric: tabular-nums; font-size: 13px; }
.pid-empty { color: #9ca3af; font-size: 12px; }
.binding-hero {
  position: relative;
  display: flex;
  align-items: center;
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
.binding-platform-tabs { display: inline-flex; flex: 0 0 auto; overflow: hidden; border: 1px solid #dbe3f0; border-radius: 9px; background: #f8faff; }
.binding-platform-tabs button { height: 32px; padding: 0 14px; border: 0; border-right: 1px solid #dbe3f0; background: transparent; color: #526174; cursor: pointer; font-size: 12px; font-weight: 650; transition: background .15s ease, color .15s ease; }
.binding-platform-tabs button:last-child { border-right: 0; }
.binding-platform-tabs button:hover { background: #edf4ff; color: #2563eb; }
.binding-platform-tabs button.active { background: #2563eb; color: #fff; }
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
.platform-chip.chip-mt { background: #fff6dc; color: #a8760a; }
.platform-chip.chip-tb { background: #fff0e6; color: #d2620a; }
.platform-chip.chip-jd { background: #ffe9e7; color: #c33124; }
.platform-chip.chip-mg { background: #e5f4ff; color: #0a7dcc; }
.platform-chip.chip-dy { background: #e9e9ee; color: #33333a; }
.platform-chip.chip-other { background: #eef2fb; color: #4568d0; }
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
.status-pill.spec { color: #6e54bc; background: #f1edff; }
.mapped-dish b, .mapped-dish small { display: block; }
.mapped-dish b { color: #344054; font-size: 13px; }
.mapped-dish small { margin-top: 3px; color: #8f99a9; font-size: 11px; }
.muted { color: #c0c6cf; }
.profit { font-weight: 700; font-variant-numeric: tabular-nums; }
.profit.good { color: #1f9d75; }
.profit.bad { color: #dd5b58; }
.binding-empty { padding: 54px 20px; color: #9aa3b1; text-align: center; }
.binding-pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px 2px;
  color: #8492a6;
  font-size: 12px;
}
.binding-pagination :deep(.el-pagination) { --el-pagination-font-size: 12px; }
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
.menu-picker-tools { display: flex; align-items: center; gap: 10px; margin: 0 0 8px; }
.menu-category-filter { width: 180px; }
.menu-picker-tools small { color: #8491a4; font-size: 11px; line-height: 1.35; }
.spec-picker-tools { margin-top: -2px; }
.batch-names { max-height: 90px; margin-top: 6px; overflow-y: auto; color: #4568d0; font-size: 12px; line-height: 1.7; }
.menu-option b, .menu-option small { display: block; }
.menu-option small { margin-top: 2px; color: #8f99a9; font-size: 11px; }
.menu-option .spec-em { color: #4568d0; font-weight: 700; }
.binding-hero-side { display: flex; align-items: center; gap: 12px; }
.mapping-progress {
  width: 214px;
  padding: 10px 12px;
  border: 1px solid rgba(255, 255, 255, .2);
  border-radius: 10px;
  background: rgba(9, 22, 72, .16);
}
.mapping-progress-top { display: flex; justify-content: space-between; color: rgba(255, 255, 255, .78); font-size: 11px; }
.mapping-progress-top b { color: #fff; font-size: 14px; }
.progress-track { height: 6px; margin: 8px 0 6px; overflow: hidden; border-radius: 99px; background: rgba(255, 255, 255, .2); }
.progress-track i { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #85e8d5, #e4fdb8); transition: width .25s ease; }
.mapping-progress small { color: rgba(255, 255, 255, .62); font-size: 10px; }
:global(.app-layout.enterprise-theme) .binding-hero { min-height: 0; padding-bottom: 14px; margin-bottom: 14px; }
:global(.app-layout.enterprise-theme) .binding-hero-side { gap: 10px; }
:global(.app-layout.enterprise-theme) .mapping-progress { background: #f6f9fd; border-color: #dce7f6; }
:global(.app-layout.enterprise-theme) .mapping-progress-top { color: #64748b; }
:global(.app-layout.enterprise-theme) .mapping-progress-top b { color: #2563b8; }
:global(.app-layout.enterprise-theme) .progress-track { background: #dbe7f6; }
:global(.app-layout.enterprise-theme) .progress-track i { background: #3b82f6; }
:global(.app-layout.enterprise-theme) .mapping-progress small { color: #8b9aad; }
:global(.app-layout.enterprise-theme) .hero-bind-btn { align-self: auto; height: 34px; border-color: #bfdbfe; background: #eff6ff; color: #2563b8; }
:global(.app-layout.enterprise-theme) .hero-bind-btn:hover:not(:disabled) { border-color: #93c5fd; background: #dbeafe; }
.mapping-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(150px, 180px)) minmax(240px, 1fr);
  align-items: stretch;
  margin: 0 0 14px;
  overflow: hidden;
  border: 1px solid #e4eaf2;
  border-radius: 12px;
  background: #fff;
}
.binding-kpi-card {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 76px;
  padding: 10px 15px;
  border-right: 1px solid #e9edf3;
}
.summary-icon { display: grid; width: 25px; height: 25px; place-items: center; border-radius: 8px; font-size: 13px; font-weight: 800; }
.summary-icon.blue { color: #3868d8; background: #ebf1ff; }
.summary-icon.green { color: #168567; background: #e8f8f2; }
.summary-icon.amber { color: #b86e15; background: #fff5df; }
.binding-kpi-card b, .binding-kpi-card small { display: block; }
.binding-kpi-card b { color: #26374d; font-size: 17px; line-height: 1.05; }
.binding-kpi-card small { margin-top: 3px; color: #8a96a7; font-size: 10px; }
.binding-platform-tabs :deep(.el-radio-button__inner) { min-width: 76px; padding: 8px 12px; font-size: 12px; }
.mapping-summary > p { display: flex; align-items: center; justify-content: flex-end; gap: 7px; margin: 0; padding: 10px 16px; color: #8090a4; font-size: 12px; }
.mapping-summary > p i { padding: 3px 6px; border-radius: 4px; background: #eef5ff; color: #3e74cc; font-size: 10px; font-style: normal; font-weight: 700; }
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
.spec-sku-card { min-width: 240px; padding: 8px 10px; border: 1px solid #dfd5ff; border-radius: 9px; background: linear-gradient(105deg, #fcfaff, #f7f3ff); }
.spec-sku-card .sku-card-title i { background: #e8defe; color: #6e54bc; }
.spec-sku-list { display: flex; flex-wrap: wrap; gap: 4px 8px; margin-top: 6px; }
.spec-sku-list span { color: #5c5471; font-size: 10px; line-height: 1.45; }
.spec-sku-list em { margin-left: 4px; color: #8a72c3; font-style: normal; white-space: nowrap; }
.spec-resolution { margin-top: 6px; font-size: 10px; line-height: 1.4; }
.spec-resolution.exact { color: #218362; }
.spec-resolution.warning { color: #c37222; }
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
.bind-mode-note { margin-top: 12px; padding: 9px 11px; border-left: 3px solid #8a6ad4; border-radius: 0 8px 8px 0; background: #faf8ff; color: #74668e; font-size: 12px; line-height: 1.6; }
.sku-option { min-width: 420px; padding: 3px 0; }
.sku-option > div { display: flex; align-items: center; gap: 7px; }
.sku-option b { color: #263b5d; font-size: 12px; }
.sku-option em { padding: 1px 5px; border-radius: 4px; background: #f0f3f8; color: #8491a3; font-size: 10px; font-style: normal; }
.sku-option small { display: flex; justify-content: space-between; gap: 18px; color: #75849a; font-size: 10px; }
.sku-option small span { color: #a06a25; }
@media (max-width: 980px) {
  .binding-hero, .binding-hero-side { flex-direction: column; align-items: flex-start; }
  .mapping-summary { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .binding-kpi-card { min-width: 0; padding: 10px; }
  .mapping-summary > p { grid-column: 1 / -1; justify-content: flex-start; border-top: 1px solid #e9edf3; }
  .binding-toolbar { flex-wrap: wrap; }
  .binding-hint { margin-left: 0; width: 100%; }
  .menu-picker-tools { align-items: flex-start; flex-direction: column; gap: 5px; }
  .menu-category-filter { width: 100%; }
}

.spec-dialog-hint{margin:0 0 14px;padding:10px 12px;border-left:3px solid #5e91e8;border-radius:0 8px 8px 0;background:#f3f7ff;color:#60728d;font-size:12px;line-height:1.65}
.spec-rows{display:flex;flex-direction:column;gap:8px;margin-top:4px}
.spec-row{display:flex;align-items:center;gap:10px;padding:8px;border:1px solid #e5ecf4;border-radius:10px;background:#fbfdff}
.spec-row :deep(.el-select){flex:1}
.spec-cost-preview{flex:none;color:#16865a;font-size:12px;font-weight:600;white-space:nowrap}
.spec-rows > .el-button{width:fit-content;margin-top:2px}
.manual-bind-intro{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:0 0 14px;padding:13px 15px;border:1px solid #d9e7ff;border-radius:12px;background:linear-gradient(105deg,#f6f9ff,#fbfdff)}
.manual-bind-intro b,.manual-bind-intro small{display:block}
.manual-bind-intro b{color:#284978;font-size:14px}
.manual-bind-intro small{margin-top:4px;color:#72839c;font-size:12px;line-height:1.5}
.manual-bind-intro .manual-progress{margin-top:6px;color:#3f6cbb;font-weight:650;font-variant-numeric:tabular-nums}
.manual-bind-intro>span{flex:none;padding:5px 8px;border-radius:99px;background:#e8f0ff;color:#3970cf;font-size:11px;font-weight:650}
.safe-bind-preview{margin:-4px 0 12px;border:1px solid #dcefe5;border-radius:10px;background:#fbfefc}
.safe-bind-preview :deep(.el-collapse-item__header){height:40px;padding:0 13px;border:0;background:transparent;color:#287458;font-size:12px}
.safe-bind-preview :deep(.el-collapse-item__header b){margin-right:9px}
.safe-bind-preview :deep(.el-collapse-item__header span){color:#7a998c;font-size:11px}
.safe-bind-preview :deep(.el-collapse-item__wrap){border-bottom:0;background:transparent}
.safe-bind-preview :deep(.el-collapse-item__content){padding:0 13px 11px}
.safe-bind-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 10px}
.safe-bind-list>div{min-width:0;padding:7px 9px;border-radius:7px;background:#f1faf5;color:#597369;font-size:11px}
.safe-bind-list span,.safe-bind-list b,.safe-bind-list small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.safe-bind-list b{margin-top:2px;color:#287458;font-size:12px}.safe-bind-list small{margin-top:2px;color:#89a797;font-size:10px}
.manual-bind-table b,.manual-bind-table small{display:block}
.manual-bind-table b{color:#2c3c53;font-size:13px;line-height:1.45}
.manual-bind-table small{margin-top:3px;color:#8b99ac;font-size:11px}
.manual-candidates{display:flex;flex-wrap:wrap;gap:5px}
.manual-candidates span{display:inline-flex;align-items:center;gap:4px;padding:3px 6px;border:1px solid #e2e9f3;border-radius:6px;background:#f8fafc;color:#536780;font-size:11px;line-height:1.35}
.manual-candidates i{color:#8b9aad;font-size:10px;font-style:normal}
.manual-candidates em{color:#9aa5b5;font-size:11px;font-style:normal}
.manual-reason{color:#9c733d!important}
.manual-sku-trigger{display:flex;align-items:center;justify-content:space-between;width:100%;min-height:39px;padding:6px 10px;border:1px solid #d9e2ee;border-radius:9px;background:#fff;text-align:left;transition:border-color .16s,box-shadow .16s}
.manual-sku-trigger:hover:not(:disabled){border-color:#7aa6ee;box-shadow:0 0 0 3px rgba(65,124,224,.09)}
.manual-sku-trigger:disabled{cursor:not-allowed;background:#f5f7fa;color:#a9b2bf}
.manual-sku-trigger b,.manual-sku-trigger small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.manual-sku-trigger b{color:#31517d;font-size:12px}.manual-sku-trigger small{margin-top:2px;color:#8898ad;font-size:10px}
.manual-sku-trigger span{color:#a0abba;font-size:12px}.manual-sku-trigger i{color:#7f8fa4;font-style:normal;font-size:17px}
:global(.manual-sku-picker){padding:10px!important;border:1px solid #dbe5f1!important;border-radius:12px!important;box-shadow:0 14px 34px rgba(32,55,88,.16)!important}
:global(.manual-sku-picker-body .el-input__wrapper){box-shadow:0 0 0 1px #d8e2ee inset!important;border-radius:8px}
:global(.manual-picker-caption){margin:10px 1px 6px;color:#7890ad;font-size:11px;font-weight:700}
:global(.manual-sku-options){display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px}
:global(.manual-sku-options button){min-width:0;padding:8px 9px;border:1px solid #e1e8f1;border-radius:8px;background:#fbfcfe;text-align:left;transition:all .15s}
:global(.manual-sku-options button:hover),:global(.manual-sku-options button.selected){border-color:#82aaf0;background:#f1f6ff}
:global(.manual-sku-options button.recommended){border-color:#c9ddfb;background:#f7faff}
:global(.manual-sku-options b),:global(.manual-sku-options small){display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
:global(.manual-sku-options b){color:#33465f;font-size:12px;line-height:1.35}:global(.manual-sku-options small){margin-top:3px;color:#8b9aad;font-size:10px}
:global(.manual-picker-empty){grid-column:1/-1;padding:10px;color:#9aa6b5;text-align:center;font-size:12px}
.manual-bind-footer-line{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:12px;color:#8996a8;font-size:11px}
@media (max-width:720px){.manual-bind-intro,.manual-bind-footer-line{align-items:flex-start;flex-direction:column}.manual-bind-dialog{width:calc(100vw - 24px)!important}.safe-bind-list{grid-template-columns:1fr}}
</style>
