<template>
  <div class="card-compact">
    <div class="card-header">
      🗺️ {{ breadcrumb }}门店分布（共 {{ total }} 家）
      <el-button v-if="drillLevel !== 'china'" size="small" type="primary" plain style="float:right;" @click="backToPrevious">
        ← 返回{{ drillLevel === 'district' ? '区级' : drillLevel === 'city' ? '市级' : '省级' }}
      </el-button>
    </div>
    <!-- 高德地图工具栏（仅区级显示） -->
    <div v-if="drillLevel === 'district'" class="map-toolbar" style="display:flex;align-items:center;gap:12px;padding:8px 16px;background:#fafafa;border-bottom:1px solid #eee;">
      <el-select v-model="statusFilter" size="small" style="width:150px;" placeholder="状态筛选" clearable>
        <el-option label="全部状态" value="" />
        <el-option label="🟢 正常营业" value="正常营业" />
        <el-option label="🟡 筹建中" value="筹建中" />
        <el-option label="⚫ 已闭店/迁址" value="closed" />
      </el-select>
      <el-button size="small" :type="placingMode ? 'warning' : 'primary'" @click="togglePlacingMode">
        {{ placingMode ? '✅ 标点中（点击退出）' : '📌 自定义标点' }}
      </el-button>
      <el-button v-if="customPins.length" size="small" type="danger" plain @click="clearAllPins">🗑 清空所有标记</el-button>
    </div>
    <div v-loading="loading" style="min-height:620px;position:relative;">
      <div v-show="drillLevel !== 'district'" ref="chartRef" style="width:100%;height:620px;"></div>
      <div v-show="drillLevel === 'district'" ref="amapRef" style="width:100%;height:620px;position:relative;"></div>
    </div>

    <!-- 自定义点位编辑弹窗 -->
    <el-dialog v-model="pinDialogVisible" :title="pinType==='store' ? '门店备注' : '编辑点位'" width="420px">
      <el-form label-width="70px" v-if="pinForm">
        <el-form-item v-if="pinType==='store'" label="门店名称">
          <el-input :model-value="pinForm.store_name" disabled />
        </el-form-item>
        <el-form-item v-if="pinType==='pin'" label="名称"><el-input v-model="pinForm.name" placeholder="点位名称" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="pinForm.remark" type="textarea" :rows="2" placeholder="备注信息" /></el-form-item>
        <template v-if="pinType==='pin'">
          <el-form-item label="颜色"><el-color-picker v-model="pinForm.color" /></el-form-item>
          <el-form-item label="商圈半径">
            <el-input-number v-model="pinForm.radius" :min="500" :max="10000" :step="500" size="small" /> 米
          </el-form-item>
          <el-form-item label="创建人"><el-input v-model="pinForm.created_by" disabled /></el-form-item>
        </template>
      </el-form>
      <template #footer>
        <el-button v-if="pinType==='pin'" type="danger" size="small" @click="deletePin" style="float:left;">删除</el-button>
        <el-button @click="pinDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="savePin" :loading="pinSaving">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import * as echarts from 'echarts'
import { getProvinceStats, getCityStats, getDistrictStats, getStoreLocations, getMapPins, createMapPin, updateMapPin, deleteMapPin, updateStore } from '@/api'
import { ElMessage, ElMessageBox } from 'element-plus'

const GEO_BASE = 'https://geo.datav.aliyun.com/areas_v3/bound'

const PROVINCE_ADCODE = {
  '北京':'110000','天津':'120000','河北':'130000','山西':'140000','内蒙古':'150000',
  '辽宁':'210000','吉林':'220000','黑龙江':'230000','上海':'310000','江苏':'320000',
  '浙江':'330000','安徽':'340000','福建':'350000','江西':'360000','山东':'370000',
  '河南':'410000','湖北':'420000','湖南':'430000','广东':'440000','广西':'450000',
  '海南':'460000','重庆':'500000','四川':'510000','贵州':'520000','云南':'530000',
  '西藏':'540000','陕西':'610000','甘肃':'620000','青海':'630000','宁夏':'640000',
  '新疆':'650000','台湾':'710000','香港':'810000','澳门':'820000',
}

