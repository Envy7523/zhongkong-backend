<template>
  <el-popover v-model:visible="popoverVisible" trigger="click" placement="bottom-start" :width="popoverWidth" popper-class="store-region-popper">
    <template #reference>
      <el-input
        class="store-region-select"
        :model-value="filterable && popoverVisible ? filterText : selectedLabel"
        :style="inputStyle"
        :readonly="!filterable"
        :clearable="filterable && popoverVisible && !!filterText || clearable && hasSelection"
        :placeholder="filterable && popoverVisible ? searchPlaceholder : placeholder"
        @input="searchStores"
        @clear="clearInput"
        @keydown.esc="popoverVisible = false"
      />
    </template>
    <div class="store-region-panel">
      <el-input v-if="filterable" v-model="filterText" clearable size="small" :placeholder="searchPlaceholder" class="tree-filter" />
      <p v-if="showHint" class="tree-hint">{{ showGroup && !multiple ? '点击箭头展开或收起；点击名称选择总集团、子集团或门店。' : multiple ? '点击区域左侧箭头展开或收起；勾选区域可带入其下全部门店。' : '点击区域左侧箭头展开或收起；仅末级门店可被选中。' }}</p>
      <el-tree
        ref="treeRef"
        :data="treeData"
        node-key="key"
        :show-checkbox="multiple"
        :check-on-click-node="false"
        :expand-on-click-node="true"
        :default-expanded-keys="defaultExpandedKeys"
        :filter-node-method="filterNode"
        :props="{ label: 'label', children: 'children', disabled: 'disabled' }"
        highlight-current
        class="store-region-tree"
        @node-click="handleNodeClick"
        @check="handleTreeCheck"
      >
        <template #default="{ data }">
          <span :class="['region-tree-node', data.kind, { 'group-root': data.isGroupRoot }]">
            <span>{{ data.label }}</span>
            <small v-if="data.kind === 'region' || data.kind === 'unassigned' || data.kind === 'closed'">{{ data.storeCount }} 家</small>
          </span>
        </template>
      </el-tree>
      <el-empty v-if="!treeData.length" :image-size="54" description="暂无可选门店" />
      <div v-if="multiple" class="tree-actions">
        <el-button link type="primary" size="small" @click="selectAllStores">全选门店</el-button>
        <el-button link size="small" :disabled="!hasSelection" @click="clearSelection">清空</el-button>
      </div>
    </div>
  </el-popover>
</template>

<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { getStoreRegions, getOrganizationOptions } from '@/api'

const loadedGroups = ref(['粤宏潮','永文总公司','鹅太公连锁','鹅太公品牌','同盛'])
const GROUP_NAMES = computed(() => props.groups || loadedGroups.value)

const props = defineProps({
  modelValue: { type: [Array, Number, String, null], default: null },
  groups: { type: Array, default: null },
  stores: { type: Array, default: () => [] },
  multiple: { type: Boolean, default: false },
  restrictToStores: { type: Boolean, default: false },
  includeClosed: { type: Boolean, default: true },
  showGroup: { type: Boolean, default: false },
  clearable: { type: Boolean, default: true },
  filterable: { type: Boolean, default: true },
  showHint: { type: Boolean, default: true },
  showSelectionActions: { type: Boolean, default: false },
  inputWidth: { type: [String, Number], default: null },
  placeholder: { type: String, default: '选择门店或区域' },
})
const emit = defineEmits(['update:modelValue', 'regions-loaded', 'change'])
const regions = ref([])
const popoverVisible = ref(false)
const filterText = ref('')
const treeRef = ref()
const inputStyle = computed(() => props.inputWidth ? { width: typeof props.inputWidth === 'number' ? `${props.inputWidth}px` : props.inputWidth } : undefined)
const searchPlaceholder = computed(() => props.showGroup && !props.multiple ? '搜索集团、区域或门店' : '搜索区域或门店')

function directChildren(id) {
  return regions.value.filter(region => Number(region.parent_id || 0) === Number(id || 0))
}

