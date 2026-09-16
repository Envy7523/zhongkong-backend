<template>
  <div class="position-page">
    <section class="position-hero">
      <div><span>ACCESS CONTROL</span><h2>岗位设置</h2><p>岗位是成员唯一的系统角色，决定可访问的业务模块与操作能力。</p></div>
      <el-button type="primary" round @click="openCreate"><el-icon><Plus /></el-icon>新增岗位</el-button>
    </section>

    <section class="position-layout">
      <div class="position-list-card">
        <header><b>岗位目录</b><span>{{ positions.length }} 个岗位</span></header>
        <div v-loading="loading" class="position-list">
          <button v-for="position in positions" :key="position.id" type="button" :class="['position-item',{ active: selectedId === position.id && !isCreating }]" @click="selectPosition(position.id)">
            <span class="position-mark">{{ String(position.name).slice(0,1) }}</span><span class="position-item-copy"><b>{{ position.name }}</b><small>{{ position.member_count }} 位成员 · {{ position.permissions?.includes('*') ? '全部权限' : `${position.permissions?.length || 0} 项权限` }}</small></span><el-tag v-if="position.is_system" size="small" effect="plain">系统</el-tag>
          </button>
        </div>
      </div>
      <section class="position-editor-card" v-loading="loading">
        <template v-if="selectedPosition || isCreating">
          <header class="editor-heading"><div><span>{{ isCreating ? '新建岗位' : '岗位权限配置' }}</span><h3>{{ editor.name || selectedPosition?.name || '新岗位' }}</h3></div><el-button v-if="selectedPosition && !selectedPosition.is_system" link type="danger" @click="removePosition">删除岗位</el-button></header>
          <el-form label-position="top" class="position-form">
            <div class="position-form-top"><el-form-item label="岗位名称" required><el-input v-model.trim="editor.name" maxlength="40" placeholder="例如：区域督导" /></el-form-item><el-form-item label="当前成员"><el-input :model-value="`${selectedPosition?.member_count || 0} 人`" disabled /></el-form-item></div>
            <el-form-item label="岗位说明"><el-input v-model.trim="editor.description" type="textarea" :rows="2" maxlength="200" show-word-limit /></el-form-item>
            <div class="permission-heading"><div><b>功能权限</b><small>勾选后成员重新登录即可按最新岗位权限使用系统。</small></div><el-checkbox v-model="allPermissions">全部权限</el-checkbox></div>
            <div class="permission-groups"><section v-for="group in permissionGroups" :key="group.key" class="permission-group"><header><div><b>{{ group.label }}</b><small>{{ group.description }}</small></div><el-checkbox :model-value="groupChecked(group)" :indeterminate="groupIndeterminate(group)" @change="value => toggleGroup(group, value)">全选</el-checkbox></header><el-checkbox-group v-model="editor.permissions" class="permission-options"><el-checkbox v-for="item in group.items" :key="item.key" :label="item.key">{{ item.label }}</el-checkbox></el-checkbox-group></section></div>
          </el-form>
          <footer><span>保存后会立即更新该岗位下所有成员的权限档案。</span><el-button type="primary" :loading="saving" @click="savePosition">保存岗位</el-button></footer>
        </template>
        <el-empty v-else description="请选择或新建一个岗位" />
      </section>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { createPosition, deletePosition, getPositions, updatePosition } from '@/api'
import { ElMessage, ElMessageBox } from 'element-plus'

// 与左侧导航一一对应：后续新增侧栏入口时，同步在这里登记权限编码。
const permissionGroups = [
  { key: 'overview', label: '总览', description: '左侧导航 · 总览', items: [{ key: 'dashboard.view', label: '数据概括' }] },
  { key: 'core-business', label: '核心业务', description: '左侧导航 · 核心业务', items: [
    { key: 'analysis.view', label: '数据分析' }, { key: 'store.manage', label: '门店管理' }, { key: 'store-preparation.manage', label: '筹建门店' },
    { key: 'menu.manage', label: '菜品管理' }, { key: 'cost.manage', label: '成本核算' }, { key: 'staff.view', label: '人事专区' },
  ] },
  { key: 'operation-tools', label: '运营工具', description: '左侧导航 · 运营工具', items: [
    { key: 'collab.manage', label: '协同事项' }, { key: 'bookkeeping.manage', label: '记账本' }, { key: 'data-import.manage', label: '数据导入' },
    { key: 'pipeline.manage', label: '一键推送' }, { key: 'ai-assistant.view', label: 'AI 助手' },
  ] },
  { key: 'system', label: '系统管理', description: '左侧导航 · 系统管理', items: [
    { key: 'db-viewer.view', label: '数据库查看' }, { key: 'enterprise-settings.manage', label: '企业设置' }, { key: 'users.manage', label: '人员管理' },
    { key: 'positions.manage', label: '岗位设置' }, { key: 'settings.manage', label: '网页设置' },
  ] },
]
const positions = ref([]), selectedId = ref(null), isCreating = ref(false), loading = ref(false), saving = ref(false)
const editor = reactive({ name: '', description: '', permissions: [] })
const selectedPosition = computed(() => positions.value.find(item => item.id === selectedId.value) || null)
const allKeys = computed(() => permissionGroups.flatMap(group => group.items.map(item => item.key)))
const allPermissions = computed({ get: () => editor.permissions.includes('*'), set: value => { editor.permissions = value ? ['*'] : [] } })
watch(selectedPosition, (position) => { if (position) Object.assign(editor, { name: position.name, description: position.description || '', permissions: [...(position.permissions || [])] }) }, { immediate: true })
onMounted(loadPositions)
async function loadPositions(selectId = selectedId.value) { loading.value = true; try { const result = await getPositions(); positions.value = result.positions || []; selectedId.value = positions.value.some(item => item.id === selectId) ? selectId : positions.value[0]?.id || null; isCreating.value = false } catch (error) { ElMessage.error(`岗位加载失败：${error.message}`) } finally { loading.value = false } }
function selectPosition(id) { isCreating.value = false; selectedId.value = id }
function openCreate() { selectedId.value = null; isCreating.value = true; Object.assign(editor, { name: '', description: '', permissions: [] }) }
function groupChecked(group) { return editor.permissions.includes('*') || group.items.every(item => editor.permissions.includes(item.key)) }
function groupIndeterminate(group) { return !editor.permissions.includes('*') && group.items.some(item => editor.permissions.includes(item.key)) && !group.items.every(item => editor.permissions.includes(item.key)) }
function toggleGroup(group, checked) { if (editor.permissions.includes('*')) editor.permissions = [...allKeys.value]; const keys = group.items.map(item => item.key); editor.permissions = checked ? [...new Set([...editor.permissions, ...keys])] : editor.permissions.filter(key => !keys.includes(key)) }
async function savePosition() { if (!editor.name) return ElMessage.warning('请填写岗位名称'); saving.value = true; try { const payload = { name: editor.name, description: editor.description, permissions: editor.permissions }; if (selectedPosition.value) { await updatePosition(selectedPosition.value.id, payload); await loadPositions(selectedPosition.value.id) } else { const result = await createPosition(payload); await loadPositions(result.position.id) } ElMessage.success('岗位已保存') } catch (error) { ElMessage.error(`保存失败：${error.message}`) } finally { saving.value = false } }
async function removePosition() { try { await ElMessageBox.confirm(`删除“${selectedPosition.value.name}”后，已分配成员将变为未分配岗位，是否继续？`, '删除岗位', { type: 'warning' }); await deletePosition(selectedPosition.value.id); await loadPositions(); ElMessage.success('岗位已删除') } catch (error) { if (error !== 'cancel' && error !== 'close') ElMessage.error(`删除失败：${error.message}`) } }
</script>

