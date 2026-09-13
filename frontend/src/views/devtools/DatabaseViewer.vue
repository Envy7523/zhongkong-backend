<template>
  <div class="dbv-page">
    <div class="dbv-head">
      <div>
        <h2>数据库查看</h2>
        <p class="dbv-sub">
          只读开发辅助工具 · 库文件 {{ overview.db?.path || 'data/database.sqlite' }}
          <template v-if="overview.db"> · {{ overview.db.sizeMB }} MB · {{ overview.tableCount }} 张表 ·
            {{ Number(overview.totalRows || 0).toLocaleString('zh-CN') }} 行</template>
        </p>
      </div>
      <div class="dbv-head-actions">
        <el-tag v-if="overview.db?.mtime" type="info" effect="plain">最后写入 {{ fmtTime(overview.db.mtime) }}</el-tag>
        <el-button size="small" @click="loadOverview">刷新</el-button>
      </div>
    </div>

    <el-alert type="warning" :closable="false" class="dbv-alert">
      本页只读：所有查询均为 SELECT，不提供任何写操作；SQL 控制台禁止 DDL/DML，
      且 <b>config.json、私钥、.git、node_modules、数据库二进制文件一律不可访问</b>。
    </el-alert>

    <el-tabs v-model="tab" class="dbv-tabs">
      <!-- ============ 数据表 ============ -->
      <el-tab-pane label="数据表" name="tables">
        <div class="dbv-split">
          <aside class="dbv-side">
            <el-input v-model="tableKeyword" size="small" placeholder="搜索表名 / 分类" clearable style="margin-bottom:8px" />
            <div class="dbv-side-body">
              <template v-for="group in groupedTables" :key="group.category">
                <div class="dbv-group">{{ group.category }}（{{ group.items.length }}）</div>
                <div
                  v-for="t in group.items"
                  :key="t.name"
                  class="dbv-table-item"
                  :class="{ active: current === t.name }"
                  @click="openTable(t.name)"
                >
                  <span class="dbv-name">{{ t.name }}</span>
                  <span class="dbv-meta">
                    <span :class="['dbv-rows', { zero: t.rows === 0 }]">{{ Number(t.rows).toLocaleString('zh-CN') }}</span>
                    <span v-if="t.refCount" class="dbv-ref" :title="t.refCount + ' 处代码引用'">↗{{ t.refCount }}</span>
                  </span>
                </div>
              </template>
              <el-empty v-if="!groupedTables.length" description="没有匹配的表" :image-size="60" />
            </div>
          </aside>

          <section class="dbv-main">
            <el-empty v-if="!current" description="从左侧选择一张表" />
            <template v-else>
              <div class="dbv-toolbar">
                <b class="dbv-cur">{{ current }}</b>
                <el-tag size="small" type="info">{{ detail.category }}</el-tag>
                <el-tag size="small">{{ Number(detail.total || 0).toLocaleString('zh-CN') }} 行</el-tag>
                <div class="dbv-grow"></div>
                <el-input v-model="rowQuery" size="small" placeholder="全字段关键字过滤" clearable style="width:200px" @keyup.enter="loadRows(1)" @clear="loadRows(1)" />
                <el-select v-model="orderBy" size="small" placeholder="排序字段" clearable style="width:150px" @change="loadRows(1)">
                  <el-option v-for="c in detail.columns" :key="c.name" :label="c.name" :value="c.name" />
                </el-select>
                <el-select v-model="order" size="small" style="width:90px" @change="loadRows(1)">
                  <el-option label="降序" value="desc" />
                  <el-option label="升序" value="asc" />
                </el-select>
                <el-button size="small" type="primary" @click="loadRows(1)">查询</el-button>
              </div>

              <el-tabs v-model="detailTab" class="dbv-detail-tabs">
                <el-tab-pane :label="'数据（' + Number(detail.total || 0).toLocaleString('zh-CN') + '）'" name="rows">
                  <el-table :data="detail.rows || []" size="small" border height="430" v-loading="loadingRows">
                    <el-table-column v-for="c in rowColumns" :key="c" :prop="c" :label="c" min-width="130" show-overflow-tooltip />
                  </el-table>
                  <div class="dbv-pager">
                    <el-pagination
                      background small layout="total, sizes, prev, pager, next"
                      :total="detail.total || 0" :current-page="page" :page-size="pageSize"
                      :page-sizes="[20, 50, 100, 200]"
                      @current-change="loadRows" @size-change="onSizeChange"
                    />
                  </div>
                </el-tab-pane>

                <el-tab-pane label="结构" name="schema">
                  <el-table :data="detail.columns || []" size="small" border height="300">
                    <el-table-column prop="name" label="字段" width="220" />
                    <el-table-column prop="type" label="类型" width="120" />
                    <el-table-column label="主键" width="70"><template #default="{ row }">{{ row.pk ? '✓' : '' }}</template></el-table-column>
                    <el-table-column label="非空" width="70"><template #default="{ row }">{{ row.notnull ? '✓' : '' }}</template></el-table-column>
                    <el-table-column prop="dflt" label="默认值" show-overflow-tooltip />
                  </el-table>
                  <div class="dbv-section-title">索引（{{ (detail.indexes || []).length }}）</div>
                  <div v-for="i in detail.indexes" :key="i.name" class="dbv-code">{{ i.sql }}</div>
                  <div v-if="!(detail.indexes || []).length" class="dbv-muted">无显式索引</div>
                </el-tab-pane>

                <el-tab-pane :label="'引用（' + (detail.refs || []).length + '）'" name="refs">
                  <div class="dbv-muted" style="margin-bottom:8px">
                    下表是静态扫描出的引用点（表名出现在 SQL 的 FROM/INTO/UPDATE/JOIN 后面）。动态拼表名的场景扫不到。
                  </div>
                  <el-table :data="detail.refs || []" size="small" border height="360">
                    <el-table-column prop="file" label="文件" width="180" />
                    <el-table-column prop="line" label="行号" width="80" />
                    <el-table-column prop="scope" label="接口 / 函数" width="280" show-overflow-tooltip />
                    <el-table-column prop="snippet" label="代码" show-overflow-tooltip />
                  </el-table>
                </el-tab-pane>
              </el-tabs>
            </template>
          </section>
        </div>
      </el-tab-pane>

      <!-- ============ 文件 ============ -->
      <el-tab-pane label="文件" name="files">
        <div class="dbv-toolbar">
          <el-breadcrumb separator="/">
            <el-breadcrumb-item><a @click="openDir('')">项目根</a></el-breadcrumb-item>
            <el-breadcrumb-item v-for="(seg, i) in dirPath.split('/').filter(Boolean)" :key="i">
              <a @click="openDir(dirPath.split('/').filter(Boolean).slice(0, i + 1).join('/'))">{{ seg }}</a>
            </el-breadcrumb-item>
          </el-breadcrumb>
          <div class="dbv-grow"></div>
          <el-tag v-for="r in fileRoots" :key="r" size="small" class="dbv-root-tag" @click="openDir(r)">{{ r }}</el-tag>
        </div>
        <el-table :data="files" size="small" border height="240" @row-click="onFileRow">
          <el-table-column label="名称" min-width="300">
            <template #default="{ row }">{{ row.dir ? '📁 ' : '📄 ' }}{{ row.name }}</template>
          </el-table-column>
          <el-table-column label="大小" width="110">
            <template #default="{ row }">{{ row.dir ? '—' : fmtSize(row.size) }}</template>
          </el-table-column>
          <el-table-column label="修改时间" width="180">
            <template #default="{ row }">{{ fmtTime(row.mtime) }}</template>
          </el-table-column>
        </el-table>
        <div v-if="filePreview" class="dbv-preview">
          <div class="dbv-toolbar">
            <b>{{ filePreview.path }}</b>
            <span class="dbv-muted">{{ fmtSize(filePreview.size) }}</span>
            <div class="dbv-grow"></div>
            <el-button size="small" @click="filePreview = null">关闭</el-button>
          </div>
          <img v-if="filePreview.dataUrl" :src="filePreview.dataUrl" class="dbv-img" />
          <pre v-else class="dbv-code-block">{{ filePreview.content || filePreview.note }}</pre>
        </div>
      </el-tab-pane>

      <!-- ============ 功能→数据 ============ -->
      <el-tab-pane label="功能 → 数据" name="map">
        <div class="dbv-toolbar">
          <el-input v-model="mapKeyword" size="small" placeholder="搜索页面 / 接口 / 表名" clearable style="width:280px" />
          <el-tag size="small" type="info">扫描时间 {{ featureMap.scanAt ? fmtTime(featureMap.scanAt) : '—' }}</el-tag>
          <div class="dbv-grow"></div>
          <el-button size="small" @click="loadFeatureMap">重新扫描</el-button>
        </div>
        <el-row :gutter="12">
          <el-col :span="14">
            <div class="dbv-section-title">页面 → 接口 → 数据表</div>
            <div class="dbv-map-list">
              <div v-for="v in filteredViews" :key="v.view" class="dbv-map-item">
                <div class="dbv-map-view">{{ v.view }}</div>
                <div v-for="a in v.apis" :key="a.fn" class="dbv-map-api">
                  <span class="dbv-map-fn">{{ a.fn }}</span>
                  <span class="dbv-map-path">{{ a.path || '（未在 api/index.js 找到路径）' }}</span>
                  <template v-if="a.tables.length">
                    <el-tag v-for="t in a.tables" :key="t" size="small" class="dbv-tag-table" @click="openTable(t)">{{ t }}</el-tag>
                  </template>
                  <span v-else class="dbv-muted">无直接数据表</span>
                </div>
              </div>
              <el-empty v-if="!filteredViews.length" description="没有匹配" :image-size="60" />
            </div>
          </el-col>
          <el-col :span="10">
            <div class="dbv-section-title">反查：数据表 → 接口</div>
            <el-select v-model="pickTable" size="small" filterable placeholder="选择表" style="width:100%;margin-bottom:8px" @change="() => {}">
              <el-option v-for="t in (featureMap.tables || [])" :key="t" :label="t" :value="t" />
            </el-select>
            <div v-if="pickTable" class="dbv-map-list sm">
              <div class="dbv-map-view">{{ pickTable }}</div>
              <div v-for="ep in (featureMap.tableToEndpoints?.[pickTable] || [])" :key="ep" class="dbv-map-api">
                <span class="dbv-map-path">{{ ep }}</span>
                <span class="dbv-muted">{{ featureMap.endpoints?.[ep]?.file }}:{{ featureMap.endpoints?.[ep]?.line }}</span>
              </div>
              <div v-if="!(featureMap.tableToEndpoints?.[pickTable] || []).length" class="dbv-muted">没有接口引用这张表（可能是遗留表，或表名是动态拼接的）</div>
            </div>
            <div class="dbv-section-title" style="margin-top:16px">
              未被「接口 / 模块函数」直接引用的表（{{ (featureMap.orphans || []).length }}）
            </div>
            <div class="dbv-orphans">
              <el-tag v-for="t in (featureMap.orphans || [])" :key="t" size="small" class="dbv-tag-table" @click="openTable(t)">{{ t }}</el-tag>
              <span v-if="!(featureMap.orphans || []).length" class="dbv-muted">无</span>
            </div>
            <div class="dbv-muted" style="margin-top:6px">
              注：由 server.js 里的工具函数（而非路由处理器）访问的表，或表名动态拼接的场景，扫不到。
            </div>
          </el-col>
        </el-row>
      </el-tab-pane>

      <!-- ============ 数据体检 ============ -->
      <el-tab-pane label="数据体检" name="health">
        <div class="dbv-toolbar">
          <span class="dbv-muted">检查区间</span>
          <el-select v-model="healthDays" size="small" style="width:110px" @change="loadHealth">
            <el-option :label="'最近 7 天'" :value="7" />
            <el-option :label="'最近 14 天'" :value="14" />
            <el-option :label="'最近 30 天'" :value="30" />
          </el-select>
          <el-tag v-if="health.generatedAt" size="small" type="info">生成于 {{ fmtTime(health.generatedAt) }}</el-tag>
          <el-tag v-if="health.dbPath" size="small">{{ health.dbPath }}</el-tag>
          <div class="dbv-grow"></div>
          <el-button size="small" @click="loadHealth">重新检查</el-button>
        </div>

        <!-- 1) 平台专属表覆盖 -->
        <div class="dbv-section-title">① 平台专属表覆盖（✓ 当天有数据 · 无数据）</div>
        <div v-for="g in (health.coverage?.groups || [])" :key="g.label" class="dbv-matrix">
          <div class="dbv-matrix-title">{{ g.label }}</div>
          <table class="dbv-tbl">
            <thead>
              <tr>
                <th class="dbv-th-date">日期</th>
                <th v-for="c in g.columns" :key="c.table">
                  <div class="dbv-th-role">{{ c.role }}</div>
                  <div class="dbv-th-table">{{ c.table }}</div>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(d, i) in health.coverage.dates" :key="d" :class="{ 'dbv-row-today': i === health.coverage.dates.length - 1 }">
                <td class="dbv-td-date">{{ d.slice(5) }}</td>
                <td v-for="c in g.columns" :key="c.table" :class="c.cells[i] > 0 ? 'dbv-ok' : 'dbv-no'">
                  {{ c.cells[i] > 0 ? c.cells[i] : '·' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <el-empty v-if="!(health.coverage?.groups || []).length" description="没有识别到平台专属表" :image-size="60" />

        <!-- 2) 通用层覆盖 -->
        <div class="dbv-section-title">② 通用层覆盖（各平台明细最终汇入的地方）</div>
        <div v-for="g in (health.generic || [])" :key="g.table" class="dbv-matrix">
          <div class="dbv-matrix-title">{{ g.label }} <span class="dbv-muted">{{ g.table }}</span></div>
          <table class="dbv-tbl">
            <thead>
              <tr><th class="dbv-th-date">日期</th><th v-for="p in g.platforms" :key="p">{{ p }}</th></tr>
            </thead>
            <tbody>
              <tr v-for="r in g.rows" :key="r.date">
                <td class="dbv-td-date">{{ r.date.slice(5) }}</td>
                <td v-for="(n, i) in r.cells" :key="i" :class="n > 0 ? 'dbv-ok' : 'dbv-no'">{{ n > 0 ? n : '·' }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 3) 导入异常 -->
        <div class="dbv-section-title">③ 导入异常（⚠️ row_count = 0 表示"文件传了但一行都没解析出来"）</div>
        <el-row :gutter="12">
          <el-col :span="14">
            <el-table :data="health.issues?.zeroRowBatches || []" size="small" border height="260">
              <el-table-column prop="id" label="#" width="60" />
              <el-table-column prop="platform" label="平台" width="150" show-overflow-tooltip />
              <el-table-column prop="file_name" label="文件名" show-overflow-tooltip />
              <el-table-column label="时间" width="130">
                <template #default="{ row }">{{ String(row.created_at || '').slice(5, 16) }}</template>
              </el-table-column>
            </el-table>
            <div class="dbv-muted" style="margin-top:6px">
              共 {{ health.issues?.batchTotal || 0 }} 个导入批次，其中 {{ (health.issues?.zeroRowBatches || []).length }} 个为 0 行
            </div>
          </el-col>
          <el-col :span="10">
            <div class="dbv-muted" style="margin-bottom:6px">各平台最近一次导入</div>
            <el-table :data="lastImportRows" size="small" border height="150">
              <el-table-column prop="platform" label="平台" width="130" show-overflow-tooltip />
              <el-table-column prop="rows" label="行数" width="80" />
              <el-table-column prop="range" label="数据区间" show-overflow-tooltip />
            </el-table>
            <div class="dbv-muted" style="margin:10px 0 6px">建了表但从未写入（{{ (health.issues?.emptyTables || []).length }}）</div>
            <div class="dbv-orphans">
              <el-tag v-for="t in (health.issues?.emptyTables || [])" :key="t" size="small" class="dbv-tag-table" @click="openTable(t)">{{ t }}</el-tag>
            </div>
          </el-col>
        </el-row>

        <!-- 4) 对账体检 -->
        <div class="dbv-section-title">④ 对账体检（同一门店同日同渠道：收银机侧 vs 平台侧）</div>
        <el-alert type="info" :closable="false" style="margin-bottom:10px">
          {{ health.recon?.note || '两侧口径不同，本表只并列展示数字与候选规则命中情况，不下结论。' }}
        </el-alert>
        <div class="dbv-recon-summary">
          <el-tag size="small" type="danger">缺平台侧 {{ health.recon?.summary?.missingPlatform || 0 }}</el-tag>
          <el-tag size="small" type="warning">缺收银侧 {{ health.recon?.summary?.missingPos || 0 }}</el-tag>
          <el-tag size="small" type="success">两侧都在·规则命中 {{ health.recon?.summary?.matchedByRule || 0 }}</el-tag>
          <el-tag size="small" type="info">两侧都在·需核对 {{ health.recon?.summary?.needReview || 0 }}</el-tag>
          <el-tag size="small" type="info">忽略占位行 {{ health.recon?.summary?.ignoredPlaceholder || 0 }}</el-tag>
        </div>
        <div class="dbv-toolbar" style="margin-top:8px">
          <el-input v-model="reconKeyword" size="small" placeholder="过滤：门店 / 渠道 / 状态" clearable style="width:240px" />
          <el-checkbox v-model="reconOnlyIssues" size="small">只看问题（缺一侧 / 需人工核对）</el-checkbox>
        </div>
        <el-table :data="filteredRecon" size="small" border height="420">
          <el-table-column prop="date" label="日期" width="100" />
          <el-table-column prop="store" label="门店" width="170" show-overflow-tooltip />
          <el-table-column label="渠道" width="180">
            <template #default="{ row }">{{ row.channelGroup }} / {{ row.channel }}</template>
          </el-table-column>
          <el-table-column label="状态" width="160">
            <template #default="{ row }">
              <el-tag size="small" :type="row.status.includes('缺') ? 'danger' : (row.status.includes('需人工') ? 'warning' : 'success')">{{ row.status }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="收银机侧（原价/优惠/净额/实收/单量）" min-width="240">
            <template #default="{ row }">
              {{ row.pos.gross }} / {{ row.pos.discount }} / {{ row.pos.net }} / {{ row.pos.actual }} / {{ row.pos.orders }}
            </template>
          </el-table-column>
          <el-table-column label="平台侧（原价/优惠/实收/单量）" min-width="220">
            <template #default="{ row }">
              {{ row.plat.gross }} / {{ row.plat.discount }} / {{ row.plat.actual }} / {{ row.plat.orders }}
            </template>
          </el-table-column>
          <el-table-column label="命中规则" min-width="200" show-overflow-tooltip>
            <template #default="{ row }">{{ (row.ruleHits || []).join('、') || '—' }}</template>
          </el-table-column>
        </el-table>
        <div class="dbv-muted" style="margin-top:6px">
          共 {{ health.recon?.total || 0 }} 条（最多展示 300 条）
        </div>
      </el-tab-pane>

      <!-- ============ SQL ============ -->
      <el-tab-pane label="SQL 查询（只读）" name="sql">
        <el-input
          v-model="sql" type="textarea" :rows="5"
          placeholder="只允许 SELECT / WITH 单条语句，例如：SELECT store_name, COUNT(*) c FROM dish_sales GROUP BY store_name ORDER BY c DESC LIMIT 10"
          @keydown.ctrl.enter="runSql"
        />
        <div class="dbv-toolbar" style="margin-top:8px">
          <el-button type="primary" size="small" :loading="runningSql" @click="runSql">执行（Ctrl+Enter）</el-button>
          <el-tag v-if="sqlResult.ms !== undefined" size="small" type="success">耗时 {{ sqlResult.ms }} ms</el-tag>
          <el-tag v-if="sqlResult.rowCount !== undefined" size="small">{{ sqlResult.rowCount }} 行{{ sqlResult.truncated ? '（已截断至 1000）' : '' }}</el-tag>
          <el-tag v-if="sqlResult.error" size="small" type="danger">{{ sqlResult.error }}</el-tag>
          <div class="dbv-grow"></div>
          <span class="dbv-muted">常用：sqlite_master（看表结构）· PRAGMA 已被禁用</span>
        </div>
        <el-table v-if="sqlResult.rows?.length" :data="sqlResult.rows" size="small" border height="380">
          <el-table-column v-for="c in (sqlResult.columns || [])" :key="c" :prop="c" :label="c" min-width="130" show-overflow-tooltip />
        </el-table>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import {
  dbViewerOverview, dbViewerTables, dbViewerTable,
  dbViewerFeatureMap, dbViewerFiles, dbViewerFile, dbViewerQuery,
  dbViewerDataHealth,
} from '@/api'

const tab = ref('tables')
const overview = ref({})
const tables = ref([])
const tableKeyword = ref('')
const current = ref('')
const detail = ref({})
const detailTab = ref('rows')
const loadingRows = ref(false)
const page = ref(1)
const pageSize = ref(50)
const rowQuery = ref('')
const orderBy = ref('')
const order = ref('desc')

const dirPath = ref('')
const files = ref([])
const fileRoots = ref([])
const filePreview = ref(null)

const featureMap = ref({})
const mapKeyword = ref('')
const pickTable = ref('')

const sql = ref('')
const sqlResult = ref({})
const runningSql = ref(false)

// 数据体检
const healthDays = ref(14)
const health = ref({})
const reconKeyword = ref('')
const reconOnlyIssues = ref(false)

const lastImportRows = computed(() => {
  const m = health.value.issues?.lastByPlatform || {}
  return Object.entries(m).map(([platform, b]) => ({
    platform,
    rows: b.row_count,
    range: b.date_from ? b.date_from + '~' + b.date_to : '—',
    at: b.created_at,
  }))
})

const filteredRecon = computed(() => {
  const kw = reconKeyword.value.trim().toLowerCase()
  let rows = health.value.recon?.rows || []
  if (reconOnlyIssues.value) rows = rows.filter(r => r.status.includes('缺') || r.status.includes('需人工'))
  if (kw) {
    rows = rows.filter(r =>
      String(r.store || '').toLowerCase().includes(kw) ||
      String(r.channel || '').toLowerCase().includes(kw) ||
      String(r.channelGroup || '').toLowerCase().includes(kw) ||
      String(r.status || '').toLowerCase().includes(kw))
  }
  return rows
})

const rowColumns = computed(() => {
  const rows = detail.value.rows || []
  if (!rows.length) return []
  return Object.keys(rows[0]).filter(k => k !== '__rowid__')
})

const groupedTables = computed(() => {
  const kw = tableKeyword.value.trim().toLowerCase()
  const list = tables.value.filter(t => !kw || t.name.toLowerCase().includes(kw) || (t.category || '').toLowerCase().includes(kw))
  const map = new Map()
  for (const t of list) {
    if (!map.has(t.category)) map.set(t.category, [])
    map.get(t.category).push(t)
  }
  return [...map.entries()].map(([category, items]) => ({ category, items }))
})

const filteredViews = computed(() => {
  const kw = mapKeyword.value.trim().toLowerCase()
  const views = featureMap.value.views || []
  if (!kw) return views
  return views.filter(v =>
    v.view.toLowerCase().includes(kw) ||
    v.apis.some(a => (a.fn || '').toLowerCase().includes(kw) || (a.path || '').toLowerCase().includes(kw) || a.tables.some(t => t.toLowerCase().includes(kw)))
  )
})

// ==================== 加载 ====================
async function loadOverview() {
  try {
    overview.value = await dbViewerOverview()
  } catch (e) { ElMessage.error(e.message) }
}
async function loadTables() {
  try {
    const r = await dbViewerTables()
    tables.value = r.tables || []
  } catch (e) { ElMessage.error(e.message) }
}
async function openTable(name) {
  tab.value = 'tables'
  current.value = name
  detailTab.value = 'rows'
  rowQuery.value = ''
  orderBy.value = ''
  await loadRows(1)
}
async function loadRows(p) {
  if (!current.value) return
  page.value = typeof p === 'number' ? p : page.value
  loadingRows.value = true
  try {
    detail.value = await dbViewerTable(current.value, {
      page: page.value, pageSize: pageSize.value,
      q: rowQuery.value || undefined,
      orderBy: orderBy.value || undefined,
      order: order.value,
    })
  } catch (e) { ElMessage.error(e.message) } finally { loadingRows.value = false }
}
function onSizeChange(s) { pageSize.value = s; loadRows(1) }

async function openDir(dir) {
  try {
    const r = await dbViewerFiles(dir || '')
    dirPath.value = r.root === '(项目根)' ? '' : r.root
    files.value = r.entries || []
    fileRoots.value = r.roots || []
    filePreview.value = null
  } catch (e) { ElMessage.error(e.message) }
}
async function onFileRow(row) {
  if (row.dir) return openDir(row.path)
  try {
    const isImg = /\.(png|jpe?g|gif|webp|svg|ico)$/i.test(row.name)
    filePreview.value = await dbViewerFile(row.path, isImg ? 'data' : '')
  } catch (e) { ElMessage.error(e.message) }
}

async function loadFeatureMap() {
  try { featureMap.value = await dbViewerFeatureMap() } catch (e) { ElMessage.error(e.message) }
}

async function loadHealth() {
  try {
    health.value = await dbViewerDataHealth(healthDays.value)
  } catch (e) { ElMessage.error(e.message) }
}

async function runSql() {
  if (!sql.value.trim()) return
  runningSql.value = true
  try {
    sqlResult.value = await dbViewerQuery(sql.value)
  } catch (e) {
    sqlResult.value = { error: e.message }
  } finally { runningSql.value = false }
}

// ==================== 格式化 ====================
function fmtSize(n) {
  const v = Number(n || 0)
  if (v < 1024) return v + ' B'
  if (v < 1048576) return (v / 1024).toFixed(1) + ' KB'
  return (v / 1048576).toFixed(1) + ' MB'
}
function fmtTime(t) {
  if (!t) return '—'
  const d = new Date(t)
  if (isNaN(d.getTime())) return String(t)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

onMounted(() => { loadOverview(); loadTables(); loadHealth() })
</script>

<style scoped>
.dbv-page { padding: 16px 20px 40px; }
.dbv-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
.dbv-head h2 { margin: 0 0 4px; font-size: 20px; }
.dbv-sub { margin: 0; color: #909399; font-size: 13px; }
.dbv-head-actions { display: flex; gap: 8px; align-items: center; }
.dbv-alert { margin-bottom: 12px; }
.dbv-tabs :deep(.el-tabs__header) { margin-bottom: 10px; }

.dbv-split { display: flex; gap: 14px; align-items: flex-start; }
.dbv-side { width: 320px; flex: 0 0 320px; border: 1px solid #ebeef5; border-radius: 8px; padding: 10px; background: #fff; }
.dbv-side-body { max-height: 620px; overflow: auto; }
.dbv-group { font-size: 12px; color: #909399; padding: 8px 6px 4px; position: sticky; top: 0; background: #fff; }
.dbv-table-item { display: flex; justify-content: space-between; align-items: center; padding: 6px 8px; border-radius: 6px; cursor: pointer; font-size: 13px; }
.dbv-table-item:hover { background: #f5f7fa; }
.dbv-table-item.active { background: #ecf5ff; color: #409eff; }
.dbv-name { font-family: Menlo, Consolas, monospace; }
.dbv-meta { display: flex; gap: 6px; align-items: center; }
.dbv-rows { font-size: 11px; color: #606266; }
.dbv-rows.zero { color: #c0c4cc; }
.dbv-ref { font-size: 11px; color: #67c23a; }

.dbv-main { flex: 1; min-width: 0; }
.dbv-toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
.dbv-grow { flex: 1; }
.dbv-cur { font-family: Menlo, Consolas, monospace; font-size: 15px; }
.dbv-pager { display: flex; justify-content: flex-end; margin-top: 10px; }
.dbv-section-title { font-size: 13px; font-weight: 600; color: #303133; margin: 14px 0 8px; }
.dbv-muted { color: #909399; font-size: 12px; }
.dbv-code { font-family: Menlo, Consolas, monospace; font-size: 12px; background: #f5f7fa; padding: 6px 8px; border-radius: 4px; margin-bottom: 4px; word-break: break-all; }
.dbv-code-block { background: #f5f7fa; padding: 12px; border-radius: 6px; max-height: 460px; overflow: auto; font-size: 12px; line-height: 1.6; }

.dbv-root-tag { cursor: pointer; }
.dbv-preview { margin-top: 12px; }
.dbv-img { max-width: 100%; max-height: 460px; border: 1px solid #ebeef5; border-radius: 6px; }

.dbv-map-list { max-height: 560px; overflow: auto; border: 1px solid #ebeef5; border-radius: 8px; padding: 10px; background: #fff; }
.dbv-map-list.sm { max-height: 300px; }
.dbv-map-item { margin-bottom: 12px; }
.dbv-map-view { font-size: 13px; font-weight: 600; color: #303133; margin-bottom: 4px; word-break: break-all; }
.dbv-map-api { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 3px 0 3px 14px; font-size: 12px; }
.dbv-map-fn { font-family: Menlo, Consolas, monospace; color: #409eff; }
.dbv-map-path { font-family: Menlo, Consolas, monospace; color: #909399; }
.dbv-tag-table { cursor: pointer; }
.dbv-orphans { display: flex; flex-wrap: wrap; gap: 6px; }

/* 数据体检 */
.dbv-matrix { margin-bottom: 16px; }
.dbv-matrix-title { font-size: 13px; font-weight: 600; margin-bottom: 6px; }
.dbv-tbl { border-collapse: collapse; font-size: 12px; width: 100%; }
.dbv-tbl th, .dbv-tbl td { border: 1px solid #ebeef5; padding: 3px 6px; text-align: center; white-space: nowrap; }
.dbv-tbl thead th { background: #fafafa; font-weight: 500; }
.dbv-th-role { font-weight: 600; }
.dbv-th-table { font-size: 10px; color: #909399; font-family: Menlo, Consolas, monospace; }
.dbv-th-date, .dbv-td-date { position: sticky; left: 0; background: #fff; text-align: left; font-family: Menlo, Consolas, monospace; }
.dbv-ok { background: #f0f9eb; color: #529b2e; }
.dbv-no { background: #fafafa; color: #c0c4cc; }
.dbv-row-today .dbv-td-date { font-weight: 700; }
.dbv-recon-summary { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 4px; }
</style>
