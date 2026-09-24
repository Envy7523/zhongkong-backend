<template>
  <main class="store-manager-page">
    <section class="manager-hero">
      <div class="hero-copy">
        <span class="eyebrow">HUMAN RESOURCES · STORE ROSTER</span>
        <h2>门店管理</h2>
        <p>为每间门店明确一位在职店长。绑定结果会自动带入员工档案，便于人员、考勤和运营责任追溯。</p>
      </div>
      <div class="hero-progress">
        <div class="progress-value"><b>{{ boundCount }}</b><span>/ {{ stores.length }} 家已绑定</span></div>
        <el-progress :percentage="bindingPercent" :show-text="false" :stroke-width="7" color="#2f72c9" />
        <small>{{ unboundCount ? `还有 ${unboundCount} 家门店待分配` : '全部门店已完成店长绑定' }}</small>
      </div>
    </section>

    <section class="overview-grid">
      <article class="overview-card total"><span>门店总数</span><b>{{ stores.length }}</b><small>当前可管理门店</small></article>
      <article class="overview-card bound"><span>已绑定店长</span><b>{{ boundCount }}</b><small>已建立责任人</small></article>
      <article class="overview-card pending"><span>待分配</span><b>{{ unboundCount }}</b><small>建议优先处理</small></article>
      <article class="overview-card staff"><span>可选在职员工</span><b>{{ candidates.length }}</b><small>来自员工档案</small></article>
    </section>

    <section class="directory-card">
      <header class="directory-head">
        <div><span class="section-kicker">STORE RESPONSIBILITY</span><h3>门店责任人</h3><p>仅展示岗位为实习店长、一级店长、二级店长等店长层级的在职员工。选择后立即保存；解除绑定不会修改员工的归属门店、岗位或其他档案资料。</p></div>
        <el-button plain @click="load" :loading="loading">刷新列表</el-button>
      </header>
      <div class="manager-toolbar">
        <el-input v-model="keyword" clearable placeholder="搜索门店、店长或岗位" class="search-input"><template #prefix>⌕</template></el-input>
        <el-radio-group v-model="statusFilter" size="small" class="status-filter"><el-radio-button value="all">全部 {{ stores.length }}</el-radio-button><el-radio-button value="bound">已绑定 {{ boundCount }}</el-radio-button><el-radio-button value="pending">待分配 {{ unboundCount }}</el-radio-button></el-radio-group>
      </div>

      <div v-loading="loading" class="store-grid">
        <article v-for="row in filteredStores" :key="row.id" class="store-card" :class="{ pending: !row.manager_id }">
          <header>
            <div class="store-mark">{{ row.store_name?.slice(0, 1) || '店' }}</div>
            <div class="store-title"><h4>{{ row.store_name }}</h4><span v-if="row.manager_id" class="status-bound"><i></i>已绑定</span><span v-else class="status-pending">待分配</span></div>
          </header>
          <div v-if="row.manager_name" class="manager-summary">
            <div class="person-avatar">{{ row.manager_name.slice(0, 1) }}</div>
            <div><strong>{{ row.manager_name }}</strong><p>{{ row.manager_position || '岗位未填写' }}<template v-if="row.manager_phone"> · {{ row.manager_phone }}</template></p></div>
          </div>
          <div v-else class="manager-empty"><span>负责人</span><b>尚未指定店长</b><p>请从在职员工中选择一位责任人</p></div>
          <div class="assign-area"><label>{{ row.manager_id ? '变更店长' : '分配店长' }}</label><el-select v-model="row.draft_manager_id" filterable clearable placeholder="选择店长层级员工" @change="save(row)"><el-option v-for="employee in candidates" :key="employee.id" :value="employee.id" :label="employeeLabel(employee)"><div class="employee-option"><b>{{ employee.name }}</b><span>{{ employee.position || '店长岗位' }}{{ employee.job_level ? ` · ${employee.job_level}` : '' }}{{ employee.store_name ? ` · ${employee.store_name}` : '' }}</span></div></el-option></el-select></div>
        </article>
      </div>
      <el-empty v-if="!loading && !filteredStores.length" description="没有符合当前条件的门店" :image-size="74" />
    </section>
  </main>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { getStaffStoreManagers, saveStaffStoreManager } from '@/api'

const stores = ref([])
const candidates = ref([])
const loading = ref(false)
const keyword = ref('')
const statusFilter = ref('all')
const boundCount = computed(() => stores.value.filter(item => item.manager_id).length)
const unboundCount = computed(() => Math.max(0, stores.value.length - boundCount.value))
const bindingPercent = computed(() => stores.value.length ? Math.round(boundCount.value / stores.value.length * 100) : 0)
const filteredStores = computed(() => {
  const key = keyword.value.trim().toLowerCase()
  return stores.value.filter(item => {
    const statusMatches = statusFilter.value === 'all' || (statusFilter.value === 'bound' ? item.manager_id : !item.manager_id)
    return statusMatches && (!key || `${item.store_name} ${item.manager_name} ${item.manager_position}`.toLowerCase().includes(key))
  })
})
function employeeLabel(employee) { return `${employee.name}${employee.position ? ` · ${employee.position}` : ' · 店长岗位'}${employee.job_level ? ` · ${employee.job_level}` : ''}${employee.store_name ? ` · ${employee.store_name}` : ''}` }
async function load() { loading.value = true; try { const data = await getStaffStoreManagers(); stores.value = (data.stores || []).map(item => ({ ...item, draft_manager_id: item.manager_id || null })); candidates.value = data.candidates || [] } catch (error) { ElMessage.error('门店管理加载失败：' + (error.message || '')) } finally { loading.value = false } }
async function save(row) { const previous = row.manager_id || null; try { const data = await saveStaffStoreManager(row.id, row.draft_manager_id || null); row.manager_id = data.manager?.id || null; row.manager_name = data.manager?.name || ''; row.manager_phone = data.manager?.phone || ''; row.manager_position = data.manager?.position || ''; ElMessage.success(row.manager_id ? `已绑定 ${row.manager_name} 为店长` : '已解除店长绑定') } catch (error) { row.draft_manager_id = previous; ElMessage.error('保存失败：' + (error.message || '')) } }
onMounted(load)
</script>

