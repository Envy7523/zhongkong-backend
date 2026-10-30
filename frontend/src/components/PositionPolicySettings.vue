<template>
  <main class="policy-page" v-loading="loading">
    <header>
      <div><h1>岗位设置</h1><p>统一维护岗位，在同一岗位中分别配置网页端与小程序端权限。</p></div>
      <el-button type="primary" @click="edit()">新增岗位</el-button>
    </header>
    <div class="tools">
      <el-input v-model="q" clearable placeholder="搜索岗位" aria-label="搜索岗位" />
      <el-radio-group v-model="category" aria-label="岗位类型">
        <el-radio-button value="all">全部</el-radio-button>
        <el-radio-button value="group">集团岗位</el-radio-button>
        <el-radio-button value="store">门店岗位</el-radio-button>
      </el-radio-group>
      <el-button @click="load">刷新</el-button>
      <span class="position-count">共 {{ filtered.length }} 个岗位</span>
    </div>
    <el-table :data="filtered" row-key="id" empty-text="暂无岗位">
      <el-table-column prop="name" label="岗位名称" min-width="210" />
      <el-table-column label="类型" width="90"><template #default="{row}">{{ row.category === 'group' ? '集团' : '门店' }}</template></el-table-column>
      <el-table-column prop="member_count" label="成员" width="70" />
      <el-table-column v-for="c in ['web','mini']" :key="c" :label="c === 'web' ? '网页端权限' : '小程序端权限'" min-width="200">
        <template #default="{row}">
          <div class="platform-policy">
            <el-button link :type="row.channels.includes(c) ? 'primary' : 'info'" :aria-label="row.name + ' · ' + (c === 'web' ? '网页端权限' : '小程序端权限')" @click="edit(row,c)">{{ channelSummary(row,c) }}</el-button>
            <span v-if="row.channels.includes(c)" class="profile-summary">资料 {{ profileSummary(row,c) }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="岗位状态" min-width="150"><template #default="{row}"><el-tag :type="!row.enabled || !row.channels.length ? 'info' : row.channel_permissions ? 'success' : 'warning'">{{ !row.enabled ? '已停用' : !row.channels.length ? '未分配权限' : row.channel_permissions ? '已配置' : '原授权，待核对' }}</el-tag></template></el-table-column>
      <el-table-column label="操作" width="220"><template #default="{row}"><el-button link type="primary" @click="edit(row)">编辑</el-button><el-button link @click="copy(row)">复制</el-button><el-button v-if="!row.is_system" link type="danger" @click="remove(row)">删除</el-button></template></el-table-column>
    </el-table>
    <el-dialog v-model="editing" class="position-policy-dialog" top="6vh" title="岗位权限设置" width="min(1100px,96vw)" :close-on-click-modal="false">
      <div class="editor">
        <aside><el-form label-position="top">
          <el-form-item label="岗位名称" required><el-input v-model="form.name" maxlength="40" /></el-form-item>
          <el-form-item label="岗位类型"><el-radio-group v-model="form.category"><el-radio value="group">集团</el-radio><el-radio value="store">门店</el-radio></el-radio-group></el-form-item>
          <el-form-item label="生效端（自动）"><div class="channel-status" aria-live="polite"><el-checkbox :model-value="form.channels.includes('web')" disabled>网页端</el-checkbox><el-checkbox :model-value="form.channels.includes('mini')" disabled>小程序端</el-checkbox><span class="channel-hint">随右侧权限自动勾选，清空后自动关闭</span></div></el-form-item>
          <el-form-item label="岗位适用门店"><RoleScopeEditor v-model="form" :stores="data.stores" :regions="data.regions" /></el-form-item>
          <el-form-item label="说明"><el-input v-model="form.description" type="textarea" :rows="2" maxlength="200" /></el-form-item>
          <el-switch v-model="form.enabled" active-text="启用岗位" />
        </el-form></aside>
        <section>
          <p class="shared-role-hint">同一岗位的双端权限，统一保存。</p>
          <p class="permission-hint">员工资料统一按类别授权，查看、编辑、附件读取和导出分别配置，并受负责门店范围限制。查看实习店长敏感资料还需满足直属上级或人事、财务职责要求。</p>
          <el-tabs v-model="editChannel" @tab-change="sync"><el-tab-pane label="网页端权限" name="web" /><el-tab-pane label="小程序端权限" name="mini" /></el-tabs>
          <p v-if="!adminRole" class="permission-hint">直接勾选需要的权限，即可自动开启对应端。</p>
          <el-alert v-if="adminRole" title="系统管理员保留全部权限，普通成员请另建岗位。" :closable="false" />
          <div class="search"><el-input v-model="search" clearable placeholder="搜索功能、操作或资料类别" /><el-button text @click="expand(true)">展开</el-button><el-button text @click="expand(false)">收起</el-button><el-button text :disabled="adminRole || !form.channel_permissions[editChannel].length" @click="clearChannel">清空本端</el-button></div>
          <el-tree ref="tree" :data="nodes" node-key="id" show-checkbox :default-expanded-keys="nodes.map(n=>n.id)" :filter-node-method="filter" @check="checked"><template #default="{data:n}"><span>{{ n.label }}<small v-if="n.description">{{ n.description }}</small></span></template></el-tree>
          <p class="selection-summary" aria-live="polite">当前端已选 {{ form.channel_permissions[editChannel].length }} 项{{ form.channels.includes(editChannel) ? ' · 已自动开启' : ' · 未开启' }}；未授权字段由服务端隐藏。</p>
        </section>
      </div>
      <template #footer><el-button @click="editing=false">取消</el-button><el-button type="primary" :loading="saving" @click="save">保存岗位</el-button></template>
    </el-dialog>
  </main>
</template>
<script setup>
import { ref, reactive, computed, onMounted, nextTick, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { getPositions, createPosition, deletePosition, personnelAccessApi as api } from '@/api';
import RoleScopeEditor from './RoleScopeEditor.vue';
import { permissionTree, policyChannels, selectedPermissions } from '@/utils/position-policy-editor.mjs';

const data = reactive({ positions: [], stores: [], regions: [] });
const catalog = ref({ web: [], mini: [] }), positions = ref([]);
const category = ref('all'), q = ref('');
const loading = ref(false), saving = ref(false), editing = ref(false);
const editChannel = ref('web'), search = ref(''), tree = ref(null);
const form = ref({ channels: [], channel_permissions: { web: [], mini: [] } });
const adminRole = computed(() => form.value.is_system && form.value.channel_permissions.web.includes('*'));
const filtered = computed(() => positions.value.filter(p =>
  !p.merged_into &&
  p.name.includes(q.value.trim()) &&
  (category.value === 'all' || (p.category === 'mini' ? 'store' : p.category) === category.value)
));
const nodes = computed(() => permissionTree(catalog.value[editChannel.value], !!adminRole.value));
const keys = c => catalog.value[c].flatMap(g => g.modules.flatMap(m => m.items.map(p => p.key)));
const permissions = (p, c) => p.channel_permissions?.[c] || p.permissions || [];

function channelSummary(p, c) {
  if (!p.channels.includes(c)) return '未开放 · 配置';
  const ps = permissions(p, c);
  if (ps.includes('*')) return '全部权限';
  if (!p.channel_permissions) return '沿用原权限';
  return ps.length + ' 项权限';
}
function profileSummary(p, c) {
  const ps = permissions(p, c);
  if (ps.includes('*')) return '全部资料';
  const fields=ps.filter(code=>code.startsWith('staff.field.')&&code.endsWith('.view'));if(fields.length)return '按类别 · '+fields.length+' 类';
  return ps.some(code=>/^staff\.profile\.[ABCD]\./.test(code)) ? '历史授权，待迁移' : '未授权';
}
async function load() {
  loading.value = true;
  try {
    const [list, config, rights] = await Promise.all([getPositions(), api.config(), api.catalog()]);
    Object.assign(data, config);
    catalog.value = rights.channels;
    positions.value = list.positions.map(p => ({ ...p, ...config.positions.find(s => s.id === p.id) }));
  } catch (e) { ElMessage.error(e.message); }
  finally { loading.value = false; }
}
async function edit(p, requestedChannel) {
  form.value = p ? JSON.parse(JSON.stringify({
    ...p, category: p.category === 'mini' ? 'store' : p.category,
    channel_permissions: Object.fromEntries(['web', 'mini'].map(c => [c,
      p.channels.includes(c) ? permissions(p, c).filter(k => k === '*' || k === 'store-manager.identity' || keys(c).includes(k)) : [],
    ])),
  })) : {
    name: '', description: '', category: 'store', channels: [], mode: 'all',
    store_ids: [], region_ids: [], enabled: true, policy_version: 0,
    channel_permissions: { web: [], mini: [] },
  };
  updateChannels();
  editChannel.value = requestedChannel || p?.channels?.[0] || 'web';
  search.value = '';
  editing.value = true;
  await sync();
}
async function copy(p) {
  await edit(p);
  form.value.id = null;
  form.value.is_system = 0;
  form.value.policy_version = 0;
  form.value.name = p.name + '（副本）';
  for (const c of ['web', 'mini']) {
    if (form.value.channel_permissions[c].includes('*')) form.value.channel_permissions[c] = keys(c);
  }
  updateChannels();
  await sync();
}
async function sync() {
  await nextTick();
  const codes = form.value.channel_permissions[editChannel.value];
  tree.value?.setCheckedKeys((codes.includes('*') ? keys(editChannel.value) : codes).map(k => 'p/' + k));
  tree.value?.filter(search.value);
}
function updateChannels() {
  form.value.channels = policyChannels(form.value.channel_permissions);
}
function checked() {
  if (adminRole.value) return;
  const c = editChannel.value;
  const selected = tree.value.getCheckedKeys().filter(k => k.startsWith('p/')).map(k => k.slice(2));
  form.value.channel_permissions[c] = selectedPermissions(c, selected, form.value.channel_permissions[c]);
  updateChannels();
  sync();
}
function clearChannel() {
  if (adminRole.value) return;
  form.value.channel_permissions[editChannel.value] = [];
  updateChannels();
  sync();
}
function filter(v, n) { return !v || [n.label, n.description].join(' ').includes(v); }
watch(search, v => tree.value?.filter(v));
function expand(value) {
  function visit(nodes) {
    for (const n of nodes) {
      const node = tree.value?.getNode(n.id);
      if (node) node.expanded = value;
      if (n.children) visit(n.children);
    }
  }
  visit(nodes.value);
}
async function save() {
  if (saving.value) return;
  if (!form.value.name?.trim()) return ElMessage.warning('请填写岗位名称');
  updateChannels();
  saving.value = true;
  try {
    if (!form.value.id) {
      const p = await createPosition({ name: form.value.name, description: form.value.description, permissions: [] });
      form.value.id = p.position.id;
    }
    await api.policy(form.value.id, form.value);
    editing.value = false;
    await load();
    ElMessage.success('岗位及双端权限已保存');
  } catch (e) { ElMessage.error(e.message); }
  finally { saving.value = false; }
}
async function remove(p) {
  try {
    await ElMessageBox.confirm('确认删除岗位“' + p.name + '”？', '删除岗位', { type: 'warning' });
    await deletePosition(p.id);
    await load();
  } catch (e) { if (e !== 'cancel' && e !== 'close') ElMessage.error(e.message); }
}
onMounted(load);
</script>
<style scoped>.policy-page{padding:26px;background:#fff;border:1px solid #e5eaf0;border-radius:12px}header,.tools,.search{display:flex;align-items:center;gap:14px}header{justify-content:space-between;margin-bottom:22px}h1{font-size:23px;margin:0 0 8px}p{font-size:12px;color:#8996a3;line-height:1.8;margin:0}.tools{margin:18px 0 22px;flex-wrap:wrap}.tools>.el-input{max-width:280px}.editor{display:grid;grid-template-columns:300px minmax(0,1fr);gap:28px}.editor aside{border-right:1px solid #edf0f4;padding-right:24px}.editor section{min-width:0}.search{margin:14px 0}.search>.el-input{flex:1}.el-tree{min-height:260px;max-height:clamp(280px,44vh,480px);overflow:auto}.editor :deep(.el-tree-node__content){height:auto;min-height:36px;padding:5px 0}.editor small{display:block;color:#95a0ab;font-size:11px;line-height:1.5}.editor .selection-summary{border-top:1px solid #edf0f4;padding-top:14px;margin-top:14px}@media(max-width:800px){.editor{grid-template-columns:1fr}.editor aside{border:0;padding:0}}.position-policy-dialog :deep(.el-dialog__body){max-height:calc(88vh - 116px);overflow:auto}.channel-status{display:flex;flex-wrap:wrap;align-items:center;gap:0 24px}.channel-status .el-checkbox{margin-right:0}.channel-hint{display:block;width:100%;font-size:12px;line-height:1.7;color:#64748b}.channel-status :deep(.el-checkbox.is-disabled .el-checkbox__label){color:#475569}.channel-status :deep(.el-checkbox.is-disabled.is-checked .el-checkbox__label){color:#2563eb}.channel-status :deep(.el-checkbox__input.is-disabled.is-checked .el-checkbox__inner){background:#2563eb;border-color:#2563eb}.channel-status :deep(.el-checkbox__input.is-disabled.is-checked .el-checkbox__inner::after){border-color:#fff}.permission-hint{color:#64748b}.editor :deep(.el-tree-node__label){white-space:normal;line-height:1.6}.search{gap:6px}.search>.el-input{min-width:120px}@media(max-width:800px){.search{flex-wrap:wrap}.search>.el-input{flex-basis:100%}.editor :deep(.el-tree){max-height:420px}}.position-count{margin-left:auto;font-size:12px;color:var(--el-text-color-secondary);white-space:nowrap}.platform-policy{display:flex;flex-direction:column;align-items:flex-start;gap:5px;padding:5px 0}.platform-policy .el-button{min-height:28px;margin:0}.profile-summary{font-size:12px;line-height:1.6;color:var(--el-text-color-secondary)}.shared-role-hint{color:var(--el-text-color-regular);margin-bottom:4px}@media(max-width:800px){.tools{flex-wrap:wrap}.position-count{margin-left:0}}
</style>