const FULL_TO_SHORT = {
  '北京市':'北京','天津市':'天津','上海市':'上海','重庆市':'重庆',
  '河北省':'河北','山西省':'山西','辽宁省':'辽宁','吉林省':'吉林',
  '黑龙江省':'黑龙江','江苏省':'江苏','浙江省':'浙江','安徽省':'安徽',
  '福建省':'福建','江西省':'江西','山东省':'山东','河南省':'河南',
  '湖北省':'湖北','湖南省':'湖南','广东省':'广东','海南省':'海南',
  '四川省':'四川','贵州省':'贵州','云南省':'云南','陕西省':'陕西',
  '甘肃省':'甘肃','青海省':'青海','台湾省':'台湾',
  '内蒙古自治区':'内蒙古','广西壮族自治区':'广西','西藏自治区':'西藏',
  '宁夏回族自治区':'宁夏','新疆维吾尔自治区':'新疆',
  '香港特别行政区':'香港','澳门特别行政区':'澳门',
}

const chartRef = ref(null)
const amapRef = ref(null)
const total = ref(0)
const drillLevel = ref('china')
const provinceName = ref('')
const cityName = ref('')
const districtName = ref('')
const loading = ref(false)
const storesLocs = ref([])
const customPins = ref([])

// 工具栏状态
const statusFilter = ref('')

// 自定义点位
const placingMode = ref(false)
const pinDialogVisible = ref(false)
const pinType = ref('pin') // 'pin' | 'store'
const pinSaving = ref(false)
const pinForm = ref(null)
const editingPinId = ref(null)
const editingStoreId = ref(null)

let chart = null
let amap = null
let amapPolygons = []
let amapMarkers = []
let currentInfoWin = null
let provinceCache = null
let cityCache = null

// 图钉光标 SVG
const PIN_CURSOR = 'crosshair'

const breadcrumb = computed(() => {
  if (drillLevel.value === 'district') return provinceName.value + ' · ' + cityName.value + ' · ' + districtName.value + ' · '
  if (drillLevel.value === 'city') return provinceName.value + ' · ' + cityName.value + ' · '
  if (drillLevel.value === 'province') return provinceName.value + ' · '
  return ''
})

function normalize(n) { return (n||'').replace(/[省市区县]$/,'').replace(/自治区$/,'').replace(/特别行政区$/,'') }

// ═══ ECharts（全国 / 省 / 市） — 仅区域着色，不标记红点 ═══
function renderECharts(mapName, dataList) {
  if (!chart) {
    chart = echarts.init(chartRef.value)
    window.addEventListener('resize', () => chart?.resize())
    chart.on('click', (p) => {
      if (!p.name || p.seriesType !== 'map') return
      if (drillLevel.value === 'china') drillToProvince(p.name)
      else if (drillLevel.value === 'province') drillToCity(p.name)
      else if (drillLevel.value === 'city') drillToDistrict(p.name)
    })
  }
  const maxVal = Math.max(1, ...dataList.map(d => d.value || 0))
  chart.setOption({
    tooltip: { trigger:'item', formatter: p => `${p.name}<br/>门店数：<b>${p.data?.value??0}</b>` },
    visualMap: { min:0, max:maxVal, left:16, bottom:16, text:['多','少'],
      inRange:{color:['#7bbdf5','#409EFF','#1a6dd4','#083d7a']}, calculable:false },
    series: [{ type:'map', map:mapName, roam:true, scaleLimit:{min:0.6,max:10}, selectedMode:false,
      emphasis:{ label:{show:true,color:'#fff',fontSize:14,fontWeight:'bold'}, itemStyle:{areaColor:'#0a52a7'} },
      data:dataList, label:{show:false}, itemStyle:{areaColor:'#e0e0e0',borderColor:'#fff',borderWidth:1},
    }],
  }, true)
}

// ═══ 高德（仅区级） ═══
function waitForAMap(ms = 20000) {
  return new Promise((ok, fail) => {
    const t0 = Date.now()
    if (window.AMap) return ok()
    const t = setInterval(() => {
      if (window.AMap) { clearInterval(t); ok() }
      else if (Date.now() - t0 > ms) { clearInterval(t); fail(new Error('AMap 加载超时')) }
    }, 200)
  })
}