<style scoped>
.position-page { color: #23344d; }.position-hero { display:flex; align-items:center; justify-content:space-between; gap:20px; margin-bottom:18px; padding:25px 28px; border-radius:18px; color:#fff; background:radial-gradient(circle at 82% 0%,rgba(158,190,255,.34),transparent 30%),linear-gradient(125deg,#15264f,#2f5bc0); box-shadow:0 17px 36px rgba(30,65,145,.14); }.position-hero span { color:#b9ccff; font-size:10px; font-weight:800; letter-spacing:.18em; }.position-hero h2 { margin:7px 0 4px; font-size:25px; }.position-hero p { margin:0; color:rgba(255,255,255,.73); font-size:13px; }.position-layout { display:grid; grid-template-columns:280px minmax(0,1fr); gap:16px; }.position-list-card,.position-editor-card { min-height:560px; border:1px solid #e2e9f3; border-radius:16px; background:#fff; box-shadow:0 8px 26px rgba(29,48,83,.05); }.position-list-card>header { display:flex; justify-content:space-between; padding:17px 18px; border-bottom:1px solid #edf1f6; }.position-list-card header span { color:#8a99ae; font-size:12px; }.position-list { padding:8px; }.position-item { display:flex; width:100%; align-items:center; gap:10px; margin:3px 0; padding:11px 10px; border:1px solid transparent; border-radius:11px; background:transparent; color:inherit; text-align:left; cursor:pointer; transition:.18s ease; }.position-item:hover { background:#f5f8ff; }.position-item.active { border-color:#d7e4ff; background:#edf4ff; }.position-mark { display:grid; width:30px; height:30px; place-items:center; border-radius:9px; background:#e8f0ff; color:#376bd1; font-weight:750; }.position-item-copy { min-width:0; flex:1; }.position-item-copy b,.position-item-copy small { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.position-item-copy b { font-size:13px; }.position-item-copy small { margin-top:3px; color:#8a98aa; font-size:10px; }.position-editor-card { display:flex; flex-direction:column; }.editor-heading { display:flex; justify-content:space-between; align-items:center; padding:19px 22px; border-bottom:1px solid #edf1f6; }.editor-heading span { color:#8b9ab0; font-size:11px; }.editor-heading h3 { margin:4px 0 0; font-size:18px; }.position-form { flex:1; padding:20px 22px; }.position-form-top { display:grid; grid-template-columns:minmax(0,1fr) 150px; gap:14px; }.permission-heading { display:flex; align-items:center; justify-content:space-between; gap:16px; margin:8px 0 12px; }.permission-heading b,.permission-heading small { display:block; }.permission-heading small { margin-top:4px; color:#8b99ab; font-size:11px; }.permission-groups { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }.permission-group { padding:13px; border:1px solid #e4eaf3; border-radius:11px; background:#fbfcff; }.permission-group header { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:10px; }.permission-group header b,.permission-group header small { display:block; }.permission-group header b { color:#344967; font-size:13px; }.permission-group header small { margin-top:3px; color:#9aa8ba; font-size:10px; }.permission-options { display:flex; flex-wrap:wrap; gap:8px 16px; }.position-editor-card>footer { display:flex; align-items:center; justify-content:space-between; gap:15px; padding:14px 22px; border-top:1px solid #edf1f6; color:#8796aa; font-size:11px; }@media(max-width:900px){.position-layout{grid-template-columns:1fr}.position-list-card{min-height:auto}.position-editor-card{min-height:0}.permission-groups{grid-template-columns:1fr}} 
</style>
