<template>
  <main class="store-basic-page">
    <section class="page-hero">
      <div>
        <span class="eyebrow">STORE DIRECTORY</span>
        <h2>门店基本信息</h2>
        <p>集中维护门店档案。先建立门店，再到“门店区域管理”划分归属区域。</p>
      </div>
      <el-button type="primary" size="large" class="create-store-button" @click="openCreate">+ 新建门店</el-button>
    </section>

    <section class="stats-grid">
      <article class="stat-card"><span>门店总数</span><b>{{ stats.total ?? total ?? '—' }}</b><small>已建立基础档案</small></article>
      <article class="stat-card positive"><span>已开业</span><b>{{ stats.open_count ?? '—' }}</b><small>正常营业门店</small></article>
      <article class="stat-card warning"><span>筹建中</span><b>{{ stats.planning_count ?? '—' }}</b><small>待开业门店</small></article>
      <article class="stat-card"><span>直营门店</span><b>{{ stats.direct_count ?? '—' }}</b><small>直营经营模式</small></article>
      <article class="stat-card violet"><span>联营 / 加盟</span><b>{{ joinedStoreCount }}</b><small>联营 {{ stats.joint_count ?? 0 }} · 加盟 {{ stats.franchise_count ?? 0 }}</small></article>
    </section>

    <section class="directory-card">
      <header class="directory-header">
        <div><span class="section-kicker">STORE LIST</span><h3>门店档案</h3><p>共 {{ total }} 家门店，可按名称、状态、店型或法人查找。</p></div>
        <el-button plain @click="resetFilters">重置筛选</el-button>
      </header>
      <div class="filters">
        <el-input v-model="keyword" clearable placeholder="搜索门店名称" @keyup.enter="search" />
        <el-select v-model="status" clearable placeholder="全部状态"><el-option v-for="item in statusOptions" :key="item" :label="item" :value="item" /></el-select>
        <el-select v-model="storeType" clearable placeholder="全部店型"><el-option v-for="item in typeOptions" :key="item" :label="item" :value="item" /></el-select>
        <el-input v-model="legalPerson" clearable placeholder="法人名称" @keyup.enter="search" />
        <el-button type="primary" @click="search">查询</el-button>
      </div>
      <el-table :data="stores" v-loading="loading" stripe class="store-table" empty-text="暂无门店，点击右上角“新建门店”开始录入">
        <el-table-column type="index" label="#" width="58" />
        <el-table-column prop="store_name" label="门店名称" min-width="220" fixed="left" show-overflow-tooltip />
        <el-table-column prop="status" label="状态" width="104"><template #default="{ row }"><el-tag :type="statusTag(row.status)" effect="plain" size="small">{{ row.status || '—' }}</el-tag></template></el-table-column>
        <el-table-column prop="store_type" label="店型" width="98" />
        <el-table-column prop="legal_person" label="法人" width="112" show-overflow-tooltip />
        <el-table-column label="所在地区" min-width="160"><template #default="{ row }">{{ [row.province, row.city, row.district].filter(Boolean).join(' / ') || '—' }}</template></el-table-column>
        <el-table-column prop="address" label="详细地址" min-width="220" show-overflow-tooltip />
        <el-table-column prop="phone" label="联系电话" width="134" />
        <el-table-column prop="opening_date" label="开业日期" width="120" />
        <el-table-column label="操作" width="84" fixed="right"><template #default="{ row }"><el-button type="primary" link @click="openEdit(row)">编辑</el-button></template></el-table-column>
      </el-table>
      <el-pagination v-if="total > pageSize" v-model:current-page="page" :page-size="pageSize" :total="total" layout="total, prev, pager, next" class="pagination" @current-change="loadData" />
    </section>

    <el-dialog v-model="formVisible" :title="creating ? '新建门店' : `编辑门店 · ${form.store_name || ''}`" width="min(820px, calc(100vw - 32px))" destroy-on-close class="store-form-dialog">
      <div class="dialog-intro"><b>{{ creating ? '录入新门店' : '维护门店档案' }}</b><span>带 <em>*</em> 的字段为必填项；其他资料可在以后补充。</span></div>
      <el-form label-position="top" class="store-form">
        <section class="form-section"><h4>基础资料</h4><div class="form-grid three"><el-form-item label="门店名称" required><el-input v-model="form.store_name" placeholder="例如：鹅太公烧鹅（龙岗万科店）" /></el-form-item><el-form-item label="经营状态"><el-select v-model="form.status"><el-option v-for="item in statusOptions" :key="item" :label="item" :value="item" /></el-select></el-form-item><el-form-item label="门店类型"><el-select v-model="form.store_type"><el-option v-for="item in typeOptions" :key="item" :label="item" :value="item" /></el-select></el-form-item></div><div class="form-grid two"><el-form-item label="法人"><el-input v-model="form.legal_person" placeholder="可稍后补充" /></el-form-item><el-form-item label="收款性质"><el-input v-model="form.payment_type" placeholder="例如：法人收款" /></el-form-item></div></section>
        <section class="form-section"><h4>地址与联系</h4><div class="form-grid three"><el-form-item label="省"><el-input v-model="form.province" placeholder="广东省" /></el-form-item><el-form-item label="市"><el-input v-model="form.city" placeholder="深圳市" /></el-form-item><el-form-item label="区 / 县"><el-input v-model="form.district" placeholder="龙岗区" /></el-form-item></div><el-form-item label="详细地址"><el-input v-model="form.address" placeholder="填写街道、商场或门牌号" /></el-form-item><div class="form-grid two"><el-form-item label="联系电话"><el-input v-model="form.phone" placeholder="门店电话或负责人电话" /></el-form-item><el-form-item label="营业时间"><el-input v-model="form.business_hours" placeholder="例如：10:00 - 22:00" /></el-form-item></div></section>
        <section class="form-section optional-section"><div class="section-title-row"><h4>扩展资料</h4><span>可选</span></div><div class="form-grid three"><el-form-item label="开业日期"><el-date-picker v-model="form.opening_date" :clearable="false" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" /></el-form-item><el-form-item label="门店面积（㎡）"><el-input v-model="form.store_size" placeholder="例如：120" /></el-form-item><el-form-item label="二人桌数量"><el-input-number v-model="form.table_2person" :min="0" :max="999" controls-position="right" /></el-form-item></div><div class="form-grid three"><el-form-item label="四人桌数量"><el-input-number v-model="form.table_4person" :min="0" :max="999" controls-position="right" /></el-form-item><el-form-item label="纬度（lat）"><el-input v-model="form.lat" placeholder="22.5431" /></el-form-item><el-form-item label="经度（lng）"><el-input v-model="form.lng" placeholder="114.0579" /></el-form-item></div><el-button plain :loading="geocoding" @click="fetchLatLng">根据地址获取经纬度</el-button></section>
      </el-form>
      <template #footer><el-button @click="formVisible = false">取消</el-button><el-button type="primary" :loading="saving" @click="saveStore">{{ creating ? '创建门店' : '保存修改' }}</el-button></template>
    </el-dialog>
  </main>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { createStore, geocodeAddress, getStoreById, getStoreStats, getStores, updateStore } from '@/api'