function clearMarkers() {
  amapMarkers.forEach(m => { try { m.setMap(null) } catch {} })
  amapMarkers = []
}
function destroyAmap() {
  clearMarkers()
  amapPolygons.forEach(p => { try { p.setMap(null) } catch {} })
  amapPolygons = []
  if (amap) { try { amap.destroy() } catch {}; amap = null }
}

function applyCursor() {
  if (amap) amap.getContainer().style.cursor = placingMode.value ? PIN_CURSOR : ''
}
function refreshMarkers() {
  if (!amap) return
  clearMarkers()
  addMarkersToMap()
}
function addMarkersToMap() {
  // 门店标记
  function storeColor(s) {
    if (s.status === '正常营业') return '#67C23A'
    if (s.status === '筹建中')   return '#E6A23C'
    return '#909399'
  }
  function statusMatch(s) {
    if (!statusFilter.value) return true
    if (statusFilter.value === 'closed') return !['正常营业','筹建中'].includes(s.status)
    return s.status === statusFilter.value
  }
  const filteredLocs = storesLocs.value.filter(statusMatch)
  filteredLocs.forEach(s => {
    try {
      const color = storeColor(s)
      const circle = new window.AMap.Circle({
        center: [s.lng, s.lat], radius: 3000,
        fillColor: color, fillOpacity: 0.06,
        strokeColor: color, strokeWeight: 2, strokeOpacity: 0.6,
        zIndex: 50,
      })
      circle.setMap(amap); amapMarkers.push(circle)
      const marker = new window.AMap.Marker({
        position: [s.lng, s.lat],
        title: `${s.store_name}（${s.status||'未知'}）`,
        offset: new window.AMap.Pixel(0, 0),
        content: `<div style="position:relative;width:0;height:0;">`
          + `<div style="position:absolute;left:0;top:0;transform:translate(-50%,-50%);width:12px;height:12px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.35);"></div>`
          + `<div style="position:absolute;left:0;top:7px;white-space:nowrap;transform:translateX(-50%);font-size:10px;color:#333;text-shadow:0 0 2px #fff;">${s.store_name}</div>`
          + `</div>`,
        zIndex: 200,
      })
      marker.on('click', () => editStoreMarker(s))
      marker.setMap(amap); amapMarkers.push(marker)
    } catch {}
  })
  // 自定义点位
  customPins.value.forEach(p => {
    try {
      const c = p.color || '#409EFF'
      const r = p.radius || 3000
      const circle = new window.AMap.Circle({
        center: [p.lng, p.lat], radius: r,
        fillColor: c, fillOpacity: 0.06,
        strokeColor: c, strokeWeight: 2, strokeOpacity: 0.6,
        zIndex: 49,
      })
      circle.setMap(amap); amapMarkers.push(circle)
      const marker = new window.AMap.Marker({
        position: [p.lng, p.lat],
        title: (p.name||'点位') + (p.remark ? ' — ' + p.remark : ''),
        offset: new window.AMap.Pixel(0, 0),
        content: `<div style="position:relative;width:0;height:0;">`
          + `<div style="position:absolute;left:0;top:0;transform:translate(-50%,-50%);width:14px;height:14px;border-radius:50%;background:${c};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;font-size:8px;color:#fff;">+</div>`
          + `<div style="position:absolute;left:0;top:8px;white-space:nowrap;transform:translateX(-50%);font-size:10px;color:#333;text-shadow:0 0 2px #fff;">${p.name||'点位'}</div>`
          + `</div>`,
        zIndex: 201,
      })
      marker.on('click', () => editPin(p))
      marker.on('rightclick', async () => {
        await deleteMapPin(p.id)
        ElMessage.success('已删除')
        await loadCustomPins()
        refreshMarkers()
      })
      marker.setMap(amap); amapMarkers.push(marker)
    } catch {}
  })
}

