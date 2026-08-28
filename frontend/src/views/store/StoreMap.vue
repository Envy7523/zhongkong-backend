<template>
  <div class="store-map-page">
    <section class="map-hero">
      <div>
        <div class="map-eyebrow">STORE NETWORK</div>
        <h2>全国门店地图</h2>
        <p>从全国经营版图逐级下钻到街区点位，查看门店状态、商圈范围与协作记录。</p>
      </div>
      <div class="hero-metrics">
        <div class="hero-metric">
          <span>当前层级门店</span>
          <strong>{{ total }}</strong>
        </div>
        <div class="hero-metric" v-if="drillLevel === 'district'">
          <span>正常营业</span>
          <strong class="success">{{ activeStoreCount }}</strong>
        </div>
        <div class="hero-metric" v-if="drillLevel === 'district'">
          <span>自定义点位</span>
          <strong class="accent">{{ customPins.length }}</strong>
        </div>
      </div>
    </section>

    <section class="map-workspace">
      <header class="workspace-header">
        <nav class="level-breadcrumb" aria-label="地图层级导航">
          <button
            v-for="(item, index) in levelTrail"
            :key="item.level"
            :class="{ active: item.level === drillLevel, reachable: index < levelIndex }"
            :disabled="index > levelIndex"
            @click="navigateToLevel(item.level)"
          >
            <span class="level-dot">{{ index + 1 }}</span>
            <span>
              <small>{{ item.caption }}</small>
              <b>{{ item.label }}</b>
            </span>
          </button>
        </nav>
        <div class="workspace-actions">
          <span class="map-live-dot"></span>
          <span>数据已连接</span>
          <el-button v-if="drillLevel !== 'china'" plain round @click="backToPrevious">返回上一级</el-button>
        </div>
      </header>

      <div class="map-layout">
        <aside class="map-side-panel">
          <div class="side-section">
            <span class="side-kicker">当前视图</span>
            <h3>{{ currentRegionTitle }}</h3>
            <p>{{ currentLevelHint }}</p>
          </div>

          <template v-if="drillLevel === 'district'">
            <div class="side-section filter-section">
              <div class="side-title">
                <span>门店筛选</span>
                <button v-if="statusFilter || storeTypeFilter" @click="resetFilters">重置</button>
              </div>
              <el-select v-model="statusFilter" placeholder="全部营业状态" clearable>
                <el-option label="正常营业" value="正常营业" />
                <el-option label="筹建中" value="筹建中" />
                <el-option label="已闭店 / 迁址" value="closed" />
              </el-select>
              <el-select v-model="storeTypeFilter" placeholder="全部门店类型" clearable>
                <el-option label="直营店" value="直营店" />
                <el-option label="加盟店" value="加盟店" />
                <el-option label="联营店" value="联营店" />
              </el-select>
              <div class="filter-result">
                <span>地图显示</span>
                <strong>{{ filteredStoreCount }} / {{ storesLocs.length }} 家</strong>
              </div>
            </div>

            <div class="side-section pin-section">
              <div class="side-title">
                <span>协作点位</span>
                <em>{{ customPins.length }}</em>
              </div>
              <button
                class="place-pin-button"
                :class="{ active: placingMode }"
                @click="togglePlacingMode"
              >
                <span class="place-pin-icon">{{ placingMode ? '×' : '+' }}</span>
                <span>
                  <b>{{ placingMode ? '退出标点模式' : '添加自定义点位' }}</b>
                  <small>{{ placingMode ? '也可按 ESC 或鼠标右键退出' : '在地图上选择位置后完善信息' }}</small>
                </span>
              </button>
              <div v-if="customPins.length" class="pin-list">
                <button v-for="p in customPins" :key="p.id" @click="flyToPin(p)">
                  <span class="pin-swatch" :style="{ background: p.color || '#4f7cff' }"></span>
                  <span class="pin-list-copy">
                    <b>{{ p.name || '未命名点位' }}</b>
                    <small>{{ p.remark || `${p.radius || 3000}m 商圈` }}</small>
                  </span>
                  <span class="pin-arrow">›</span>
                </button>
              </div>
              <div v-else class="empty-pin-list">还没有协作点位</div>
            </div>
          </template>

          <div v-else class="side-section drill-guide">
            <div class="guide-icon">⌁</div>
            <b>点击地图区域继续下钻</b>
            <span>{{ nextLevelLabel }}</span>
          </div>

          <div class="side-section legend-section">
            <div class="side-title"><span>图例</span></div>
            <div v-if="drillLevel === 'district'" class="legend-grid">
              <span><i class="legend-dot operating"></i>正常营业</span>
              <span><i class="legend-dot preparing"></i>筹建中</span>
              <span><i class="legend-dot closed"></i>闭店 / 迁址</span>
              <span><i class="legend-dot custom"></i>自定义点位</span>
            </div>
            <div v-else class="gradient-legend">
              <span>门店少</span><i></i><span>门店多</span>
            </div>
          </div>
        </aside>

        <main class="map-stage" v-loading="loading">
          <div class="map-stage-top">
            <div>
              <span class="stage-label">{{ levelCaption }}</span>
              <strong>{{ currentRegionTitle }}</strong>
            </div>
            <div class="stage-tools">
              <span v-if="drillLevel !== 'district'">滚轮缩放 · 拖拽浏览 · 点击下钻</span>
              <span v-else>点击标记查看详情 · 拖拽与缩放地图</span>
            </div>
          </div>

          <div class="map-canvas-wrap" :class="{ 'is-transitioning': levelAnimating }">
            <div v-show="drillLevel !== 'district'" ref="chartRef" class="map-canvas"></div>
            <div v-show="drillLevel === 'district'" ref="amapRef" class="map-canvas amap-canvas"></div>
            <div v-if="levelAnimating" class="map-transition-shade">
              <span></span>
              <small>{{ transitionDirection === 'forward' ? '正在进入下一级地图' : '正在返回上一级地图' }}</small>
            </div>
            <div v-if="placingMode" class="placing-mode-banner">
              <span class="placing-pulse"></span>
              <div><b>{{ draftPin ? '已选中点位' : '标点模式已开启' }}</b><small>{{ draftPin ? '可继续点击地图或拖动标记微调位置' : '点击地图任意位置创建点位草稿' }}</small></div>
              <div v-if="draftPin" class="draft-actions"><el-button size="small" @click="clearDraftPin">重新选择</el-button><el-button size="small" type="primary" @click="confirmDraftPin">确认此位置</el-button></div>
              <kbd>ESC</kbd>
            </div>
          </div>
        </main>
      </div>
    </section>

    <el-dialog
      v-model="pinDialogVisible"
      class="pin-editor-dialog"
      :title="pinDialogTitle"
      width="620px"
      align-center
    >
      <div v-if="pinForm" class="pin-editor">
        <div class="pin-editor-preview">
          <span
            class="preview-pin"
            :class="pinForm.shape || 'circle'"
            :style="{ '--pin-color': pinForm.color || '#4f7cff' }"
          >{{ pinForm.shape === 'star' ? '★' : '' }}</span>
          <div>
            <b>{{ pinForm.store_name || pinForm.name || '未命名点位' }}</b>
            <small>{{ pinForm.lng?.toFixed(6) }}, {{ pinForm.lat?.toFixed(6) }}</small>
          </div>
          <el-button text @click="copyCoord">复制坐标</el-button>
        </div>

        <el-form label-position="top">
          <el-form-item v-if="pinType === 'pin'" label="点位名称">
            <el-input v-model="pinForm.name" maxlength="30" show-word-limit placeholder="例如：备选店址、商场入口" />
          </el-form-item>
          <el-form-item v-else label="门店名称">
            <el-input :model-value="pinForm.store_name" disabled />
          </el-form-item>
          <el-form-item label="备注说明">
            <el-input v-model="pinForm.remark" type="textarea" :rows="3" maxlength="200" show-word-limit placeholder="记录位置价值、客流情况或跟进事项" />
          </el-form-item>

          <div class="editor-grid">
            <el-form-item v-if="pinType === 'pin'" label="标记形状">
              <div class="shape-picker">
                <button
                  v-for="s in shapeOptions"
                  :key="s.value"
                  type="button"
                  :class="{ active: pinForm.shape === s.value }"
                  @click="pinForm.shape = s.value"
                >
                  <i :class="s.value" :style="{ '--choice-color': pinForm.color }">{{ s.value === 'star' ? '★' : '' }}</i>
                  {{ s.label }}
                </button>
              </div>
            </el-form-item>
            <el-form-item v-if="pinType === 'pin'" label="标记颜色">
              <div class="color-picker">
                <button
                  v-for="c in presetColors"
                  :key="c"
                  type="button"
                  :class="{ active: pinForm.color === c }"
                  :style="{ background: c }"
                  @click="pinForm.color = c"
                ></button>
              </div>
            </el-form-item>
          </div>

          <div class="editor-grid settings-grid">
            <el-form-item label="商圈半径">
              <el-input-number v-model="pinForm.radius" :min="500" :max="10000" :step="500" />
              <span class="field-suffix">米</span>
            </el-form-item>
            <el-form-item v-if="pinType === 'pin'" label="可见范围">
              <el-segmented
                v-model="pinForm.visibility"
                :options="[{ label: '团队可见', value: 'public' }, { label: '仅自己', value: 'private' }]"
              />
            </el-form-item>
          </div>
        </el-form>
      </div>
      <template #footer>
        <div class="dialog-footer">
          <el-button v-if="pinType === 'pin' && editingPinId" type="danger" text @click="deletePin">删除点位</el-button>
          <span></span>
          <el-button @click="cancelPinEdit">取消</el-button>
          <el-button type="primary" :loading="pinSaving" @click="savePin">
            {{ pinType === 'store' || editingPinId ? '保存修改' : '创建点位' }}
          </el-button>
        </div>
      </template>
    </el-dialog>

    <el-drawer
      v-model="commentDrawerVisible"
      class="map-comment-drawer"
      :title="commentTargetTitle"
      direction="rtl"
      size="420px"
      :modal="false"
      :close-on-click-modal="false"
      @closed="commentTargetClosed"
    >
      <div class="comment-drawer-body">
        <div v-if="commentTarget" class="comment-target-card">
          <div class="comment-target-title">
            <span
              class="pin-swatch"
              :style="{ background: commentTargetType === 'pin' ? (commentTarget.color || '#4f7cff') : (STATUS_COLOR[commentTarget.status] || '#8d96a8') }"
            ></span>
            <strong>{{ commentTarget.name || commentTarget.store_name || '—' }}</strong>
          </div>
          <p>{{ commentTarget.remark || '暂无备注信息' }}</p>
          <div class="comment-target-actions">
            <el-button size="small" @click="openCommentTargetSettings">设置</el-button>
            <el-button size="small" plain @click="focusCommentTargetOnMap">定位到地图</el-button>
          </div>
        </div>

        <div class="comment-list">
          <div v-if="commentList.length === 0" class="comment-empty">
            <b>暂无协作记录</b>
            <span>添加第一条评论，让团队了解这个位置。</span>
          </div>
          <article v-for="c in commentList" :key="c.id" class="comment-item">
            <header>
              <span class="comment-avatar">{{ (c.username || '匿').slice(0, 1) }}</span>
              <div><b>{{ c.username || '匿名' }}</b><small>{{ c.created_at }}</small></div>
              <el-button link type="danger" size="small" @click="removeCommentFromDrawer(c.id)">删除</el-button>
            </header>
            <p>{{ c.content }}</p>
            <el-button link size="small" @click="startReply(c)">回复</el-button>
            <div v-if="c.replies?.length" class="reply-list">
              <div v-for="r in c.replies" :key="r.id">
                <span><b>{{ r.username || '匿名' }}</b><small v-if="r.reply_to_name"> 回复 {{ r.reply_to_name }}</small></span>
                <p>{{ r.content }}</p>
                <el-button link size="small" @click="startReply(r)">回复</el-button>
                <el-button link type="danger" size="small" @click="removeCommentFromDrawer(r.id)">删除</el-button>
              </div>
            </div>
          </article>
        </div>

        <div class="comment-composer">
          <div v-if="replyTarget" class="replying-tip">
            回复 @{{ replyTarget.username || '匿名' }}
            <button @click="cancelReply">取消</button>
          </div>
          <div>
            <el-input v-model="commentText" :placeholder="replyTarget ? '写下回复…' : '添加协作记录…'" @keyup.enter="submitCommentFromDrawer" />
            <el-button type="primary" :loading="commentSubmitting" @click="submitCommentFromDrawer">发送</el-button>
          </div>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import * as echarts from 'echarts'