const CLOSED_STATUSES = ['已闭店', '闭店', '迁址']
const isClosedStore = (store) => CLOSED_STATUSES.includes(String(store?.status || '').trim())
// 闭店/迁址门店统一放在独立分组；业务入口可显式禁止选择闭店。
const visibleStores = computed(() => props.stores.filter(store => props.includeClosed || !isClosedStore(store)))
const storePool = computed(() => {
  const regionStores = new Map(regions.value.flatMap(region => region.stores || []).map(store => [Number(store.id), store]))
  const stores = new Map()
  for (const store of !props.restrictToStores ? regionStores.values() : []) {
    if (props.includeClosed || !isClosedStore(store)) stores.set(Number(store.id), store)
  }
  for (const store of visibleStores.value) {
    const known = regionStores.get(Number(store.id)) || {}
    stores.set(Number(store.id), { ...known, ...store, status: known.status || store.status, province: store.province || known.province, city: store.city || known.city })
  }
  return stores
})
const assignedStoreIds = computed(() => new Set(regions.value.flatMap(region => (region.store_ids || []).map(Number))))
const samePlace = (left, right) => String(left || '').trim().replace(/市$/, '') === String(right || '').trim().replace(/市$/, '')
// 只用门店档案中明确登记的省、市来整理选择器视图，不改写实际区域归属。
const displayRegionByStoreId = computed(() => {
  const placement = new Map()
  const regionById = new Map(regions.value.map(region => [Number(region.id), region]))
  for (const region of regions.value) {
    const cities = directChildren(region.id).filter(child => child.code !== 'closed')
    for (const id of region.store_ids || []) {
      const store = storePool.value.get(Number(id))
      if (isClosedStore(store) || !store?.city || !cities.length) continue
      const city = cities.find(child => samePlace(child.name, store.city))
      if (city) placement.set(Number(id), Number(city.id))
    }
  }
  for (const store of visibleStores.value) {
    if (isClosedStore(store) || assignedStoreIds.value.has(Number(store.id)) || !store.province || !store.city) continue
    const cities = regions.value.filter(region => samePlace(region.name, store.city) && samePlace(regionById.get(Number(region.parent_id))?.name, store.province))
    if (cities.length === 1) placement.set(Number(store.id), Number(cities[0].id))
  }
  return placement
})

function makeRegionNode(region) {
  const children = directChildren(region.id).filter(child => child.code !== 'closed')
  const storeIds = new Set((region.store_ids || []).map(Number))
  const node = { key: `region-${region.id}`, kind: 'region', label: region.name, storeCount: 0, children: [] }
  const directStores = [...storePool.value.values()].filter(store => !isClosedStore(store) && (
    (storeIds.has(Number(store.id)) && !displayRegionByStoreId.value.has(Number(store.id))) ||
    displayRegionByStoreId.value.get(Number(store.id)) === Number(region.id)))
  node.children = [...children.map(makeRegionNode), ...directStores
      .map(store => ({ key: `store-${store.id}`, kind: 'store', label: store.store_name, storeId: Number(store.id), leaf: true }))]
  const leafIds = nodes => nodes.flatMap(n => n.kind === 'store' ? [n.storeId] : leafIds(n.children || []))
  node.storeCount = new Set(leafIds(node.children)).size
  return node
}

const unassignedStores = computed(() => visibleStores.value.filter(store => !isClosedStore(store) && !assignedStoreIds.value.has(Number(store.id)) && !displayRegionByStoreId.value.has(Number(store.id))))
const treeData = computed(() => {
  const nodes = directChildren(null).filter(region => region.code !== 'closed').map(makeRegionNode)
  if (props.showGroup && !props.multiple && GROUP_NAMES.value.length) {
    const rootName = '粤宏潮'
    const names = [...new Set(GROUP_NAMES.value)]
    nodes.unshift({
      key: `group-${rootName}`, kind: 'group', label: rootName, groupName: rootName, isGroupRoot: true,
      children: names.filter(name => name !== rootName).map(name => ({
        key: `group-${name}`, kind: 'group', label: name, groupName: name, parentGroupName: rootName, leaf: true,
      })),
    })
  }
  if (unassignedStores.value.length) {
    nodes.push({
      key: 'unassigned',
      kind: 'unassigned',
      label: regions.value.length ? '未分组门店' : '未分组门店（尚未划分区域）',
      storeCount: unassignedStores.value.length,
      children: unassignedStores.value.map(store => ({ key: `store-${store.id}`, kind: 'store', label: store.store_name, storeId: Number(store.id), leaf: true })),
    })
  }
  const closed = [...storePool.value.values()].filter(isClosedStore)
  if (props.includeClosed && closed.length) nodes.push({key:'closed-stores',kind:'closed',label:'闭店门店',storeCount:closed.length,children:closed.map(store=>({key:`store-${store.id}`,kind:'store',label:store.store_name,storeId:Number(store.id),leaf:true}))})
  return nodes
})
// 总集团与省级区域展开，城市默认收起。
const defaultExpandedKeys = computed(() => treeData.value.filter(node => node.isGroupRoot || node.kind === 'region' && node.children.some(child => child.kind === 'region')).map(node => node.key))
const selectedStoreIds = computed(() => {
  const raw = props.multiple ? (Array.isArray(props.modelValue) ? props.modelValue : []) : [props.modelValue]
  return raw.filter(value => value !== null && value !== undefined && value !== '' && !GROUP_NAMES.value.includes(value)).map(Number).filter(Number.isFinite)
})
const storeMap = computed(() => new Map([...(!props.restrictToStores ? regions.value.flatMap(r => r.stores || []) : []), ...props.stores].map(store => [Number(store.id), store])))
const selectedLabel = computed(() => {
  if (props.showGroup && !props.multiple && GROUP_NAMES.value.includes(props.modelValue)) return props.modelValue
  const names = selectedStoreIds.value.map(id => storeMap.value.get(id)?.store_name).filter(Boolean)
  if (!names.length) return ''
  if (!props.multiple || names.length === 1) return names[0]
  return names.length > 2 ? `${names.slice(0, 2).join('、')} 等 ${names.length} 家` : names.join('、')
})
const hasSelection = computed(() => selectedStoreIds.value.length > 0 || (props.showGroup && !props.multiple && GROUP_NAMES.value.includes(props.modelValue)))
const popoverWidth = computed(() => Math.max(280, Math.min(440, Math.max(280, ...props.stores.map(store => String(store.store_name || '').length * 15 + 90)))))