function renderAmap(geo, dataList, highlightFeature, locs = []) {
  destroyAmap()
  amap = new window.AMap.Map(amapRef.value, { zoom: 10, resizeEnable: true })

  const dataMap = {}
  dataList.forEach(d => { dataMap[d.name] = d.value || 0 })
  const pick = v => v > 0

  const bounds = new window.AMap.Bounds()

  // 逐区渲染 Polygon：选中区透明无填充，有门店非选中区透明，无门店非选中区灰色
  ;(geo.features || []).forEach(f => {
    const name = f.properties?.name || ''
    const val = dataMap[name] || 0
    const type = f.geometry?.type
    const coords = f.geometry?.coordinates
    if (!coords) return
    try {
      const isHL = highlightFeature && (name === (highlightFeature.properties?.name || ''))
      const hasStore = pick(val)
      const fillColor = (isHL || hasStore) ? 'transparent' : '#999'
      const fillOpacity = (isHL || hasStore) ? 0 : 0.55
      const strokeColor = (isHL || hasStore) ? '#409EFF' : '#ccc'
      const strokeWeight = (isHL || hasStore) ? 2 : 1
      const zIdx = (isHL || hasStore) ? 150 : 10

      const addPoly = (path) => {
        path.forEach(p => bounds.extend(p))
        const poly = new window.AMap.Polygon({
          path, fillColor, fillOpacity,
          strokeColor, strokeWeight, strokeOpacity: 1, zIndex: zIdx,
        })
        poly.setMap(amap)
        amapPolygons.push(poly)
      }

      if (type === 'Polygon') coords.forEach(r => addPoly(r.map(c => [c[0], c[1]])))
      else if (type === 'MultiPolygon') {
        coords.forEach(polygonCoords => {
          polygonCoords.forEach(r => addPoly(r.map(c => [c[0], c[1]])))
        })
      }
    } catch {}
  })

  // 阻止浏览器右键菜单
  amap.getContainer().addEventListener('contextmenu', e => e.preventDefault())

  // 地图完全初始化后居中
  amap.on('complete', () => {
    try {
      if (highlightFeature) {
        const c = featureCenter(highlightFeature)
        if (c) amap.setZoomAndCenter(13, c)
      } else if (!bounds.isEmpty()) {
        amap.setZoomAndCenter(10, bounds.getCenter())
      }
    } catch {}
  })

  // 地图点击 → 标点模式
  amap.on('click', async (e) => {
    if (!placingMode.value) return
    const lng = e.lnglat.lng
    const lat = e.lnglat.lat
    try {
      const existing = customPins.value.filter(p => /^自定义点位\d+$/.test(p.name||''))
      const maxN = existing.reduce((max, p) => Math.max(max, parseInt((p.name||'').replace('自定义点位','')) || 0), 0)
      const autoName = `自定义点位${maxN + 1}`
      await createMapPin({ lng, lat, name: autoName, remark: '', color: '#409EFF', radius: 3000 })
      ElMessage.success(`${autoName} 已添加`)
      await loadCustomPins()
      refreshMarkers()
    } catch (err) { ElMessage.error('保存失败: ' + (err?.message || err)) }
  })

  // 右键 → 退出标点模式（静默，无弹窗）
  amap.on('rightclick', () => {
    if (placingMode.value) { placingMode.value = false; applyCursor() }
  })

  applyCursor()
  addMarkersToMap()
}

// 计算 feature 的几何中心坐标
function featureCenter(feature) {
  try {
    const type = feature.geometry?.type
    const coords = feature.geometry?.coordinates
    if (!coords) return null
    const ring = type === 'Polygon' ? coords[0] : type === 'MultiPolygon' ? coords[0]?.[0] : null
    if (!ring?.length) return null
    const sum = ring.reduce((a, c) => [a[0]+c[0], a[1]+c[1]], [0,0])
    return [sum[0]/ring.length, sum[1]/ring.length] // [lng, lat]
  } catch { return null }
}

// 计算 feature 的边界（保留用于其他用途）
function featureBounds(feature) {
  try {
    const b = new window.AMap.Bounds()
    const type = feature.geometry?.type
    const coords = feature.geometry?.coordinates
    if (!coords) return null
    const flat = type === 'Polygon' ? [coords[0]] : type === 'MultiPolygon' ? coords.map(p => p[0]) : []
    flat.forEach(ring => ring.forEach(c => b.extend([c[0], c[1]])))
    return b
  } catch { return null }
}

// ═══ 导航 ═══
async function loadChina() {
  destroyAmap()
  loading.value = true
  try {
    const [geo, stats] = await Promise.all([
      fetch(`${GEO_BASE}/100000_full.json`).then(r=>r.json()),
      getProvinceStats().catch(()=>({data:[]})),
    ])
    if (!chartRef.value || !geo) return
    const dl = (stats.data||[]).map(d=>({name:d.name,value:d.value}))
    drillLevel.value='china'; provinceName.value=''; cityName.value=''; districtName.value=''
    total.value = dl.reduce((s,d)=>s+d.value,0)
    echarts.registerMap('china',geo); renderECharts('china',dl)
  } finally { loading.value = false }
}