<style scoped>
.store-manager-page{max-width:1440px;margin:0 auto;padding:2px 0 32px;color:#263a57}.manager-hero{display:grid;grid-template-columns:minmax(0,1fr) 270px;gap:30px;align-items:center;padding:26px 30px;border:1px solid #d9e8fa;border-radius:18px;background:linear-gradient(118deg,#f8fbff 0%,#edf5ff 68%,#f7fbff);box-shadow:0 12px 30px rgba(38,85,142,.07)}.eyebrow,.section-kicker{display:block;font-size:11px;font-weight:800;letter-spacing:.12em}.eyebrow{color:#5c82b8}.manager-hero h2{margin:6px 0 8px;color:#243f64;font-size:25px}.manager-hero p{max-width:700px;margin:0;color:#72849b;font-size:13px;line-height:1.7}.hero-progress{padding:17px 18px;border:1px solid #dce8f6;border-radius:14px;background:rgba(255,255,255,.8)}.progress-value{display:flex;align-items:baseline;gap:6px;margin-bottom:12px}.progress-value b{color:#2d67b4;font-size:28px;line-height:1}.progress-value span,.hero-progress small{color:#8391a6;font-size:12px}.hero-progress small{display:block;margin-top:8px}.overview-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin:16px 0}.overview-card{min-height:104px;padding:18px 19px;border:1px solid #e3ebf4;border-radius:14px;background:#fff;box-shadow:0 5px 17px rgba(34,70,113,.045)}.overview-card span,.overview-card small{display:block;color:#8594a7;font-size:12px}.overview-card b{display:block;margin:8px 0 4px;color:#2c557f;font-size:27px;line-height:1}.overview-card.bound b{color:#15906e}.overview-card.pending b{color:#d8892f}.overview-card.staff b{color:#7660c8}.directory-card{padding:22px;border:1px solid #e3ebf4;border-radius:18px;background:#fff;box-shadow:0 8px 24px rgba(33,70,112,.045)}.directory-head{display:flex;justify-content:space-between;gap:18px;padding-bottom:18px;border-bottom:1px solid #e8eef5}.section-kicker{color:#5783c1}.directory-head h3{margin:5px 0;color:#2b486d;font-size:19px}.directory-head p{margin:0;color:#8997a8;font-size:12px;line-height:1.6}.manager-toolbar{display:flex;justify-content:space-between;align-items:center;gap:14px;padding:16px 0}.search-input{width:310px}.status-filter{flex:none}.store-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;min-height:110px}.store-card{display:grid;gap:16px;min-height:246px;padding:18px;border:1px solid #e2eaf3;border-radius:14px;background:linear-gradient(145deg,#fff,#fbfdff);transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease}.store-card:hover{transform:translateY(-2px);border-color:#cddff3;box-shadow:0 10px 21px rgba(35,83,137,.1)}.store-card.pending{border-color:#f1dfc2;background:linear-gradient(145deg,#fffdf9,#fff)}.store-card header{display:flex;align-items:center;gap:11px}.store-mark,.person-avatar{display:grid;place-items:center;flex:none;border-radius:11px;font-weight:800}.store-mark{width:38px;height:38px;background:#eaf3ff;color:#3774bd;font-size:16px}.store-title{display:flex;min-width:0;flex:1;align-items:center;justify-content:space-between;gap:8px}.store-title h4{overflow:hidden;margin:0;color:#304e72;font-size:15px;text-overflow:ellipsis;white-space:nowrap}.status-bound,.status-pending{display:inline-flex;align-items:center;gap:4px;flex:none;padding:3px 7px;border-radius:999px;font-size:11px}.status-bound{background:#edfaf5;color:#168067}.status-bound i{width:5px;height:5px;border-radius:50%;background:#23aa81}.status-pending{background:#fff4df;color:#bf7c22}.manager-summary{display:flex;align-items:center;gap:11px;min-height:54px;padding:11px;border-radius:10px;background:#f6f9fd}.person-avatar{width:34px;height:34px;background:#dcecff;color:#3569aa}.manager-summary strong{color:#315274;font-size:14px}.manager-summary p,.manager-empty p{margin:4px 0 0;color:#8796a8;font-size:12px}.manager-empty{min-height:54px;padding:11px;border:1px dashed #d9e1ec;border-radius:10px;background:#fbfcfe}.manager-empty span{display:block;margin-bottom:4px;color:#a0adbd;font-size:11px}.manager-empty b{color:#64768d;font-size:13px}.assign-area{margin-top:auto}.assign-area label{display:block;margin-bottom:6px;color:#6d8199;font-size:12px;font-weight:650}.assign-area :deep(.el-select){width:100%}.employee-option{display:flex;justify-content:space-between;gap:10px}.employee-option span{color:#8796a8;font-size:12px}@media(max-width:1100px){.store-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:760px){.manager-hero{grid-template-columns:1fr;padding:20px}.overview-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.directory-card{padding:16px}.directory-head,.manager-toolbar{align-items:flex-start;flex-direction:column}.search-input{width:100%}.status-filter{display:flex;max-width:100%;overflow:auto}.store-grid{grid-template-columns:1fr}}
</style>