function syncTreeSelection() {
  if (!treeRef.value) return
  if (props.multiple) treeRef.value.setCheckedKeys(selectedStoreIds.value.map(id => `store-${id}`), false)
  else {
    const isGroup = props.showGroup && GROUP_NAMES.value.includes(props.modelValue)
    treeRef.value.setCurrentKey(isGroup ? `group-${props.modelValue}` : selectedStoreIds.value[0] ? `store-${selectedStoreIds.value[0]}` : null)
    if (isGroup) treeRef.value.getNode('group-粤宏潮')?.expand()
  }
}
function filterNode(value, data) {
  const query = String(value || '').trim().toLowerCase()
  if (!query) return true
  return String(data.label || '').toLowerCase().includes(query) || String(data.parentGroupName || '').toLowerCase().includes(query)
}
function searchStores(value) {
  if (!props.filterable) return
  filterText.value = value
  popoverVisible.value = true
}
function clearInput() {
  if (props.filterable && popoverVisible.value && filterText.value) filterText.value = ''
  else clearSelection()
}
function handleNodeClick(data) {
  if (data.kind === 'group' && props.showGroup && !props.multiple) {
    updateSelection( data.groupName)
    popoverVisible.value = false
    return
  }
  if (data.kind !== 'store' || props.multiple) return
  updateSelection( data.storeId)
  popoverVisible.value = false
}
function handleTreeCheck() {
  if (!props.multiple) return
  const ids = treeRef.value?.getCheckedNodes(true).filter(node => node.kind === 'store').map(node => node.storeId) || []
  updateSelection( [...new Set(ids)])
}
function updateSelection(value){emit('update:modelValue',value);emit('change',value)}
function clearSelection() { updateSelection( props.multiple ? [] : null) }
function selectAllStores() {
  const leafIds = nodes => nodes.flatMap(n => n.kind === 'store' ? [n.storeId] : leafIds(n.children || []))
  updateSelection( [...new Set(leafIds(treeData.value.filter(node=>node.kind!=='closed')))])
}

watch(filterText, value => treeRef.value?.filter(value))
watch(() => props.modelValue, () => nextTick(syncTreeSelection), { deep: true })
watch(popoverVisible, visible => { if (visible) nextTick(syncTreeSelection); else filterText.value = '' })
watch(treeData, () => nextTick(() => { syncTreeSelection(); treeRef.value?.filter(filterText.value) }), { deep: true })
onMounted(async () => {
  if(props.showGroup&&!props.groups)getOrganizationOptions().then(r=>{loadedGroups.value=r.group_names||loadedGroups.value}).catch(()=>{})
  try {
    const data = await getStoreRegions()
    regions.value = data.regions || []
    emit('regions-loaded', regions.value)
  } catch {
    // 区域未配置或网络暂不可用时，仍展示未分组门店。
  }
})
</script>

<style scoped>
.store-region-select { min-width: 200px; }
.store-region-panel { min-width: 250px; }
.tree-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 32px; margin: 7px 0 0; padding: 7px 2px 0; border-top: 1px solid #e8eef5; }
.tree-actions :deep(.el-button) { margin: 0; font-size: 12px; }
.tree-filter { margin-bottom: 8px; }
.tree-hint { margin: 0 0 8px; color: #8795a9; font-size: 12px; line-height: 1.55; }
.store-region-tree { max-height: 340px; overflow: auto; background: transparent; }
.store-region-tree :deep(.el-tree-node__content) { height: 32px; border-radius: 5px; }
.store-region-tree :deep(.el-tree-node__content:hover), .store-region-tree :deep(.is-current > .el-tree-node__content) { background: #eff6ff; }
.store-region-tree :deep(.el-tree-node__expand-icon) { color: #8499b5; }
.region-tree-node { display: flex; align-items: center; gap: 16px; width: 100%; padding-right: 8px; color: #4b617d; font-size: 13px; }
.region-tree-node.region, .region-tree-node.unassigned { color: #315b98; font-weight: 700; }
.region-tree-node.group-root { color: #315b98; font-weight: 700; }
.region-tree-node.store { color: #536a84; }
.region-tree-node small { margin-left: auto; color: #8da0b5; font-size: 11px; font-weight: 500; }
</style>
