<template>
  <div class="card-compact">
    <div class="card-header">🏙️ 门店商圈调查</div>

    <!-- 数据源切换 -->
    <el-radio-group v-model="sourceMode" style="margin-bottom:16px;" @change="onModeChange">
      <el-radio-button value="store">🏪 门店</el-radio-button>
      <el-radio-button value="pin">📌 自定义点位</el-radio-button>
    </el-radio-group>

    <!-- 选择数据源 -->
    <el-row :gutter="12" style="margin-bottom:16px;">
      <el-col :span="10">
        <!-- 门店模式 -->
        <StoreRegionSelect
          v-if="sourceMode === 'store'"
          v-model="selectedStoreId"
          :stores="allStores"
          placeholder="请选择门店或区域"
          style="width:100%;"
          @update:model-value="onStoreChange"
        />
        <!-- 点位模式 -->
        <el-select
          v-else
          v-model="selectedPinId"
          filterable
          placeholder="请选择自定义点位"
          clearable
          style="width:100%;"
          @change="onPinChange"
        >
          <el-option
            v-for="p in allPins"
            :key="p.id"
            :label="p.name || `自定义点位${p.id}`"
            :value="p.id"
          />
        </el-select>
      </el-col>
      <el-col :span="6">
        <el-select v-model="radius" style="width:100%;">
          <el-option label="1 km" :value="1000" />
          <el-option label="2 km" :value="2000" />
          <el-option label="3 km" :value="3000" />
          <el-option label="5 km" :value="5000" />
          <el-option label="10 km" :value="10000" />
        </el-select>
      </el-col>
      <el-col :span="8">
        <el-button
          type="primary"
          :loading="querying"
          :disabled="!activeLocation"
          @click="doQuery"
        >
          🔍 查询商圈
        </el-button>
        <span v-if="sourceMode === 'store' && selectedStore && (!selectedStore.lat || !selectedStore.lng)" style="color:#e6a23c;font-size:12px;margin-left:8px;">
          该门店缺经纬度，请先在编辑中设置
        </span>
        <span v-if="sourceMode === 'pin' && selectedPin && (!selectedPin.lat || !selectedPin.lng)" style="color:#e6a23c;font-size:12px;margin-left:8px;">
          该点缺经纬度
        </span>
      </el-col>
    </el-row>

    <!-- 选中的信息 -->
    <div v-if="sourceMode === 'store' && selectedStore" style="background:#f5f7fa;border-radius:8px;padding:12px 16px;margin-bottom:16px;display:flex;flex-wrap:wrap;gap:16px;font-size:13px;">
      <span><b>{{ selectedStore.store_name }}</b></span>
      <span>📍 {{ [selectedStore.province, selectedStore.city, selectedStore.district, selectedStore.address].filter(Boolean).join(' ') || '—' }}</span>
      <span v-if="selectedStore.lat && selectedStore.lng">🌐 {{ selectedStore.lng }}, {{ selectedStore.lat }}</span>
      <el-tag :type="statusTag(selectedStore.status)" size="small">{{ selectedStore.status || '—' }}</el-tag>
    </div>
    <div v-if="sourceMode === 'pin' && selectedPin" style="background:#f0f5ff;border-radius:8px;padding:12px 16px;margin-bottom:16px;display:flex;flex-wrap:wrap;gap:16px;font-size:13px;align-items:center;">
      <span><b>{{ selectedPin.name || '自定义点位' }}</b></span>
      <span v-if="selectedPin.remark">💬 {{ selectedPin.remark }}</span>
      <span>🌐 {{ selectedPin.lng }}, {{ selectedPin.lat }}</span>
      <span
        class="pin-color-dot"
        :style="{ background: selectedPin.color || '#409EFF', width: '12px', height: '12px', borderRadius: '50%', display: 'inline-block' }"
      ></span>
      <span style="color:#909399;font-size:12px;">默认半径 {{ (selectedPin.radius || 3000) }}m</span>
    </div>

    <!-- 查询结果 -->
    <div v-if="queryResult" style="margin-top:8px;">
      <div style="margin-bottom:12px;color:#606266;font-size:13px;">
        搜索半径 <b>{{ radius }}m</b>，共找到 <b>{{ queryResult.count }}</b> 条周边 POI
        <span v-if="queryResult.pois?.length < queryResult.count" style="color:#909399;">（当前显示前 {{ queryResult.pois?.length }} 条）</span>
      </div>
      <div v-if="groupedPois.length === 0" style="text-align:center;padding:40px;color:#909399;">
        周边 {{ radius }}m 范围内未找到 POI 数据
      </div>
      <div v-for="group in groupedPois" :key="group.label" style="margin-bottom:16px;">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;font-weight:600;font-size:14px;color:#303133;">
          <span>{{ group.icon }}</span>
          <span>{{ group.label }}</span>
          <el-tag size="small" round>{{ group.items.length }}</el-tag>
        </div>
        <el-row :gutter="12">
          <el-col v-for="poi in group.items" :key="poi.id" :span="6" style="margin-bottom:12px;">
            <div class="poi-card" @click="openPoiDetail(poi)">
              <div class="poi-name">{{ poi.name }}</div>
              <div class="poi-type">{{ poi.type?.split(';')[2] || poi.type?.split(';')[1] || poi.business_area || poi.adname }}</div>
              <div class="poi-meta">
                <span v-if="poi.distance">📏 {{ formatDist(poi.distance) }}</span>
                <span v-if="poi.address" style="font-size:11px;color:#c0c4cc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">{{ poi.address }}</span>
              </div>
            </div>
          </el-col>
        </el-row>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-if="!queryResult && !querying" style="text-align:center;padding:60px 0;color:#c0c4cc;">
      <div style="font-size:48px;margin-bottom:12px;">🔍</div>
      <div v-if="sourceMode === 'store'">选择门店并点击「查询商圈」，查看周边商业环境</div>
      <div v-else>选择自定义点位并点击「查询商圈」，查看周边商业环境</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { getStores, getMapPins, searchAround } from '@/api'