import { getProvinceStats, getCityStats, getDistrictStats, getStoreLocations, getMapPins, createMapPin, updateMapPin, deleteMapPin, updateStore, getPinComments, addPinComment, deletePinComment, getStoreComments, addStoreComment, deleteStoreComment } from '@/api'
import { ElMessage, ElMessageBox } from 'element-plus'

const GEO_BASE = '/api/geo/bound'

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
const levelAnimating = ref(false)
const transitionDirection = ref('forward')
const storesLocs = ref([])
const customPins = ref([])

// 工具栏状态
const statusFilter = ref('')
const storeTypeFilter = ref('')

// 自定义点位
const placingMode = ref(false)
const draftPin = ref(null)
const pinDialogVisible = ref(false)
const pinType = ref('pin') // 'pin' | 'store'
const pinSaving = ref(false)
const pinForm = ref(null)
const editingPinId = ref(null)
const editingStoreId = ref(null)
const commentText = ref('')
const commentSubmitting = ref(false)
const replyTarget = ref(null) // { id, username } | null

const presetColors = ['#F56C6C','#E6A23C','#F2D024','#67C23A','#409EFF','#9B59B6','#909399','#333333']
const shapeOptions = [
  { value: 'circle',  label: '圆形' },
  { value: 'square',  label: '方形' },
  { value: 'star',    label: '星形' },
  { value: 'diamond', label: '菱形' },
]

let chart = null
let amap = null
let amapPolygons = []
let amapMarkers = []
let draftMarker = null
let provinceCache = null
let cityCache = null
let transitionTimer = null

// 门店状态颜色
const STATUS_COLOR = { '正常营业': '#67C23A', '筹建中': '#E6A23C' }

// ═══ 右侧评论抽屉 ═══
const commentDrawerVisible = ref(false)
const commentTargetType = ref('pin') // 'pin' | 'store'
const commentTarget = ref(null)
const commentList = ref([])

const commentTargetTitle = computed(() => {
  if (!commentTarget.value) return '评论'
  const name = commentTarget.value.name || commentTarget.value.store_name || '—'
  return `💬 ${name} · 评论`
})

function openCommentDrawer(type, target) {
  commentTargetType.value = type
  commentTarget.value = target
  commentDrawerVisible.value = true
  loadCommentsForDrawer()
}
function commentTargetClosed() {
  commentTarget.value = null
  commentList.value = []
  commentText.value = ''
  replyTarget.value = null
}
function openCommentTargetSettings() {
  if (commentTargetType.value === 'pin') {
    pinType.value = 'pin'
    editingPinId.value = commentTarget.value.id
    pinForm.value = { name: commentTarget.value.name, remark: commentTarget.value.remark, color: commentTarget.value.color, radius: commentTarget.value.radius, shape: commentTarget.value.shape||'circle', created_by: commentTarget.value.created_by, lng: commentTarget.value.lng, lat: commentTarget.value.lat, visibility: commentTarget.value.visibility||'public' }
    pinDialogVisible.value = true
  } else {
    pinType.value = 'store'
    editingStoreId.value = commentTarget.value.id
    pinForm.value = {
      store_name: commentTarget.value.store_name,
      remark: commentTarget.value.remark || '',
      lng: commentTarget.value.lng,
      lat: commentTarget.value.lat,
      status: commentTarget.value.status,
      radius: commentTarget.value.radius || 3000,
      color: commentTarget.value.color || '#909399',
      shape: 'circle',
    }
    pinDialogVisible.value = true
  }
}
function focusCommentTargetOnMap() {
  if (!amap || !commentTarget.value) return
  amap.setZoomAndCenter(15, [commentTarget.value.lng, commentTarget.value.lat])
}
async function loadCommentsForDrawer() {
  if (!commentTarget.value) return
  try {
    if (commentTargetType.value === 'pin') {
      const { data } = await getPinComments(commentTarget.value.id).catch(() => ({ data: [] }))
      commentList.value = data || []
    } else {
      const { data } = await getStoreComments(commentTarget.value.id).catch(() => ({ data: [] }))
      commentList.value = data || []
    }
  } catch { commentList.value = [] }
}
async function submitCommentFromDrawer() {
  const text = commentText.value.trim()
  if (!text) return
  commentSubmitting.value = true
  try {
    const parentId = replyTarget.value?.id || null
    const replyToName = replyTarget.value?.username || ''
    if (commentTargetType.value === 'pin') {
      await addPinComment(commentTarget.value.id, text, parentId, replyToName)
    } else {
      await addStoreComment(commentTarget.value.id, text, parentId, replyToName)
    }
    ElMessage.success(replyTarget.value ? '回复已发送' : '评论已发送')
    commentText.value = ''
    replyTarget.value = null
    await loadCommentsForDrawer()
  } catch (e) { ElMessage.error('评论失败: ' + (e?.message || e)) }
  finally { commentSubmitting.value = false }
}
function startReply(c) {
  replyTarget.value = { id: c.id, username: c.username || '匿名' }
  commentText.value = ''
}
function cancelReply() {
  replyTarget.value = null
  commentText.value = ''
}
async function removeCommentFromDrawer(commentId) {
  try {
    await ElMessageBox.confirm('确定删除这条评论？', '确认', { type: 'warning' })
    if (commentTargetType.value === 'pin') {
      await deletePinComment(commentTarget.value.id, commentId)
    } else {
      await deleteStoreComment(commentTarget.value.id, commentId)
    }
    ElMessage.success('已删除')
    await loadCommentsForDrawer()
  } catch {}
}