import { ElMessage } from 'element-plus'

const statusOptions = ['正常营业', '筹建中', '迁址', '已闭店']
const typeOptions = ['直营店', '加盟店', '联营店']
const makeForm = () => ({ store_name: '', status: '筹建中', store_type: '直营店', legal_person: '', payment_type: '法人收款', region: '', province: '', city: '', district: '', address: '', phone: '', business_hours: '', opening_date: null, table_2person: 0, table_4person: 0, store_size: '', lat: '', lng: '' })

const stats = ref({})
const stores = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(10)
const loading = ref(false)
const keyword = ref('')
const status = ref('')
const storeType = ref('')
const legalPerson = ref('')
const formVisible = ref(false)
const creating = ref(true)
const saving = ref(false)
const geocoding = ref(false)
const form = reactive(makeForm())
const joinedStoreCount = computed(() => Number(stats.value.joint_count || 0) + Number(stats.value.franchise_count || 0))

function resetForm(values = {}) { Object.assign(form, makeForm(), values) }
function statusTag(value) { return ({ '正常营业': 'success', '筹建中': 'warning', '已闭店': 'info', '迁址': 'danger' })[value] || '' }
function openCreate() { creating.value = true; resetForm(); formVisible.value = true }
async function openEdit(store) { try { const data = await getStoreById(store.id); creating.value = false; resetForm(data.store || {}); formVisible.value = true } catch (error) { ElMessage.error(error.message || '加载门店信息失败') } }

async function loadStats() { try { const data = await getStoreStats(); stats.value = data.stats || {} } catch {} }
async function loadData() { loading.value = true; try { const params = { page: page.value, page_size: pageSize.value }; if (keyword.value) params.keyword = keyword.value; if (status.value) params.status = status.value; if (storeType.value) params.store_type = storeType.value; if (legalPerson.value) params.legal_person = legalPerson.value; const data = await getStores(params); stores.value = data.stores || []; total.value = data.total || 0 } catch (error) { ElMessage.error(`加载失败：${error.message}`) } finally { loading.value = false } }
function search() { page.value = 1; loadData() }
function resetFilters() { keyword.value = ''; status.value = ''; storeType.value = ''; legalPerson.value = ''; search() }