import { ElMessage } from 'element-plus'
import StoreRegionSelect from '@/components/StoreRegionSelect.vue'

const sourceMode = ref('store')
const allStores = ref([])
const allPins = ref([])
const selectedStoreId = ref(null)
const selectedStore = ref(null)
const selectedPinId = ref(null)
const selectedPin = ref(null)
const radius = ref(3000)
const querying = ref(false)
const queryResult = ref(null)

// 当前活跃的查询位置
const activeLocation = computed(() => {
  if (sourceMode.value === 'pin' && selectedPin.value) {
    return { lng: selectedPin.value.lng, lat: selectedPin.value.lat }
  }
  if (sourceMode.value === 'store' && selectedStore.value) {
    return { lng: selectedStore.value.lng, lat: selectedStore.value.lat }
  }
  return null
})

// POI 大类映射
const TYPE_MAP = {
  '01': { label: '🚗 汽车服务', icon: '🚗' },
  '02': { label: '🔧 汽车相关', icon: '🔧' },
  '05': { label: '🍽️ 餐饮美食', icon: '🍽️' },
  '06': { label: '🛒 购物消费', icon: '🛒' },
  '07': { label: '🏠 生活服务', icon: '🏠' },
  '08': { label: '⚽ 体育休闲', icon: '⚽' },
  '09': { label: '🏥 医疗保健', icon: '🏥' },
  '10': { label: '🏨 住宿住宅', icon: '🏨' },
  '11': { label: '🏞️ 风景名胜', icon: '🏞️' },
  '12': { label: '🚌 交通设施', icon: '🚌' },
  '13': { label: '💰 金融保险', icon: '💰' },
  '14': { label: '🎓 科教文化', icon: '🎓' },
  '15': { label: '🏢 公司企业', icon: '🏢' },
  '16': { label: '🏛️ 政府机构', icon: '🏛️' },
  '17': { label: '🏗️ 公共设施', icon: '🏗️' },
  '97': { label: '🌐 室内设施', icon: '🌐' },
  '99': { label: '📌 其他', icon: '📌' },
}

const groupedPois = computed(() => {
  if (!queryResult.value?.pois) return []
  const groups = {}
  for (const poi of queryResult.value.pois) {
    const typecode = poi.typecode || ''
    const major = typecode.slice(0, 2)
    const key = TYPE_MAP[major] ? major : '99'
    if (!groups[key]) groups[key] = { ...TYPE_MAP[key] || TYPE_MAP['99'], items: [] }
    groups[key].items.push(poi)
  }
  return Object.values(groups)
})

onMounted(async () => {
  try {
    const data = await getStores({ page: 1, page_size: 9999 })
    allStores.value = data.stores || []
  } catch { /* ignore */ }
  fetchPins()
})

async function fetchPins() {
  try {
    const res = await getMapPins()
    allPins.value = res.data || []
  } catch { /* ignore */ }
}

function onModeChange() {
  // 切换模式时清空选中和查询结果
  selectedStoreId.value = null
  selectedStore.value = null
  selectedPinId.value = null
  selectedPin.value = null
  queryResult.value = null
  if (sourceMode.value === 'pin') {
    // 切换回点位时重新加载数据
    fetchPins()
  }
}

function onStoreChange(id) {
  selectedStore.value = allStores.value.find(s => s.id === id) || null
  queryResult.value = null
}

function onPinChange(id) {
  const pin = allPins.value.find(p => p.id === id) || null
  selectedPin.value = pin
  // 自动使用点位的默认半径
  if (pin && pin.radius) {
    radius.value = pin.radius
  }
  queryResult.value = null
}

function statusTag(s) {
  if (s === '正常营业') return 'success'
  if (s === '筹建中') return 'warning'
  if (s === '已闭店') return 'info'
  if (s === '迁址') return 'danger'
  return ''
}

function formatDist(meters) {
  if (!meters) return ''
  const m = parseInt(meters)
  if (m >= 1000) return (m / 1000).toFixed(1) + 'km'
  return m + 'm'
}

async function doQuery() {
  if (!activeLocation.value?.lng || !activeLocation.value?.lat) {
    ElMessage.warning('缺少经纬度信息')
    return
  }
  querying.value = true
  queryResult.value = null
  try {
    const data = await searchAround({
      location: `${activeLocation.value.lng},${activeLocation.value.lat}`,
      radius: radius.value,
      offset: 24,
      page: 1,
    })
    if (data.status === '1') {
      queryResult.value = data
    } else {
      ElMessage.warning('查询失败: ' + (data.info || '未知错误'))
    }
  } catch (e) {
    ElMessage.error('查询失败: ' + (e?.message || e))
  } finally {
    querying.value = false
  }
}

function openPoiDetail(poi) {
  window.open(`https://uri.amap.com/detail?poiid=${poi.id}`, '_blank')
}
</script>

<style scoped>
.poi-card {
  background: #fff;
  border: 1px solid #ebeef5;
  border-radius: 8px;
  padding: 12px;
  cursor: pointer;
  transition: border-color 0.2s, box-shadow 0.2s;
  height: 100%;
}
.poi-card:hover {
  border-color: #409eff;
  box-shadow: 0 2px 8px rgba(64,158,255,0.15);
}
.poi-name {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.poi-type {
  font-size: 11px;
  color: #909399;
  margin-bottom: 6px;
}
.poi-meta {
  display: flex;
  gap: 8px;
  font-size: 12px;
  color: #606266;
}
</style>