async function drillToProvince(name) {
  if (drillLevel.value!=='china') return
  destroyAmap()
  const adcode = PROVINCE_ADCODE[FULL_TO_SHORT[name]||name]; if(!adcode)return
  if (provinceCache?.name===name) {
    drillLevel.value='province'; provinceName.value=name; cityName.value=''; districtName.value=''
    total.value=provinceCache.dataList.reduce((s,d)=>s+d.value,0)
    echarts.registerMap(name,provinceCache.geo); renderECharts(name,provinceCache.dataList); return
  }
  loading.value = true
  try {
    const [geo,stats] = await Promise.all([
      fetch(`${GEO_BASE}/${adcode}_full.json`).then(r=>r.json()),
      getCityStats(name).catch(()=>({data:[]})),
    ])
    if (!chartRef.value||!geo) return
    const dl = stats.data||[]; provinceCache={name,geo,dataList:dl}
    drillLevel.value='province'; provinceName.value=name; cityName.value=''; districtName.value=''
    total.value=dl.reduce((s,d)=>s+d.value,0)
    echarts.registerMap(name,geo); renderECharts(name,dl)
  } finally { loading.value = false }
}

// ═══ 市 → 区（ECharts 图表样式） ═══
async function drillToCity(name) {
  if (drillLevel.value!=='province'||!provinceCache) return
  const features = provinceCache.geo.features||[]
  const f = features.find(x=>normalize(x.properties?.name||'')===normalize(name)||x.properties?.name===name)
  const adcode = f?.properties?.adcode; if(!adcode) return
  if (cityCache?.name===name) {
    destroyAmap()
    drillLevel.value='city'; cityName.value=name; districtName.value=''
    total.value=cityCache.dataList.reduce((s,d)=>s+d.value,0)
    echarts.registerMap(name,cityCache.geo); renderECharts(name,cityCache.dataList); return
  }
  loading.value = true
  try {
    const [geo,stats] = await Promise.all([
      fetch(`${GEO_BASE}/${adcode}_full.json`).then(r=>r.json()),
      getDistrictStats(provinceName.value, name).catch(()=>({data:[]})),
    ])
    if (!chartRef.value||!geo) return
    const dl = stats.data||[]; cityCache={name,geo,dataList:dl}
    destroyAmap()
    drillLevel.value='city'; cityName.value=name; districtName.value=''
    total.value=dl.reduce((s,d)=>s+d.value,0)
    echarts.registerMap(name,geo); renderECharts(name,dl)
  } finally { loading.value = false }
}

// ═══ 区 → 高德真实 2D 地图 ═══
async function drillToDistrict(name) {
  if (drillLevel.value!=='city'||!cityCache) return
  const features = cityCache.geo.features||[]
  const f = features.find(x=>normalize(x.properties?.name||'')===normalize(name)||x.properties?.name===name)
  if (!f) return

  loading.value = true
  try {
    await waitForAMap()
    // 获取该市各区门店位置（仅高德 2D 地图标记红点）
    const locs = await getStoreLocations({ province: provinceName.value, city: cityName.value }).catch(()=>({data:[]}))
    storesLocs.value = locs.data || []
    // 加载自定义点位
    customPins.value = await getMapPins({ province: provinceName.value, city: cityName.value }).then(r => r.data).catch(() => [])
    // 获取该市下各区真实门店数量
    const stats = await getDistrictStats(provinceName.value, cityName.value).catch(()=>({data:[]}))
    const statsMap = {}
    ;(stats.data||[]).forEach(d => { statsMap[normalize(d.name)] = d.value || 0 })

    const geo = cityCache.geo
    const dataList = features.map(f => {
      const fName = f.properties?.name || ''
      return { name: fName, value: statsMap[normalize(fName)] || 0 }
    })
    drillLevel.value='district'; districtName.value=name
    total.value = dataList.reduce((s,d)=>s+d.value, 0)
    // nextTick 后等一帧确保浏览器完成布局，高德地图需要 div 有实际尺寸
    await nextTick()
    await new Promise(r => requestAnimationFrame(r))
    if (!amapRef.value) return
    renderAmap(geo, dataList, f, storesLocs.value)
  } catch(e) {
    console.error('高德地图加载失败:', e)
  } finally { loading.value = false }
}

