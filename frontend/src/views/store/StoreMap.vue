<template>
  <div class="card-compact">
    <div class="card-header">
      🗺️ {{ breadcrumb }}门店分布（共 {{ total }} 家）
      <el-button v-if="drillLevel !== 'china'" size="small" type="primary" plain style="float:right;" @click="backToPrevious">
        ← 返回{{ drillLevel === 'city' ? '市级' : '全国' }}
      </el-button>
    </div>
    <div v-loading="loading" style="min-height:620px;position:relative;">
      <div v-show="drillLevel !== 'city'" ref="chartRef" style="width:100%;height:620px;"></div>
      <div v-show="drillLevel === 'city'" ref="amapRef" style="width:100%;height:620px;"></div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import * as echarts from 'echarts'
import { getProvinceStats, getCityStats, getDistrictStats } from '@/api'

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
const loading = ref(false)

let chart = null
let amap = null
let amapPolygons = []
let provinceCache = null

const breadcrumb = computed(() => {
  if (drillLevel.value === 'city') return provinceName.value + ' · ' + cityName.value + ' · '
  if (drillLevel.value === 'province') return provinceName.value + ' · '
  return ''
})

function normalize(n) { return (n||'').replace(/[省市区县]$/,'').replace(/自治区$/,'').replace(/特别行政区$/,'') }

// ═══ ECharts（全国/省/市） ═══
function renderECharts(mapName, dataList) {
  if (!chart) {
    chart = echarts.init(chartRef.value)
    window.addEventListener('resize', () => chart?.resize())
    chart.on('click', (p) => {
      if (!p.name || p.seriesType !== 'map') return
      if (drillLevel.value === 'china') drillToProvince(p.name)
      else if (drillLevel.value === 'province') drillToCity(p.name)
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

function destroyAmap() {
  amapPolygons.forEach(p => { try { p.setMap(null) } catch {} })
  amapPolygons = []
  if (amap) { try { amap.destroy() } catch {}; amap = null }
}

function renderAmap(geo, dataList) {
  destroyAmap()
  amap = new window.AMap.Map(amapRef.value, { zoom: 10, resizeEnable: true })

  const dataMap = {}; const maxVal = Math.max(1, ...dataList.map(d => d.value || 0))
  dataList.forEach(d => { dataMap[d.name] = d.value || 0 })

  const pick = v => v > 0

  const bounds = new window.AMap.Bounds()
  ;(geo.features || []).forEach(f => {
    const name = f.properties?.name || ''
    const val = dataMap[name] || 0
    const type = f.geometry?.type
    const coords = f.geometry?.coordinates

    if (!coords) return
    try {
      if (type === 'Polygon') {
        coords.forEach(ring => {
          const path = ring.map(c => [c[0], c[1]])
          path.forEach(p => bounds.extend(p))
          const has = pick(val)
          const poly = new window.AMap.Polygon({
            path,
            fillColor: has ? 'transparent' : '#999',
            fillOpacity: has ? 0 : 0.55,
            strokeColor: has ? '#409EFF' : '#ccc',
            strokeWeight: has ? 2 : 1,
            strokeOpacity: 1,
          })
          poly.on('click', () => {})
          poly.setMap(amap)
          amapPolygons.push(poly)
        })
      } else if (type === 'MultiPolygon') {
        coords.forEach(polygon => {
          polygon[0].forEach(ring => {
            const path = ring.map(c => [c[0], c[1]])
            path.forEach(p => bounds.extend(p))
          })
        })
        const ring = coords[0]?.[0]
        if (ring) {
          const path = ring.map(c => [c[0], c[1]])
          const has = pick(val)
          const poly = new window.AMap.Polygon({
            path,
            fillColor: has ? 'transparent' : '#999',
            fillOpacity: has ? 0 : 0.55,
            strokeColor: has ? '#409EFF' : '#ccc',
            strokeWeight: has ? 2 : 1,
            strokeOpacity: 1,
          })
          poly.on('click', () => {})
          poly.setMap(amap)
          amapPolygons.push(poly)
        }
      }
    } catch {}
  })

  try { amap.setFitView(null, false, [60, 60, 60, 60]) } catch {}
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
    drillLevel.value='china'; provinceName.value=''; cityName.value=''
    total.value = dl.reduce((s,d)=>s+d.value,0)
    echarts.registerMap('china',geo); renderECharts('china',dl)
  } finally { loading.value = false }
}

async function drillToProvince(name) {
  if (drillLevel.value!=='china') return
  destroyAmap()
  const adcode = PROVINCE_ADCODE[FULL_TO_SHORT[name]||name]; if(!adcode)return
  if (provinceCache?.name===name) {
    drillLevel.value='province'; provinceName.value=name; cityName.value=''
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
    drillLevel.value='province'; provinceName.value=name; cityName.value=''
    total.value=dl.reduce((s,d)=>s+d.value,0)
    echarts.registerMap(name,geo); renderECharts(name,dl)
  } finally { loading.value = false }
}

async function drillToCity(name) {
  if (drillLevel.value!=='province'||!provinceCache) return
  const features = provinceCache.geo.features||[]
  const f = features.find(x=>normalize(x.properties?.name||'')===normalize(name)||x.properties?.name===name)
  const adcode = f?.properties?.adcode; if(!adcode) return

  loading.value = true
  try {
    // 先加载 AMap
    await waitForAMap()
    const [geo, stats] = await Promise.all([
      fetch(`${GEO_BASE}/${adcode}_full.json`).then(r=>r.json()),
      getDistrictStats(provinceName.value, name).catch(()=>({data:[]})),
    ])
    if (!geo) return
    drillLevel.value='city'; cityName.value=name
    total.value = (stats.data||[]).reduce((s,d)=>s+d.value,0)
    await nextTick(); if (!amapRef.value) return
    renderAmap(geo, stats.data||[])
  } finally { loading.value = false }
}

function backToPrevious() {
  if (drillLevel.value==='city') {
    destroyAmap()
    const c = provinceCache
    if (c) {
      drillLevel.value='province'; cityName.value=''
      total.value=c.dataList.reduce((s,d)=>s+d.value,0)
      echarts.registerMap(c.name,c.geo); renderECharts(c.name,c.dataList)
    } else { drillToProvince(provinceName.value) }
  } else if (drillLevel.value==='province') { provinceCache=null; loadChina() }
}

onMounted(() => loadChina())
onBeforeUnmount(() => { chart?.dispose(); destroyAmap() })
</script>
