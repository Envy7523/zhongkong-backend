<template>
  <div class="card-compact">
    <div class="card-header">🏙️ 门店商圈调查</div>

    <!-- 选择门店 -->
    <el-row :gutter="12" style="margin-bottom:16px;">
      <el-col :span="10">
        <el-select
          v-model="selectedStoreId"
          filterable
          placeholder="请选择门店"
          clearable
          style="width:100%;"
          @change="onStoreChange"
        >
          <el-option
            v-for="s in allStores"
            :key="s.id"
            :label="s.store_name"
            :value="s.id"
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
          :disabled="!selectedStore || !selectedStore.lat || !selectedStore.lng"
          @click="doQuery"
        >
          🔍 查询商圈
        </el-button>
        <span v-if="selectedStore && (!selectedStore.lat || !selectedStore.lng)" style="color:#e6a23c;font-size:12px;margin-left:8px;">
          该门店缺经纬度，请先在编辑中设置
        </span>
      </el-col>
    </el-row>

    <!-- 选中门店信息 -->
    <div v-if="selectedStore" style="background:#f5f7fa;border-radius:8px;padding:12px 16px;margin-bottom:16px;display:flex;flex-wrap:wrap;gap:16px;font-size:13px;">
      <span><b>{{ selectedStore.store_name }}</b></span>
      <span>📍 {{ [selectedStore.province, selectedStore.city, selectedStore.district, selectedStore.address].filter(Boolean).join(' ') || '—' }}</span>
      <span v-if="selectedStore.lat && selectedStore.lng">🌐 {{ selectedStore.lng }}, {{ selectedStore.lat }}</span>
      <el-tag :type="statusTag(selectedStore.status)" size="small">{{ selectedStore.status || '—' }}</el-tag>
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
      <div>选择门店并点击「查询商圈」，查看周边商业环境</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { getStores, searchAround } from '@/api'
import { ElMessage } from 'element-plus'

const allStores = ref([])
const selectedStoreId = ref(null)
const selectedStore = ref(null)
const radius = ref(3000)
const querying = ref(false)
const queryResult = ref(null)

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
})

function onStoreChange(id) {
  selectedStore.value = allStores.value.find(s => s.id === id) || null
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
  if (!selectedStore.value?.lng || !selectedStore.value?.lat) {
    ElMessage.warning('该门店缺少经纬度信息')
    return
  }
  querying.value = true
  queryResult.value = null
  try {
    const data = await searchAround({
      location: `${selectedStore.value.lng},${selectedStore.value.lat}`,
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
  transition: all 0.2s;
  height: 100%;
}
.poi-card:hover {
  border-color: #409eff;
  box-shadow: 0 2px 8px rgba(64,158,255,0.15);
  transform: translateY(-1px);
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
