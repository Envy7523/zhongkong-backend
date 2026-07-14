<template>
  <div class="card-compact">
    <div class="card-header">
      🗺️ {{ isDrill ? provinceName + ' · ' : '' }}门店分布（共 {{ total }} 家）
      <el-button v-if="isDrill" size="small" type="primary" plain style="float:right;" @click="backToChina">
        ← 返回全国
      </el-button>
    </div>
    <div v-loading="loading" style="min-height:620px;">
      <div ref="chartRef" style="width:100%;height:620px;"></div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import * as echarts from 'echarts'
import { getProvinceStats, getCityStats } from '@/api'

const GEO_BASE = 'https://geo.datav.aliyun.com/areas_v3/bound'

// 省份名 → adcode（阿里云 DataV）
const PROVINCE_ADCODE = {
  '北京': '110000', '天津': '120000', '河北': '130000', '山西': '140000', '内蒙古': '150000',
  '辽宁': '210000', '吉林': '220000', '黑龙江': '230000', '上海': '310000', '江苏': '320000',
  '浙江': '330000', '安徽': '340000', '福建': '350000', '江西': '360000', '山东': '370000',
  '河南': '410000', '湖北': '420000', '湖南': '430000', '广东': '440000', '广西': '450000',
  '海南': '460000', '重庆': '500000', '四川': '510000', '贵州': '520000', '云南': '530000',
  '西藏': '540000', '陕西': '610000', '甘肃': '620000', '青海': '630000', '宁夏': '640000',
  '新疆': '650000', '台湾': '710000', '香港': '810000', '澳门': '820000',
}

// 后端全名 → GeoJSON 简称
const FULL_TO_SHORT = {
  '北京市': '北京', '天津市': '天津', '上海市': '上海', '重庆市': '重庆',
  '河北省': '河北', '山西省': '山西', '辽宁省': '辽宁', '吉林省': '吉林',
  '黑龙江省': '黑龙江', '江苏省': '江苏', '浙江省': '浙江', '安徽省': '安徽',
  '福建省': '福建', '江西省': '江西', '山东省': '山东', '河南省': '河南',
  '湖北省': '湖北', '湖南省': '湖南', '广东省': '广东', '海南省': '海南',
  '四川省': '四川', '贵州省': '贵州', '云南省': '云南', '陕西省': '陕西',
  '甘肃省': '甘肃', '青海省': '青海', '台湾省': '台湾',
  '内蒙古自治区': '内蒙古', '广西壮族自治区': '广西', '西藏自治区': '西藏',
  '宁夏回族自治区': '宁夏', '新疆维吾尔自治区': '新疆',
  '香港特别行政区': '香港', '澳门特别行政区': '澳门',
}

// GeoJSON 简称 → 后端全名
const SHORT_TO_FULL = {}
Object.entries(FULL_TO_SHORT).forEach(([k, v]) => { SHORT_TO_FULL[v] = k })

const chartRef = ref(null)
const total = ref(0)
const isDrill = ref(false)
const provinceName = ref('')
const loading = ref(false)
let chart = null

onMounted(() => loadChina())

// ── 全国地图 ──
async function loadChina() {
  loading.value = true
  try {
    const [geo, stats] = await Promise.all([
      fetch(`${GEO_BASE}/100000_full.json`).then(r => r.json()),
      getProvinceStats().catch(() => ({ data: [] })),
    ])
    if (!chartRef.value || !geo) return

    // DataV GeoJSON 使用全名（如'广东省'），与后端一致，无需转换
    const dataList = (stats.data || []).map(d => ({ name: d.name, value: d.value }))

    isDrill.value = false
    provinceName.value = ''
    total.value = dataList.reduce((s, d) => s + d.value, 0)

    echarts.registerMap('china', geo)
    renderMap('china', dataList)
  } finally {
    loading.value = false
  }
}

// ── 下钻 ──
async function drillTo(name) {
  if (isDrill.value) return
  // name 是 GeoJSON 全名（如'广东省'），找简称查 adcode
  const fullName = name
  const short = FULL_TO_SHORT[name] || name
  const adcode = PROVINCE_ADCODE[short]
  if (!adcode) return

  loading.value = true
  try {
    const [geo, stats] = await Promise.all([
      fetch(`${GEO_BASE}/${adcode}_full.json`).then(r => r.json()),
      getCityStats(fullName).catch(() => ({ data: [] })),
    ])
    if (!chartRef.value || !geo) return

    if (!stats.data || stats.data.length === 0) {
      alert(`"${fullName}"暂无详细门店数据`)
      loading.value = false
      return
    }

    isDrill.value = true
    provinceName.value = fullName
    total.value = stats.data.reduce((s, d) => s + d.value, 0)

    echarts.registerMap(fullName, geo)
    renderMap(fullName, stats.data)
  } finally {
    loading.value = false
  }
}

// ── 返回全国 ──
function backToChina() {
  loadChina()
}

// ── 渲染地图 ──
function renderMap(mapName, dataList) {
  if (!chart) {
    chart = echarts.init(chartRef.value)
    window.addEventListener('resize', () => chart?.resize())

    chart.on('click', (params) => {
      if (!isDrill.value && params.name && params.seriesType === 'map') {
        drillTo(params.name)
      }
    })
  }

  const maxVal = Math.max(1, ...dataList.map(d => d.value || 0))

  chart.setOption({
    tooltip: {
      trigger: 'item',
      formatter: (p) => `${p.name}<br/>门店数：<b>${p.data?.value ?? 0}</b>`,
    },
    visualMap: {
      min: 0,
      max: maxVal,
      left: 16,
      bottom: 16,
      text: ['多', '少'],
      inRange: { color: ['#7bbdf5', '#409EFF', '#1a6dd4', '#083d7a'] },
      calculable: false,
    },
    series: [{
      type: 'map',
      map: mapName,
      roam: true,
      scaleLimit: { min: 0.6, max: 10 },
      selectedMode: false,
      emphasis: {
        label: { show: true, color: '#fff', fontSize: 14, fontWeight: 'bold' },
        itemStyle: { areaColor: '#0a52a7' },
      },
      data: dataList,
      label: { show: false },
      itemStyle: { areaColor: '#e0e0e0', borderColor: '#fff', borderWidth: 1 },
    }],
  }, true)
}

onBeforeUnmount(() => { chart?.dispose() })
</script>
