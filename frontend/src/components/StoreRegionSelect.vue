<template>
  <el-popover v-model:visible="popoverVisible" trigger="click" placement="bottom-start" :width="popoverWidth" popper-class="store-region-popper">
    <template #reference>
      <el-input
        class="store-region-select"
        :model-value="selectedLabel"
        :style="inputStyle"
        readonly
        :clearable="clearable && hasSelection"
        :placeholder="placeholder"
        @clear="clearSelection"
      />
    </template>
    <div class="store-region-panel">
      <div v-if="showSelectionActions && multiple" class="tree-actions">
        <el-button link type="primary" size="small" @click="selectAllStores">全选门店</el-button>
        <el-button v-if="hasSelection" link size="small" @click="clearSelection">清空</el-button>
      </div>
      <el-input v-if="filterable" v-model="filterText" clearable size="small" placeholder="搜索区域或门店" class="tree-filter" />
      <p v-if="showHint" class="tree-hint">点击区域左侧箭头展开或收起；{{ multiple ? '勾选区域可带入其下全部门店。' : '仅末级门店可被选中。' }}</p>
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
          <span :class="['region-tree-node', data.kind]">
            <span>{{ data.label }}</span>
            <small v-if="data.kind === 'region' || data.kind === 'unassigned'">{{ data.storeCount }} 家</small>
          </span>
        </template>
      </el-tree>
      <el-empty v-if="!treeData.length" :image-size="54" description="暂无可选门店" />
    </div>
  </el-popover>
</template>

<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { getStoreRegions } from '@/api'

const props = defineProps({
  modelValue: { type: [Array, Number, String, null], default: null },
  stores: { type: Array, default: () => [] },
  multiple: { type: Boolean, default: false },
  clearable: { type: Boolean, default: true },
  filterable: { type: Boolean, default: true },
  showHint: { type: Boolean, default: true },
  showSelectionActions: { type: Boolean, default: false },
  inputWidth: { type: [String, Number], default: null },
  placeholder: { type: String, default: '选择门店或区域' },
})
const emit = defineEmits(['update:modelValue', 'regions-loaded'])
const regions = ref([])
const popoverVisible = ref(false)
const filterText = ref('')
const treeRef = ref()
const inputStyle = computed(() => props.inputWidth ? { width: typeof props.inputWidth === 'number' ? `${props.inputWidth}px` : props.inputWidth } : undefined)

function directChildren(id) {
  return regions.value.filter(region => Number(region.parent_id || 0) === Number(id || 0))
}

function leafStoreIds(regionId) {
  const region = regions.value.find(item => Number(item.id) === Number(regionId))
  const children = directChildren(regionId)
  if (!children.length) return new Set((region?.store_ids || []).map(Number))
  return children.reduce((all, child) => {
    leafStoreIds(child.id).forEach(id => all.add(id))
    return all
  }, new Set())
}

function makeRegionNode(region) {
  const children = directChildren(region.id)
  const storeIds = leafStoreIds(region.id)
  const node = { key: `region-${region.id}`, kind: 'region', label: region.name, storeCount: storeIds.size, children: [] }
  node.children = children.length
    ? children.map(makeRegionNode)
    : props.stores
      .filter(store => storeIds.has(Number(store.id)))
      .map(store => ({ key: `store-${store.id}`, kind: 'store', label: store.store_name, storeId: Number(store.id), leaf: true }))
  return node
}