// 图钉光标
const PIN_CURSOR = 'crosshair'

const LEVELS = ['china', 'province', 'city', 'district']
const levelIndex = computed(() => LEVELS.indexOf(drillLevel.value))
const levelTrail = computed(() => [
  { level: 'china', caption: '全国', label: '中国' },
  { level: 'province', caption: '省级', label: provinceName.value || '选择省份' },
  { level: 'city', caption: '市级', label: cityName.value || '选择城市' },
  { level: 'district', caption: '区级', label: districtName.value || '选择区县' },
])
const currentRegionTitle = computed(() => {
  if (drillLevel.value === 'district') return districtName.value
  if (drillLevel.value === 'city') return cityName.value
  if (drillLevel.value === 'province') return provinceName.value
  return '全国门店网络'
})
const levelCaption = computed(() => ({
  china: '全国经营版图',
  province: '省级门店分布',
  city: '城市门店分布',
  district: '高德 2D 街区地图',
}[drillLevel.value]))
const currentLevelHint = computed(() => ({
  china: '查看各省门店密度，点击省份进入省级视图。',
  province: '比较省内城市布局，点击城市继续下钻。',
  city: '查看各区县门店覆盖，点击区县进入街区地图。',
  district: '管理门店位置、商圈半径与团队协作点位。',
}[drillLevel.value]))
const nextLevelLabel = computed(() => ({
  china: '下一步：选择省份',
  province: '下一步：选择城市',
  city: '下一步：选择区县',
}[drillLevel.value] || ''))
const filteredStores = computed(() => storesLocs.value.filter(matchesStoreFilters))
const filteredStoreCount = computed(() => filteredStores.value.length)
const activeStoreCount = computed(() => storesLocs.value.filter(s => s.status === '正常营业').length)
const pinDialogTitle = computed(() => {
  if (pinType.value === 'store') return '门店地图设置'
  return editingPinId.value ? '编辑协作点位' : '创建协作点位'
})

function normalize(n) { return (n||'').replace(/[省市区县]$/,'').replace(/自治区$/,'').replace(/特别行政区$/,'') }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]))
}
function matchesStoreFilters(s) {
  if (statusFilter.value) {
    if (statusFilter.value === 'closed') {
      if (['正常营业', '筹建中'].includes(s.status)) return false
    } else if (s.status !== statusFilter.value) return false
  }
  return !storeTypeFilter.value || s.store_type === storeTypeFilter.value
}
function resetFilters() {
  statusFilter.value = ''
  storeTypeFilter.value = ''
}
function startLevelTransition(direction = 'forward') {
  clearTimeout(transitionTimer)
  transitionDirection.value = direction
  levelAnimating.value = true
}
function finishLevelTransition() {
  clearTimeout(transitionTimer)
  transitionTimer = setTimeout(() => { levelAnimating.value = false }, 280)
}