async function fetchLatLng() { const address = [form.province, form.city, form.district, form.address].filter(Boolean).join(''); if (!address) return ElMessage.warning('请先填写省、市、区或详细地址'); geocoding.value = true; try { const data = await geocodeAddress({ address }); if (data.status !== '1' || !data.geocodes?.length) throw new Error(data.info || '未找到该地址'); const [lng, lat] = data.geocodes[0].location.split(','); form.lng = lng; form.lat = lat; ElMessage.success('已获取经纬度') } catch (error) { ElMessage.warning(`获取失败：${error.message || '请手动填写'}`) } finally { geocoding.value = false } }
async function saveStore() { if (!form.store_name.trim()) return ElMessage.warning('请填写门店名称'); saving.value = true; try { const payload = { ...form, store_name: form.store_name.trim() }; if (creating.value) { await createStore(payload); page.value = 1; ElMessage.success('门店已创建，可前往“门店区域管理”设置归属') } else { await updateStore(form.id, payload); ElMessage.success('门店资料已保存') } formVisible.value = false; await Promise.all([loadData(), loadStats()]) } catch (error) { ElMessage.error(`保存失败：${error.message}`) } finally { saving.value = false } }

onMounted(() => { loadStats(); loadData() })
</script>

<style scoped>
.store-basic-page { max-width: 1480px; margin: 0 auto; }.page-hero { display:flex; align-items:center; justify-content:space-between; gap:24px; padding:26px 30px; border-radius:16px; background:linear-gradient(118deg,#13396d,#2674c9 62%,#4aa6e8); color:#fff; box-shadow:0 10px 24px rgba(24,72,135,.18); }.eyebrow,.section-kicker { display:block; font-size:11px; font-weight:800; letter-spacing:1.5px; }.eyebrow { color:#b9dcff; }.page-hero h2 { margin:7px 0; font-size:26px; }.page-hero p { margin:0; color:#d7ebff; font-size:13px; }.create-store-button { min-width:132px; border-color:#fff; font-weight:700; }.stats-grid { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:14px; margin:16px 0; }.stat-card { min-height:104px; padding:18px 19px; border:1px solid #e3eaf3; border-radius:12px; background:#fff; box-shadow:0 5px 15px rgba(31,62,106,.04); }.stat-card span,.stat-card small { display:block; color:#8492a6; font-size:12px; }.stat-card b { display:block; margin:8px 0 5px; color:#253f66; font-size:27px; line-height:1; }.stat-card.positive b { color:#14a06f; }.stat-card.warning b { color:#e2932e; }.stat-card.violet b { color:#7865d6; }.directory-card { padding:21px; border:1px solid #e1e8f1; border-radius:13px; background:#fff; box-shadow:0 8px 22px rgba(31,62,106,.05); }.directory-header { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; padding-bottom:17px; border-bottom:1px solid #e8edf4; }.section-kicker { color:#5b86ce; }.directory-header h3 { margin:5px 0; color:#273f62; font-size:20px; }.directory-header p { margin:0; color:#8b99aa; font-size:12px; }.filters { display:grid; grid-template-columns:minmax(190px,1.35fr) minmax(130px,.75fr) minmax(130px,.75fr) minmax(160px,1fr) auto; gap:11px; padding:17px 0; }.store-table { width:100%; overflow:hidden; border:1px solid #e4eaf2; border-radius:8px; }.pagination { justify-content:flex-end; margin-top:16px; }.dialog-intro { display:flex; flex-direction:column; gap:4px; margin:-2px 0 19px; padding:12px 14px; border:1px solid #d9e9ff; border-radius:8px; background:#f6faff; color:#7185a1; font-size:12px; }.dialog-intro b { color:#3268aa; font-size:14px; }.dialog-intro em { color:#e35555; font-style:normal; }.form-section { padding:17px 0 19px; border-top:1px solid #edf0f5; }.form-section:first-child { padding-top:0; border-top:0; }.form-section h4 { margin:0 0 14px; color:#385473; font-size:15px; }.section-title-row { display:flex; align-items:center; justify-content:space-between; }.section-title-row span { padding:2px 8px; border-radius:999px; background:#f1f4f8; color:#8796a8; font-size:11px; }.form-grid { display:grid; gap:12px; }.form-grid.two { grid-template-columns:repeat(2,minmax(0,1fr)); }.form-grid.three { grid-template-columns:repeat(3,minmax(0,1fr)); }.store-form :deep(.el-form-item) { margin-bottom:12px; }.store-form :deep(.el-form-item__label) { padding-bottom:5px; color:#5f7088; font-size:13px; font-weight:650; }.store-form :deep(.el-select),.store-form :deep(.el-date-editor),.store-form :deep(.el-input-number) { width:100%; }.optional-section { padding-bottom:0; }@media (max-width:1100px) { .stats-grid { grid-template-columns:repeat(3,minmax(0,1fr)); }.filters { grid-template-columns:repeat(2,minmax(0,1fr)); }.filters button { width:max-content; } }@media (max-width:700px) { .page-hero { align-items:flex-start; flex-direction:column; }.create-store-button { width:100%; }.stats-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }.directory-card { padding:15px; }.directory-header { align-items:flex-start; flex-direction:column; }.filters,.form-grid.two,.form-grid.three { grid-template-columns:1fr; } }
</style>