const assignedStoreIds = computed(() => new Set(regions.value.flatMap(region => (region.store_ids || []).map(Number))))
const unassignedStores = computed(() => props.stores.filter(store => !assignedStoreIds.value.has(Number(store.id))))
const treeData = computed(() => {
  const nodes = directChildren(null).map(makeRegionNode)
  if (unassignedStores.value.length) {
    nodes.push({
      key: 'unassigned',
      kind: 'unassigned',
      label: regions.value.length ? '未分组门店' : '未分组门店（尚未划分区域）',
      storeCount: unassignedStores.value.length,
      children: unassignedStores.value.map(store => ({ key: `store-${store.id}`, kind: 'store', label: store.store_name, storeId: Number(store.id), leaf: true })),
    })
  }
  return nodes
})
const defaultExpandedKeys = computed(() => treeData.value.map(node => node.key))
const selectedStoreIds = computed(() => {
  const raw = props.multiple ? (Array.isArray(props.modelValue) ? props.modelValue : []) : [props.modelValue]
  return raw.map(Number).filter(Number.isFinite)
})
const storeMap = computed(() => new Map(props.stores.map(store => [Number(store.id), store])))
const selectedLabel = computed(() => {
  const names = selectedStoreIds.value.map(id => storeMap.value.get(id)?.store_name).filter(Boolean)
  if (!names.length) return ''
  if (!props.multiple || names.length === 1) return names[0]
  return names.length > 2 ? `${names.slice(0, 2).join('、')} 等 ${names.length} 家` : names.join('、')
})
const hasSelection = computed(() => selectedStoreIds.value.length > 0)
const popoverWidth = computed(() => Math.max(280, Math.min(440, Math.max(280, ...props.stores.map(store => String(store.store_name || '').length * 15 + 90)))))

function syncTreeSelection() {
  if (!treeRef.value) return
  if (props.multiple) treeRef.value.setCheckedKeys(selectedStoreIds.value.map(id => `store-${id}`), false)
  else treeRef.value.setCurrentKey(selectedStoreIds.value[0] ? `store-${selectedStoreIds.value[0]}` : null)
}
function filterNode(value, data) {
  if (!value) return true
  return String(data.label || '').toLowerCase().includes(String(value).toLowerCase())
}
function handleNodeClick(data) {
  if (data.kind !== 'store' || props.multiple) return
  emit('update:modelValue', data.storeId)
  popoverVisible.value = false
}
function handleTreeCheck() {
  if (!props.multiple) return
  const ids = treeRef.value?.getCheckedNodes(true).filter(node => node.kind === 'store').map(node => node.storeId) || []
  emit('update:modelValue', [...new Set(ids)])
}
function clearSelection() { emit('update:modelValue', props.multiple ? [] : null) }
function selectAllStores() {
  emit('update:modelValue', props.stores.map(store => Number(store.id)).filter(Number.isFinite))
}

watch(filterText, value => treeRef.value?.filter(value))
watch(() => props.modelValue, () => nextTick(syncTreeSelection), { deep: true })
watch(popoverVisible, visible => { if (visible) nextTick(syncTreeSelection); else filterText.value = '' })
watch(treeData, () => nextTick(syncTreeSelection), { deep: true })
onMounted(async () => {
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
.tree-actions { display: flex; align-items: center; justify-content: flex-end; gap: 12px; min-height: 24px; margin: -2px 0 6px; }
.tree-actions :deep(.el-button) { margin: 0; font-size: 12px; }
.tree-filter { margin-bottom: 8px; }
.tree-hint { margin: 0 0 8px; color: #8795a9; font-size: 12px; line-height: 1.55; }
.store-region-tree { max-height: 340px; overflow: auto; background: transparent; }
.store-region-tree :deep(.el-tree-node__content) { height: 32px; border-radius: 5px; }
.store-region-tree :deep(.el-tree-node__content:hover), .store-region-tree :deep(.is-current > .el-tree-node__content) { background: #eff6ff; }
.store-region-tree :deep(.el-tree-node__expand-icon) { color: #8499b5; }
.region-tree-node { display: flex; align-items: center; gap: 16px; width: 100%; padding-right: 8px; color: #4b617d; font-size: 13px; }
.region-tree-node.region, .region-tree-node.unassigned { color: #315b98; font-weight: 700; }
.region-tree-node.store { color: #536a84; }
.region-tree-node small { margin-left: auto; color: #8da0b5; font-size: 11px; font-weight: 500; }
</style>