function backToPrevious() {
  if (drillLevel.value==='district') {
    destroyAmap()
    const c = cityCache
    if (c) {
      drillLevel.value='city'; districtName.value=''
      total.value=c.dataList.reduce((s,d)=>s+d.value,0)
      echarts.registerMap(c.name,c.geo); renderECharts(c.name,c.dataList)
    }
  } else if (drillLevel.value==='city') {
    destroyAmap()
    const c = provinceCache
    if (c) {
      drillLevel.value='province'; cityName.value=''; districtName.value=''
      total.value=c.dataList.reduce((s,d)=>s+d.value,0)
      echarts.registerMap(c.name,c.geo); renderECharts(c.name,c.dataList)
    } else { drillToProvince(provinceName.value) }
  } else if (drillLevel.value==='province') { cityCache=null; provinceCache=null; loadChina() }
}

// ═══ 自定义点位 CRUD ═══
function togglePlacingMode() {
  if (placingMode.value) {
    placingMode.value = false
    applyCursor()
    ElMessage.info('已退出标点模式')
  } else {
    placingMode.value = true
    applyCursor()
    ElMessage.info('在地图上点击放置标记，ESC 或右键退出')
  }
}
function editPin(p) {
  pinType.value = 'pin'
  editingPinId.value = p.id
  pinForm.value = { name: p.name, remark: p.remark, color: p.color, radius: p.radius, created_by: p.created_by, lng: p.lng, lat: p.lat }
  pinDialogVisible.value = true
}
function editStoreMarker(s) {
  pinType.value = 'store'
  editingStoreId.value = s.id
  pinForm.value = { store_name: s.store_name, remark: s.remark || '' }
  pinDialogVisible.value = true
}
async function savePin() {
  if (!pinForm.value) return
  pinSaving.value = true
  try {
    if (pinType.value === 'store') {
      await updateStore(editingStoreId.value, { remark: pinForm.value.remark })
      // 同步更新本地 storesLocs 中的 remark
      const idx = storesLocs.value.findIndex(s => s.id === editingStoreId.value)
      if (idx >= 0) storesLocs.value[idx].remark = pinForm.value.remark
      ElMessage.success('备注已保存')
    } else {
      await updateMapPin(editingPinId.value, pinForm.value)
      ElMessage.success('点位已更新')
      await loadCustomPins()
    }
    pinDialogVisible.value = false
    refreshMarkers()
  } catch (e) { ElMessage.error('保存失败: ' + e.message) }
  finally { pinSaving.value = false }
}
async function deletePin() {
  try {
    await ElMessageBox.confirm('确定删除该点位？', '确认', { type: 'warning' })
    await deleteMapPin(editingPinId.value)
    ElMessage.success('已删除')
    pinDialogVisible.value = false
    await loadCustomPins()
    refreshMarkers()
  } catch {}
}
async function loadCustomPins() {
  if (drillLevel.value !== 'district') return
  const { data } = await getMapPins({ province: provinceName.value, city: cityName.value }).catch(() => ({ data: [] }))
  customPins.value = data || []
}

// 监听状态筛选变化 → 只刷新标记，不重建地图
watch(statusFilter, () => { refreshMarkers() })

// ESC 退出标点模式
function onKeyDown(e) { if (e.key === 'Escape' && placingMode.value) { placingMode.value = false; applyCursor(); ElMessage.info('已退出标点模式') } }
onMounted(() => { loadChina(); document.addEventListener('keydown', onKeyDown) })
onBeforeUnmount(() => { chart?.dispose(); destroyAmap(); document.removeEventListener('keydown', onKeyDown) })

// 清空所有自定义标记
async function clearAllPins() {
  try {
    await ElMessageBox.confirm('确定删除所有自定义标记？此操作不可恢复', '确认', { type: 'warning' })
    const ids = customPins.value.map(p => p.id)
    for (const id of ids) { await deleteMapPin(id).catch(() => {}) }
    ElMessage.success(`已清空 ${ids.length} 个标记`)
    await loadCustomPins()
    refreshMarkers()
  } catch {}
}

</script>