async function navigateToLevel(level) {
  const targetIndex = LEVELS.indexOf(level)
  if (targetIndex < 0 || targetIndex >= levelIndex.value) return
  startLevelTransition('back')
  destroyAmap()
  if (level === 'china') {
    await loadChina()
    return
  }
  if (level === 'province' && provinceCache) {
    drillLevel.value = 'province'
    cityName.value = ''
    districtName.value = ''
    total.value = provinceCache.dataList.reduce((sum, item) => sum + item.value, 0)
    echarts.registerMap(provinceCache.name, provinceCache.geo)
    renderECharts(provinceCache.name, provinceCache.dataList)
    finishLevelTransition()
    return
  }
  if (level === 'city' && cityCache) {
    drillLevel.value = 'city'
    districtName.value = ''
    total.value = cityCache.dataList.reduce((sum, item) => sum + item.value, 0)
    echarts.registerMap(cityCache.name, cityCache.geo)
    renderECharts(cityCache.name, cityCache.dataList)
    finishLevelTransition()
  }
}

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
    animation: true,
    animationDuration: 680,
    animationDurationUpdate: 520,
    animationEasing: 'cubicOut',
    animationEasingUpdate: 'cubicInOut',
    tooltip: { trigger:'item', formatter: p => `${p.name}<br/>门店数：<b>${p.data?.value??0}</b>` },
    visualMap: { show:false, min:0, max:maxVal,
      inRange:{color:['#dbe6ff','#86a6ff','#4f7cff','#243d8f']}, calculable:false },
    series: [{ type:'map', map:mapName, roam:true, scaleLimit:{min:0.6,max:10}, selectedMode:false,
      emphasis:{ label:{show:true,color:'#fff',fontSize:13,fontWeight:'bold'}, itemStyle:{areaColor:'#2f55c7',shadowBlur:18,shadowColor:'rgba(47,85,199,.28)'} },
      data:dataList, label:{show:false}, itemStyle:{areaColor:'#e7ebf2',borderColor:'#fff',borderWidth:1.2},
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
  clearDraftPin()
  clearMarkers()
  amapPolygons.forEach(p => { try { p.setMap(null) } catch {} })
  amapPolygons = []
  if (amap) { try { amap.destroy() } catch {}; amap = null }
}

function applyCursor() {
  if (amap) amap.getContainer().style.cursor = placingMode.value ? PIN_CURSOR : ''
}

function clearDraftPin() {
  draftPin.value = null
  if (draftMarker) { try { draftMarker.setMap(null) } catch {}; draftMarker = null }
}

function drawDraftMarker() {
  if (!amap || !draftPin.value) return
  if (draftMarker) { try { draftMarker.setMap(null) } catch {} }
  draftMarker = new window.AMap.Marker({
    position: [draftPin.value.lng, draftPin.value.lat], draggable: true, zIndex: 999,
    // 标记容器左上角向左/向上偏移，使图钉尖端精确落在经纬度坐标上。
    offset: new window.AMap.Pixel(-12, -32),
    content: '<div class="draft-map-pin"><span></span><small>待确认</small></div>',
  })
  draftMarker.on('dragend', e => { draftPin.value = { lng: e.lnglat.lng, lat: e.lnglat.lat }; drawDraftMarker() })
  draftMarker.setMap(amap)
}

function confirmDraftPin() {
  if (!draftPin.value) return
  const { lng, lat } = draftPin.value
  const existing = customPins.value.filter(p => /^自定义点位\d+$/.test(p.name || ''))
  const maxN = existing.reduce((max, p) => Math.max(max, parseInt((p.name || '').replace('自定义点位', '')) || 0), 0)
  pinType.value = 'pin'; editingPinId.value = null
  pinForm.value = { lng, lat, name: `自定义点位${maxN + 1}`, remark: '', color: '#4F7CFF', radius: 3000, shape: 'circle', visibility: 'public', created_by: '' }
  placingMode.value = false; clearDraftPin(); applyCursor(); pinDialogVisible.value = true
}

// 标点模式公共逻辑（map click / circle click 共用）
async function handlePlacingClick(lng, lat) {
  if (!placingMode.value) return
  draftPin.value = { lng, lat }
  drawDraftMarker()
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
  const filteredLocs = filteredStores.value
  filteredLocs.forEach(s => {
    try {
      const color = storeColor(s)
      const circle = new window.AMap.Circle({
        center: [s.lng, s.lat], radius: s.radius || 3000,
        fillColor: color, fillOpacity: 0.06,
        strokeColor: color, strokeWeight: 4, strokeOpacity: 0.9,
        zIndex: 50,
      })
      circle.setMap(amap); amapMarkers.push(circle)
      circle.on('click', (e) => handlePlacingClick(e.lnglat.lng, e.lnglat.lat))
      circle.on('rightclick', () => { if (placingMode.value) { placingMode.value = false; clearDraftPin(); applyCursor() } })
      // 波纹动画
      const ripple = new window.AMap.Marker({
        position: [s.lng, s.lat],
        offset: new window.AMap.Pixel(0, 0),
        content: `<div style="position:relative;width:0;height:0;pointer-events:none;"><div class="map-ripple-ring" style="border-color:${color};animation-delay:0s;"></div><div class="map-ripple-ring" style="border-color:${color};animation-delay:1.75s;"></div></div>`,
        zIndex: 51,
      })
      ripple.setMap(amap); amapMarkers.push(ripple)
      const marker = new window.AMap.Marker({
        position: [s.lng, s.lat],
        title: `${s.store_name}（${s.status||'未知'}）`,
        offset: new window.AMap.Pixel(0, 0),
        content: `<div style="position:relative;width:0;height:0;">`
          + `<div style="position:absolute;left:0;top:0;transform:translate(-50%,-50%);width:12px;height:12px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.35);"></div>`
          + `<div class="map-marker-label">${escapeHtml(s.store_name)}</div>`
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
        strokeColor: c, strokeWeight: 4, strokeOpacity: 0.9,
        zIndex: 49,
      })
      circle.setMap(amap); amapMarkers.push(circle)
      circle.on('click', (e) => handlePlacingClick(e.lnglat.lng, e.lnglat.lat))
      circle.on('rightclick', () => { if (placingMode.value) { placingMode.value = false; clearDraftPin(); applyCursor() } })
      // 波纹动画
      const ripple = new window.AMap.Marker({
        position: [p.lng, p.lat],
        offset: new window.AMap.Pixel(0, 0),
        content: `<div style="position:relative;width:0;height:0;pointer-events:none;"><div class="map-ripple-ring" style="border-color:${c};animation-delay:0s;"></div><div class="map-ripple-ring" style="border-color:${c};animation-delay:1.75s;"></div></div>`,
        zIndex: 50,
      })
      ripple.setMap(amap); amapMarkers.push(ripple)
      const shape = p.shape || 'circle'
      const shapeHtml = {
        circle:   `width:14px;height:14px;border-radius:50%;`,
        square:   `width:14px;height:14px;border-radius:2px;`,
        // 星形本身就是标记，不叠加圆形背景，避免显示成“方块里的星星”。
        star:     `width:24px;height:24px;font-size:25px;line-height:24px;text-align:center;background:transparent!important;border:0!important;box-shadow:none!important;color:${c}!important;`,
        diamond:  `width:12px;height:12px;transform:translate(-50%,-50%) rotate(45deg);border-radius:2px;`,
      }[shape] || `width:14px;height:14px;border-radius:50%;`
      const shapeIcon = shape === 'star' ? '★' : '+'

      const marker = new window.AMap.Marker({
        position: [p.lng, p.lat],
        title: (p.name||'点位') + (p.remark ? ' — ' + p.remark : ''),
        offset: new window.AMap.Pixel(0, 0),
        content: `<div style="position:relative;width:0;height:0;">`
          + `<div style="position:absolute;left:0;top:0;transform:translate(-50%,-50%);${shapeHtml}background:${c};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;font-size:8px;color:#fff;">${shapeIcon}</div>`
          + `<div class="map-marker-label custom-label">${escapeHtml(p.name || '点位')}</div>`
          + `</div>`,
        zIndex: 201,
      })
      marker.on('click', () => editPin(p))
      marker.on('rightclick', () => {
        if (placingMode.value) {
          placingMode.value = false
          clearDraftPin()
          applyCursor()
        }
      })
      marker.setMap(amap); amapMarkers.push(marker)
    } catch {}
  })
}

function renderAmap(geo, dataList, highlightFeature, locs = []) {
  destroyAmap()
  amap = new window.AMap.Map(amapRef.value, {
    zoom: 10,
    zooms: [5, 19],
    resizeEnable: true,
    animateEnable: true,
    jogEnable: true,
    showLabel: true,
  })

  // 收集 bounds + 渲染区域边框 Polygon（低 zIndex，click 转发到标点逻辑）
  const bounds = new window.AMap.Bounds()
  const dataMap = {}
  dataList.forEach(d => { dataMap[d.name] = d.value || 0 })
  const pick = v => v > 0

  ;(geo.features || []).forEach(f => {
    const name = f.properties?.name || ''
    const val = dataMap[name] || 0
    const type = f.geometry?.type
    const coords = f.geometry?.coordinates
    if (!coords) return
    const isHL = highlightFeature && (name === (highlightFeature.properties?.name || ''))
    const hasStore = pick(val)
    const strokeColor = (isHL || hasStore) ? '#F56C6C' : '#ccc'
    const strokeWeight = (isHL || hasStore) ? 2 : 1

    const makePoly = (path, opts) => {
      const p = new window.AMap.Polygon({ path, fillColor: 'transparent', fillOpacity: 0, ...opts })
      p.on('click', (e) => handlePlacingClick(e.lnglat.lng, e.lnglat.lat))
      p.on('rightclick', () => { if (placingMode.value) { placingMode.value = false; clearDraftPin(); applyCursor() } })
      p.setMap(amap)
      amapPolygons.push(p)
    }

    const addBorder = (path) => {
      path.forEach(p => bounds.extend(p))
      if (isHL) {
        // 选中区：光晕 + 粗核心线
        makePoly(path, { strokeColor, strokeWeight: 10, strokeOpacity: 0.2, zIndex: 25 })
        makePoly(path, { strokeColor, strokeWeight: 3, strokeOpacity: 1, zIndex: 26 })
      } else {
        makePoly(path, { strokeColor, strokeWeight, strokeOpacity: 1, zIndex: 30 })
      }
    }

    if (type === 'Polygon') coords.forEach(r => addBorder(r.map(c => [c[0], c[1]])))
    else if (type === 'MultiPolygon') {
      coords.forEach(polygonCoords => {
        polygonCoords.forEach(r => addBorder(r.map(c => [c[0], c[1]])))
      })
    }
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
    finishLevelTransition()
  })

  // 地图点击 → 标点模式
  amap.on('click', (e) => handlePlacingClick(e.lnglat.lng, e.lnglat.lat))

  // 右键 → 退出标点模式（静默，无弹窗）
  amap.on('rightclick', () => {
    if (placingMode.value) { placingMode.value = false; clearDraftPin(); applyCursor() }
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

// ═══ 导航 ═══
async function loadChina() {
  if (!levelAnimating.value) startLevelTransition('back')
  destroyAmap()
  loading.value = true
  try {
    const [geo, stats] = await Promise.all([
      fetch(`${GEO_BASE}?path=100000_full.json`).then(r=>r.json()),
      getProvinceStats().catch(()=>({data:[]})),
    ])
    if (!chartRef.value || !geo) return
    const dl = (stats.data||[]).map(d=>({name:d.name,value:d.value}))
    drillLevel.value='china'; provinceName.value=''; cityName.value=''; districtName.value=''
    total.value = dl.reduce((s,d)=>s+d.value,0)
    echarts.registerMap('china',geo); renderECharts('china',dl)
  } finally {
    loading.value = false
    finishLevelTransition()
  }
}

async function drillToProvince(name) {
  if (drillLevel.value!=='china') return
  startLevelTransition('forward')
  destroyAmap()
  const adcode = PROVINCE_ADCODE[FULL_TO_SHORT[name]||name]
  if (!adcode) { finishLevelTransition(); return }
  if (provinceCache?.name===name) {
    drillLevel.value='province'; provinceName.value=name; cityName.value=''; districtName.value=''
    total.value=provinceCache.dataList.reduce((s,d)=>s+d.value,0)
    echarts.registerMap(name,provinceCache.geo); renderECharts(name,provinceCache.dataList)
    finishLevelTransition()
    return
  }
  loading.value = true
  try {
    const [geo,stats] = await Promise.all([
      fetch(`${GEO_BASE}?path=${adcode}_full.json`).then(r=>r.json()),
      getCityStats(name).catch(()=>({data:[]})),
    ])
    if (!chartRef.value||!geo) return
    const dl = stats.data||[]; provinceCache={name,geo,dataList:dl}
    drillLevel.value='province'; provinceName.value=name; cityName.value=''; districtName.value=''
    total.value=dl.reduce((s,d)=>s+d.value,0)
    echarts.registerMap(name,geo); renderECharts(name,dl)
  } finally {
    loading.value = false
    finishLevelTransition()
  }
}

// ═══ 市 → 区（ECharts 图表样式） ═══
async function drillToCity(name) {
  if (drillLevel.value!=='province'||!provinceCache) return
  startLevelTransition('forward')
  const features = provinceCache.geo.features||[]
  const f = features.find(x=>normalize(x.properties?.name||'')===normalize(name)||x.properties?.name===name)
  const adcode = f?.properties?.adcode
  if (!adcode) { finishLevelTransition(); return }
  if (cityCache?.name===name) {
    destroyAmap()
    drillLevel.value='city'; cityName.value=name; districtName.value=''
    total.value=cityCache.dataList.reduce((s,d)=>s+d.value,0)
    echarts.registerMap(name,cityCache.geo); renderECharts(name,cityCache.dataList)
    finishLevelTransition()
    return
  }
  loading.value = true
  try {
    const [geo,stats] = await Promise.all([
      fetch(`${GEO_BASE}?path=${adcode}_full.json`).then(r=>r.json()),
      getDistrictStats(provinceName.value, name).catch(()=>({data:[]})),
    ])
    if (!chartRef.value||!geo) return
    const dl = stats.data||[]; cityCache={name,geo,dataList:dl}
    destroyAmap()
    drillLevel.value='city'; cityName.value=name; districtName.value=''
    total.value=dl.reduce((s,d)=>s+d.value,0)
    echarts.registerMap(name,geo); renderECharts(name,dl)
  } finally {
    loading.value = false
    finishLevelTransition()
  }
}

// ═══ 区 → 高德真实 2D 地图 ═══
async function drillToDistrict(name) {
  if (drillLevel.value!=='city'||!cityCache) return
  startLevelTransition('forward')
  const features = cityCache.geo.features||[]
  const f = features.find(x=>normalize(x.properties?.name||'')===normalize(name)||x.properties?.name===name)
  if (!f) { finishLevelTransition(); return }

  loading.value = true
  try {
    await waitForAMap()
    // 获取该市各区门店位置（仅高德 2D 地图标记红点）
    const locs = await getStoreLocations({ province: provinceName.value, city: cityName.value }).catch(()=>({data:[]}))
    storesLocs.value = locs.data || []
    // 加载自定义点位
    customPins.value = await getMapPins({ province: provinceName.value, city: cityName.value, district: name }).then(r => r.data).catch(() => [])
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
    finishLevelTransition()
  } finally { loading.value = false }
}

function backToPrevious() {
  startLevelTransition('back')
  if (drillLevel.value==='district') {
    destroyAmap()
    const c = cityCache
    if (c) {
      drillLevel.value='city'; districtName.value=''
      total.value=c.dataList.reduce((s,d)=>s+d.value,0)
      echarts.registerMap(c.name,c.geo); renderECharts(c.name,c.dataList)
      finishLevelTransition()
    }
  } else if (drillLevel.value==='city') {
    destroyAmap()
    const c = provinceCache
    if (c) {
      drillLevel.value='province'; cityName.value=''; districtName.value=''
      total.value=c.dataList.reduce((s,d)=>s+d.value,0)
      echarts.registerMap(c.name,c.geo); renderECharts(c.name,c.dataList)
      finishLevelTransition()
    } else { drillToProvince(provinceName.value) }
  } else if (drillLevel.value==='province') {
    cityCache=null
    provinceCache=null
    loadChina()
  }
}

// ═══ 自定义点位 CRUD ═══
function flyToPin(p) {
  if (amap) amap.setZoomAndCenter(15, [p.lng, p.lat])
}

function togglePlacingMode() {
  if (placingMode.value) {
    placingMode.value = false
    clearDraftPin()
    applyCursor()
    ElMessage.info('已退出标点模式')
  } else {
    clearDraftPin()
    placingMode.value = true
    applyCursor()
    ElMessage.info('在地图上点击放置标记，ESC 或右键退出')
  }
}
function editPin(p) {
  pinType.value = 'pin'
  editingPinId.value = p.id
  pinForm.value = { name: p.name, remark: p.remark, color: p.color, radius: p.radius, shape: p.shape||'circle', created_by: p.created_by, lng: p.lng, lat: p.lat, visibility: p.visibility||'public' }
  // 点击标记 → 打开右侧评论抽屉
  openCommentDrawer('pin', p)
}
function editStoreMarker(s) {
  pinType.value = 'store'
  editingStoreId.value = s.id
  const color = s.status === '正常营业' ? '#67C23A' : s.status === '筹建中' ? '#E6A23C' : '#909399'
  pinForm.value = {
    store_name: s.store_name,
    remark: s.remark || '',
    lng: s.lng,
    lat: s.lat,
    status: s.status,
    radius: s.radius || 3000,
    color: color,
    shape: 'circle',
  }
  // 点击标记 → 打开右侧评论抽屉
  openCommentDrawer('store', {
    id: s.id,
    store_name: s.store_name,
    status: s.status,
    remark: s.remark,
    lng: s.lng,
    lat: s.lat,
    radius: s.radius || 3000,
    color: color,
    shape: 'circle',
  })
}
async function savePin() {
  if (!pinForm.value) return
  if (pinType.value === 'pin' && !pinForm.value.name?.trim()) {
    ElMessage.warning('请填写点位名称')
    return
  }
  pinSaving.value = true
  try {
    if (pinType.value === 'store') {
      await updateStore(editingStoreId.value, { remark: pinForm.value.remark, radius: pinForm.value.radius })
      // 同步更新本地 storesLocs 中的 remark 和 radius
      const idx = storesLocs.value.findIndex(s => s.id === editingStoreId.value)
      if (idx >= 0) {
        storesLocs.value[idx].remark = pinForm.value.remark
        storesLocs.value[idx].radius = pinForm.value.radius
      }
      ElMessage.success('已保存')
    } else {
      const payload = {
        ...pinForm.value,
        name: pinForm.value.name.trim(),
        province: provinceName.value,
        city: cityName.value,
        district: districtName.value,
      }
      if (editingPinId.value) {
        await updateMapPin(editingPinId.value, payload)
        ElMessage.success('点位已更新')
      } else {
        await createMapPin(payload)
        ElMessage.success('点位已创建')
      }
      await loadCustomPins()
    }
    pinDialogVisible.value = false
    editingPinId.value = null
    refreshMarkers()
  } catch (e) { ElMessage.error('保存失败: ' + e.message) }
  finally { pinSaving.value = false }
}
function cancelPinEdit() {
  pinDialogVisible.value = false
  if (pinType.value === 'pin' && !editingPinId.value) pinForm.value = null
}
function copyCoord() {
  if (!pinForm.value || pinForm.value.lng == null) return
  const text = `${pinForm.value.lng.toFixed(6)}, ${pinForm.value.lat.toFixed(6)}`
  navigator.clipboard.writeText(text).then(() => {
    ElMessage.success('坐标已复制')
  }).catch(() => {
    ElMessage.warning('复制失败，请手动复制')
  })
}
async function deletePin() {
  if (!editingPinId.value) return
  try {
    await ElMessageBox.confirm('确定删除该点位？', '确认', { type: 'warning' })
    await deleteMapPin(editingPinId.value)
    ElMessage.success('已删除')
    pinDialogVisible.value = false
    editingPinId.value = null
    await loadCustomPins()
    refreshMarkers()
  } catch {}
}
async function loadCustomPins() {
  if (drillLevel.value !== 'district') return
  const { data } = await getMapPins({ province: provinceName.value, city: cityName.value, district: districtName.value }).catch(() => ({ data: [] }))
  customPins.value = data || []
}

// 监听状态/类型筛选变化 → 只刷新标记，不重建地图
watch([statusFilter, storeTypeFilter], () => { refreshMarkers() })

// ESC 退出标点模式
function onKeyDown(e) { if (e.key === 'Escape' && placingMode.value) { placingMode.value = false; clearDraftPin(); applyCursor(); ElMessage.info('已退出标点模式') } }
onMounted(() => { loadChina(); document.addEventListener('keydown', onKeyDown) })
onBeforeUnmount(() => { chart?.dispose(); destroyAmap(); document.removeEventListener('keydown', onKeyDown) })


</script>

<style>
/* ===== 全国地图工作台 ===== */
.store-map-page {
  --map-ink: #172033;
  --map-muted: #78849a;
  --map-line: #e8ebf2;
  --map-blue: #4f7cff;
  --map-blue-dark: #2e51be;
  --map-soft-blue: #eef3ff;
  --map-surface: #ffffff;
  --map-canvas-bg: #f4f7fb;
  --map-success: #15803d;
  --map-warning: #c97808;
  --map-shadow-sm: 0 8px 24px rgba(31, 47, 82, .08);
  --map-shadow-lg: 0 20px 48px rgba(23, 45, 91, .16);
  min-width: 0;
  font-family: Inter, "PingFang SC", "Microsoft YaHei", sans-serif;
  color: var(--map-ink);
}

.map-hero {
  position: relative;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 30px;
  min-height: 132px;
  margin-bottom: 20px;
  padding: 28px 32px;
  overflow: hidden;
  color: #fff;
  border-radius: 18px;
  background:
    radial-gradient(circle at 82% 10%, rgba(121, 214, 180, .24), transparent 31%),
    radial-gradient(circle at 94% 90%, rgba(107, 161, 255, .28), transparent 35%),
    linear-gradient(125deg, #122456 0%, #1d4c95 56%, #367ee4 100%);
  box-shadow: var(--map-shadow-lg);
}
.map-hero::after {
  content: "";
  position: absolute;
  width: 260px;
  height: 260px;
  right: -78px;
  bottom: -190px;
  border: 1px solid rgba(255,255,255,.22);
  border-radius: 50%;
  box-shadow: 0 0 0 38px rgba(255,255,255,.04), 0 0 0 76px rgba(255,255,255,.035);
}
.map-eyebrow {
  margin-bottom: 7px;
  color: #b8d5ff;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: .22em;
}
.map-hero h2 {
  margin: 0;
  font-size: 28px;
  line-height: 1.2;
  letter-spacing: -.02em;
}
.map-hero p {
  max-width: 620px;
  margin: 8px 0 0;
  color: rgba(255,255,255,.72);
  font-size: 13px;
}
.hero-metrics {
  position: relative;
  z-index: 1;
  display: flex;
  gap: 10px;
}
.hero-metric {
  min-width: 100px;
  padding: 12px 15px;
  border: 1px solid rgba(255,255,255,.18);
  border-radius: 14px;
  background: rgba(255,255,255,.11);
  backdrop-filter: blur(8px);
}
.hero-metric span {
  display: block;
  margin-bottom: 4px;
  color: rgba(255,255,255,.62);
  font-size: 10px;
}
.hero-metric strong {
  font-size: 22px;
  line-height: 1;
}
.hero-metric strong.success { color: #8df1ba; }
.hero-metric strong.accent { color: #ffd887; }

.map-workspace {
  overflow: hidden;
  border: 1px solid var(--map-line);
  border-radius: 20px;
  background: var(--map-surface);
  box-shadow: var(--map-shadow-sm);
}
.workspace-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 80px;
  padding: 0 24px;
  background: linear-gradient(180deg, #fff 0%, #fbfcff 100%);
  border-bottom: 1px solid var(--map-line);
}
.level-breadcrumb {
  display: flex;
  align-items: center;
  min-width: 0;
}
.level-breadcrumb button {
  position: relative;
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 130px;
  padding: 12px 30px 12px 0;
  border: 0;
  background: transparent;
  color: #a0a9b9;
  text-align: left;
}
.level-breadcrumb button:not(:last-child)::after {
  content: "›";
  position: absolute;
  right: 13px;
  top: 50%;
  color: #c8ced9;
  font-size: 22px;
  font-weight: 300;
  transform: translateY(-50%);
}
.level-breadcrumb button.reachable { cursor: pointer; }
.level-breadcrumb button.reachable:hover b { color: var(--map-blue); }
.level-breadcrumb button.active { color: var(--map-ink); }
.level-dot {
  display: grid;
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  place-items: center;
  border: 1px solid #dfe4ed;
  border-radius: 50%;
  background: #fff;
  color: #98a2b3;
  font-size: 11px;
  font-weight: 700;
  transition: .25s ease;
}
.level-breadcrumb button.reachable .level-dot {
  border-color: #c8d5ff;
  background: var(--map-soft-blue);
  color: var(--map-blue);
}
.level-breadcrumb button.active .level-dot {
  border-color: var(--map-blue);
  background: var(--map-blue);
  color: #fff;
  box-shadow: 0 0 0 5px rgba(79,124,255,.12), 0 4px 10px rgba(79,124,255,.2);
}
.level-breadcrumb small,
.level-breadcrumb b {
  display: block;
  overflow: hidden;
  max-width: 100px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.level-breadcrumb small {
  margin-bottom: 2px;
  color: #a3acbb;
  font-size: 10px;
  font-weight: 500;
}
.level-breadcrumb b {
  font-size: 13px;
  font-weight: 650;
  transition: color .18s ease;
}
.workspace-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #7c8799;
  font-size: 11px;
  white-space: nowrap;
}
.map-live-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #31c48d;
  box-shadow: 0 0 0 4px rgba(49,196,141,.12);
}
.workspace-actions .el-button { margin-left: 10px; }
.level-breadcrumb button:focus-visible,
.side-title button:focus-visible,
.place-pin-button:focus-visible,
.pin-list > button:focus-visible {
  outline: 3px solid rgba(79,124,255,.32);
  outline-offset: 2px;
}

.map-layout {
  display: grid;
  grid-template-columns: 258px minmax(0, 1fr);
  min-height: 668px;
}
.map-side-panel {
  padding: 22px 18px 18px;
  border-right: 1px solid var(--map-line);
  background: linear-gradient(180deg, #fbfcff 0%, #f6f8fc 100%);
}
.side-section {
  padding: 0 4px 18px;
  margin-bottom: 18px;
  border-bottom: 1px solid var(--map-line);
}
.side-section:last-child {
  margin-bottom: 0;
  border-bottom: 0;
}
.side-kicker {
  color: var(--map-blue);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: .12em;
}
.side-section h3 {
  margin: 6px 0;
  font-size: 19px;
  letter-spacing: -.02em;
}
.side-section > p {
  margin: 0;
  color: var(--map-muted);
  font-size: 12px;
  line-height: 1.65;
}
.side-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 11px;
  font-size: 12px;
  font-weight: 700;
}
.side-title button {
  padding: 0;
  border: 0;
  background: none;
  color: var(--map-blue);
  cursor: pointer;
  font-size: 11px;
}
.side-title em {
  min-width: 22px;
  padding: 2px 7px;
  border-radius: 20px;
  background: var(--map-soft-blue);
  color: var(--map-blue);
  font-size: 10px;
  font-style: normal;
  text-align: center;
}
.filter-section .el-select {
  width: 100%;
  margin-bottom: 9px;
}
.filter-section .el-select__wrapper {
  min-height: 36px;
  border-radius: 9px;
  box-shadow: 0 0 0 1px #e4e8ef inset;
}
.filter-result {
  display: flex;
  justify-content: space-between;
  margin-top: 3px;
  padding: 10px 11px;
  border-radius: 9px;
  border: 1px solid #e5ebf5;
  background: #f3f7fc;
  color: #8590a2;
  font-size: 11px;
}
.filter-result strong { color: var(--map-ink); }

.place-pin-button {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 12px;
  border: 1px solid #dce4fb;
  border-radius: 12px;
  background: linear-gradient(135deg, #fff 0%, #f7f9ff 100%);
  color: var(--map-ink);
  cursor: pointer;
  text-align: left;
  transition: .2s ease;
}
.place-pin-button:hover {
  border-color: #b6c7ff;
  box-shadow: 0 6px 16px rgba(79,124,255,.10);
  transform: translateY(-1px);
}
.place-pin-button.active {
  border-color: #f3c06b;
  background: #fff9ed;
}
.place-pin-icon {
  display: grid;
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: 9px;
  background: var(--map-blue);
  color: #fff;
  font-size: 20px;
  font-weight: 300;
}
.place-pin-button.active .place-pin-icon { background: #e89a2d; }
.place-pin-button b,
.place-pin-button small {
  display: block;
}
.place-pin-button b { margin-bottom: 3px; font-size: 12px; }
.place-pin-button small { color: #8d97a8; font-size: 10px; }
.pin-list {
  max-height: 188px;
  margin-top: 9px;
  overflow-y: auto;
}
.pin-list > button {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 9px 7px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  cursor: pointer;
  text-align: left;
}
.pin-list > button:hover { background: #f0f3f8; }
.pin-list > button:active,
.place-pin-button:active { transform: translateY(0); }
.pin-swatch {
  flex: 0 0 auto;
  width: 9px;
  height: 9px;
  border: 2px solid #fff;
  border-radius: 50%;
  box-shadow: 0 0 0 1px rgba(20,30,50,.14);
}
.pin-list-copy {
  min-width: 0;
  flex: 1;
}
.pin-list-copy b,
.pin-list-copy small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pin-list-copy b { color: #364052; font-size: 11px; }
.pin-list-copy small { margin-top: 2px; color: #9ba4b3; font-size: 9px; }
.pin-arrow { color: #adb5c2; font-size: 18px; }
.empty-pin-list {
  padding: 22px 0 5px;
  color: #a1a9b6;
  font-size: 11px;
  text-align: center;
}
.drill-guide {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 20px 12px 24px;
  border: 1px dashed #d6ddeb;
  border-radius: 14px;
  background: rgba(255,255,255,.8);
  text-align: center;
}
.guide-icon {
  display: grid;
  width: 42px;
  height: 42px;
  margin-bottom: 9px;
  place-items: center;
  border-radius: 50%;
  background: var(--map-soft-blue);
  color: var(--map-blue);
  font-size: 24px;
}
.drill-guide b { font-size: 12px; }
.drill-guide span { margin-top: 4px; color: #939dad; font-size: 10px; }
.legend-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 6px;
  color: #727d90;
  font-size: 10px;
}
.legend-grid span {
  display: flex;
  align-items: center;
  gap: 6px;
}
.legend-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.legend-dot.operating { background: #31b87c; }
.legend-dot.preparing { background: #eca93a; }
.legend-dot.closed { background: #8d96a8; }
.legend-dot.custom { background: #4f7cff; }
.gradient-legend {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #8d97a7;
  font-size: 9px;
}
.gradient-legend i {
  height: 7px;
  flex: 1;
  border-radius: 10px;
  background: linear-gradient(90deg, #dbe6ff, #4f7cff, #243d8f);
}

.map-stage {
  position: relative;
  min-width: 0;
  background: var(--map-canvas-bg);
}
.map-stage-top {
  position: absolute;
  z-index: 5;
  top: 18px;
  left: 20px;
  right: 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  pointer-events: none;
}
.map-stage-top > div:first-child {
  padding: 11px 14px;
  border: 1px solid rgba(218,225,237,.94);
  border-radius: 12px;
  background: rgba(255,255,255,.94);
  box-shadow: 0 10px 24px rgba(29,41,68,.11);
  backdrop-filter: blur(10px);
}
.stage-label {
  display: block;
  margin-bottom: 2px;
  color: #8d97a8;
  font-size: 9px;
}
.map-stage-top strong { font-size: 13px; }
.stage-tools {
  padding: 8px 11px;
  border: 1px solid rgba(255,255,255,.15);
  border-radius: 20px;
  background: rgba(24,41,76,.78);
  color: rgba(255,255,255,.84);
  font-size: 9px;
  backdrop-filter: blur(8px);
}
.map-canvas-wrap {
  position: relative;
  min-height: 668px;
  overflow: hidden;
  background: #f4f6f9;
}
.map-canvas {
  width: 100%;
  height: 668px;
  opacity: 1;
  filter: blur(0);
  transform: scale(1);
  transition: opacity .34s ease, filter .34s ease, transform .44s cubic-bezier(.22,.75,.25,1);
}
.map-canvas-wrap.is-transitioning .map-canvas {
  opacity: .32;
  filter: blur(2px);
  transform: scale(.985);
}
.map-transition-shade {
  position: absolute;
  z-index: 9;
  inset: 0;
  display: grid;
  align-content: center;
  justify-items: center;
  pointer-events: none;
  background: radial-gradient(circle, rgba(255,255,255,.74), rgba(245,247,251,.2) 48%, transparent 74%);
  animation: mapShadeIn .25s ease both;
}
.map-transition-shade span {
  width: 34px;
  height: 34px;
  border: 3px solid rgba(79,124,255,.18);
  border-top-color: var(--map-blue);
  border-radius: 50%;
  animation: mapSpin .8s linear infinite;
}
.map-transition-shade small {
  margin-top: 10px;
  color: #6e7a8e;
  font-size: 10px;
}
.placing-mode-banner {
  position: absolute;
  z-index: 8;
  top: 78px;
  left: 50%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid #ffd28e;
  border-radius: 12px;
  background: rgba(255,249,237,.96);
  color: #83520c;
  box-shadow: 0 14px 32px rgba(139,91,20,.18);
  transform: translateX(-50%);
  backdrop-filter: blur(9px);
  animation: bannerDrop .28s ease both;
}
.placing-mode-banner b,
.placing-mode-banner small { display: block; }
.placing-mode-banner b { font-size: 11px; }
.placing-mode-banner small { margin-top: 2px; color: #a77a37; font-size: 9px; }
.placing-mode-banner kbd {
  padding: 3px 6px;
  border: 1px solid #e8c589;
  border-bottom-width: 2px;
  border-radius: 5px;
  background: #fff;
  color: #96703b;
  font-size: 8px;
}

.draft-actions { display:flex; align-items:center; gap:7px; margin-left:auto; }
.draft-actions .el-button { height:28px; font-size:12px; }
.draft-map-pin { position:relative; width:24px; height:32px; color:#2669bd; font:700 11px/1.1 sans-serif; white-space:nowrap; pointer-events:none; }
.draft-map-pin span { position:absolute; inset:0; background:#409eff; clip-path:polygon(50% 100%, 5% 52%, 5% 30%, 16% 11%, 33% 0, 67% 0, 84% 11%, 95% 30%, 95% 52%); filter:drop-shadow(0 2px 3px rgba(32,104,190,.36)); }
.draft-map-pin span::after { content:''; position:absolute; left:7px; top:7px; width:10px; height:10px; border-radius:50%; background:#fff; }
.draft-map-pin small { position:absolute; left:50%; top:37px; padding:3px 6px; border-radius:9px; background:#fff; box-shadow:0 2px 8px rgba(32,72,120,.16); transform:translateX(-50%); }
.placing-pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ec9e2f;
  animation: placingPulse 1.5s ease-out infinite;
}

/* 高德覆盖物标签 */
.map-marker-label {
  position: absolute;
  top: 9px;
  left: 0;
  max-width: 150px;
  overflow: hidden;
  padding: 3px 7px;
  border: 1px solid rgba(224,228,235,.9);
  border-radius: 6px;
  background: rgba(255,255,255,.94);
  box-shadow: 0 4px 12px rgba(31,43,68,.12);
  color: #344054;
  font-size: 10px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
  transform: translateX(-50%);
  backdrop-filter: blur(6px);
}
.map-marker-label.custom-label {
  border-color: rgba(79,124,255,.22);
  color: #3155ba;
}

/* 点位编辑 */
.pin-editor-preview {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 22px;
  padding: 14px 16px;
  border: 1px solid #e6eaf1;
  border-radius: 12px;
  background: #f8f9fb;
}
.pin-editor-preview > div { min-width: 0; flex: 1; }
.pin-editor-preview b,
.pin-editor-preview small { display: block; }
.pin-editor-preview b { color: #283244; font-size: 13px; }
.pin-editor-preview small { margin-top: 4px; color: #8d97a8; font-size: 10px; }
.preview-pin {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border: 3px solid #fff;
  border-radius: 50%;
  background: var(--pin-color);
  box-shadow: 0 4px 10px rgba(31,43,68,.2);
  color: var(--pin-color);
}
.preview-pin.square { border-radius: 5px; }
.preview-pin.diamond { border-radius: 5px; transform: rotate(45deg) scale(.84); }
.preview-pin.star { display:flex; align-items:center; justify-content:center; border:0; background:transparent; color:var(--pin-color); font-family:Arial,"Segoe UI Symbol",sans-serif; font-size:25px; font-weight:700; line-height:1; text-shadow:0 2px 5px color-mix(in srgb,var(--pin-color) 28%,transparent); }
.editor-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
}
.shape-picker {
  display: flex;
  gap: 6px;
}
.shape-picker button {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  min-width: 52px;
  padding: 8px 6px;
  border: 1px solid #e2e6ed;
  border-radius: 8px;
  background: #fff;
  color: #788396;
  cursor: pointer;
  font-size: 9px;
}
.shape-picker button.active {
  border-color: var(--map-blue);
  background: var(--map-soft-blue);
  color: var(--map-blue);
}
.shape-picker i {
  display: grid;
  width: 18px;
  height: 18px;
  place-items: center;
  border-radius: 50%;
  background: var(--choice-color);
  color: var(--choice-color);
  font-style: normal;
}
.shape-picker i.square { border-radius: 3px; }
.shape-picker i.diamond { border-radius: 3px; transform: rotate(45deg) scale(.8); }
.shape-picker i.star { display:flex; align-items:center; justify-content:center; background:transparent; font-family:Arial,"Segoe UI Symbol",sans-serif; font-size:18px; font-weight:700; line-height:1; }
.color-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 9px;
  padding-top: 4px;
}
.color-picker button {
  width: 25px;
  height: 25px;
  border: 3px solid #fff;
  border-radius: 7px;
  cursor: pointer;
  box-shadow: 0 0 0 1px #dce1e9;
}
.color-picker button.active {
  box-shadow: 0 0 0 2px #fff, 0 0 0 4px var(--map-blue);
}
.field-suffix {
  margin-left: 8px;
  color: #8d97a8;
  font-size: 11px;
}
.dialog-footer {
  display: grid;
  grid-template-columns: auto 1fr auto auto;
  gap: 8px;
  width: 100%;
}

/* 创建点位：紧凑、分层的表单布局 */
.pin-editor-dialog .el-dialog { overflow:hidden; border-radius:16px; box-shadow:0 22px 58px rgba(22,39,71,.22); }
.pin-editor-dialog .el-dialog__header { margin:0; padding:20px 24px 15px; border-bottom:1px solid #edf0f4; }
.pin-editor-dialog .el-dialog__title { color:#1f2d42; font-size:17px; font-weight:750; }
.pin-editor-dialog .el-dialog__body { padding:18px 24px 14px; }
.pin-editor-dialog .el-dialog__footer { padding:13px 24px 18px; border-top:1px solid #edf0f4; background:#fbfcfe; }
.pin-editor .el-form-item { margin-bottom:15px; }
.pin-editor .el-form-item__label { padding-bottom:6px; color:#4b5b70; font-size:12px; font-weight:700; line-height:1.2; }
.pin-editor .el-input__wrapper,.pin-editor .el-textarea__inner { border-radius:9px; background:#fcfdff; box-shadow:0 0 0 1px #dfe6ef inset; }
.pin-editor .el-input__wrapper:hover,.pin-editor .el-textarea__inner:hover { box-shadow:0 0 0 1px #b8cce5 inset; }
.pin-editor-preview { margin-bottom:18px; padding:13px 15px; border-color:#dfe7f1; border-radius:11px; background:linear-gradient(135deg,#f7faff,#f3f7fc); }
.pin-editor-preview .el-button { color:#52657e; font-weight:650; }
.editor-grid { gap:12px; margin-top:2px; }
.editor-grid .el-form-item { min-height:104px; margin:0; padding:13px 14px 10px; border:1px solid #e8edf3; border-radius:11px; background:#fafcff; }
.settings-grid .el-form-item { min-height:82px; }
.shape-picker { gap:5px; }
.shape-picker button { min-width:50px; padding:7px 5px; border-radius:8px; }
.color-picker { gap:8px; padding-top:6px; }
.color-picker button { width:23px; height:23px; border-radius:6px; }
.settings-grid .el-input-number { width:136px; }
.dialog-footer { grid-template-columns:auto 1fr auto auto; align-items:center; }
.dialog-footer .el-button { min-width:82px; height:34px; border-radius:8px; font-weight:650; }
.dialog-footer .el-button--primary { min-width:104px; box-shadow:0 5px 12px rgba(64,158,255,.22); }
@media (max-width:680px) { .pin-editor-dialog .el-dialog__body{padding:16px}.pin-editor-dialog .el-dialog__header{padding:18px 16px 14px}.pin-editor-dialog .el-dialog__footer{padding:12px 16px 16px}.editor-grid{grid-template-columns:1fr}.editor-grid .el-form-item{min-height:auto}.shape-picker{justify-content:space-between}.dialog-footer .el-button{min-width:0}.dialog-footer .el-button--primary{min-width:88px} }

/* 评论抽屉 */
.comment-drawer-body {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.comment-target-card {
  flex: 0 0 auto;
  padding: 14px;
  border: 1px solid #e5e9f0;
  border-radius: 12px;
  background: #f8f9fb;
}
.comment-target-title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.comment-target-card p {
  margin: 8px 0 12px;
  color: #778295;
  font-size: 11px;
  line-height: 1.6;
}
.comment-target-actions { display: flex; gap: 7px; }
.comment-list {
  flex: 1;
  padding: 12px 2px;
  overflow-y: auto;
}
.comment-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 46px 20px;
  color: #9ba4b2;
  text-align: center;
}
.comment-empty b { color: #667085; font-size: 12px; }
.comment-empty span { margin-top: 5px; font-size: 10px; }
.comment-item {
  padding: 13px 2px;
  border-bottom: 1px solid #edf0f4;
}
.comment-item header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.comment-item header > div { flex: 1; }
.comment-item header b,
.comment-item header small { display: block; }
.comment-item header b { color: #344054; font-size: 11px; }
.comment-item header small { margin-top: 2px; color: #a0a8b5; font-size: 9px; }
.comment-avatar {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border-radius: 50%;
  background: #e8edff;
  color: #4f6fda;
  font-size: 10px;
  font-weight: 700;
}
.comment-item > p,
.reply-list p {
  margin: 8px 0 2px 36px;
  color: #566174;
  font-size: 11px;
  line-height: 1.65;
}
.comment-item > .el-button { margin-left: 31px; }
.reply-list {
  margin: 8px 0 0 36px;
  padding: 9px 10px;
  border-left: 2px solid #dbe4ff;
  border-radius: 0 8px 8px 0;
  background: #f7f8fb;
}
.reply-list > div + div { margin-top: 9px; padding-top: 9px; border-top: 1px dashed #e1e5ec; }
.reply-list span { color: #647086; font-size: 10px; }
.reply-list span small { color: #9aa3b2; }
.reply-list p { margin: 4px 0; }
.comment-composer {
  flex: 0 0 auto;
  padding-top: 12px;
  border-top: 1px solid #e7eaf0;
}
.comment-composer > div:last-child {
  display: flex;
  gap: 8px;
}
.replying-tip {
  margin-bottom: 7px;
  color: #7c8799;
  font-size: 10px;
}
.replying-tip button {
  margin-left: 5px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--map-blue);
  cursor: pointer;
}

/* 动效 */
@keyframes mapShadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes mapSpin {
  to { transform: rotate(360deg); }
}
@keyframes bannerDrop {
  from { opacity: 0; transform: translate(-50%, -8px); }
  to { opacity: 1; transform: translate(-50%, 0); }
}
@keyframes placingPulse {
  0% { box-shadow: 0 0 0 0 rgba(236,158,47,.55); }
  75%, 100% { box-shadow: 0 0 0 8px rgba(236,158,47,0); }
}

/* 波纹扩散动画 — 从圆心向外扩散 */
@keyframes mapRipple {
  0%   { width:0; height:0; opacity:0.55; transform:translate(-50%,-50%); }
  65%  { opacity:0.10; }
  100% { width:130px; height:130px; opacity:0; transform:translate(-50%,-50%); }
}
.map-ripple-ring {
  position: absolute;
  left: 0;
  top: 0;
  border-radius: 50%;
  border: 2px solid;
  animation: mapRipple 3.5s ease-out infinite;
  pointer-events: none;
}

@media (max-width: 1180px) {
  .level-breadcrumb button { min-width: 104px; }
  .workspace-actions > span:not(.map-live-dot) { display: none; }
  .map-layout { grid-template-columns: 226px minmax(0, 1fr); }
}
@media (max-width: 900px) {
  .map-hero { align-items: flex-start; flex-direction: column; }
  .map-layout { grid-template-columns: 1fr; }
  .map-side-panel {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
    border-right: 0;
    border-bottom: 1px solid var(--map-line);
  }
  .side-section { margin: 0; border: 0; }
  .level-breadcrumb button { min-width: 72px; padding-right: 18px; }
  .level-breadcrumb button:not(:last-child)::after { right: 6px; }
  .level-breadcrumb small { display: none; }
  .map-stage-top { top: 14px; left: 14px; right: 14px; }
  .stage-tools { display: none; }
  .map-canvas-wrap,
  .map-canvas { min-height: 520px; height: 520px; }
}
@media (max-width: 640px) {
  .map-hero { gap: 18px; min-height: 0; padding: 22px 20px; border-radius: 16px; }
  .map-hero h2 { font-size: 24px; }
  .map-hero p { font-size: 12px; line-height: 1.65; }
  .hero-metrics { width: 100%; }
  .hero-metric { flex: 1; min-width: 0; }
  .workspace-header { min-height: 68px; padding: 0 14px; }
  .level-breadcrumb button { min-width: 0; flex: 1; gap: 6px; padding-right: 12px; }
  .level-breadcrumb button:not(:last-child)::after { display: none; }
  .level-breadcrumb b { max-width: 56px; font-size: 11px; }
  .workspace-actions .el-button { margin-left: 0; }
  .map-side-panel { display: block; padding: 18px 14px 4px; }
  .side-section { margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid var(--map-line); }
  .map-canvas-wrap,
  .map-canvas { min-height: 480px; height: 480px; }
  .placing-mode-banner { left: 14px; right: 14px; align-items: flex-start; flex-wrap: wrap; transform: none; }
  .placing-mode-banner kbd { display: none; }
  .draft-actions { width: 100%; margin-left: 18px; }
}
@media (prefers-reduced-motion: reduce) {
  .map-canvas,
  .place-pin-button,
  .level-dot { transition: none; }
  .map-ripple-ring,
  .placing-pulse,
  .map-transition-shade span { animation: none; }
}
</style>
