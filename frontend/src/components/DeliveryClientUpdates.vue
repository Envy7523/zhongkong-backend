<template>
 <el-card shadow="never">
  <template #header><div class="update-heading"><strong>采集电脑 · 软件更新</strong><el-button size="small" :loading="loading" @click="load">刷新设备</el-button></div></template>
  <el-alert v-if="error" :title="error" type="warning" :closable="false" show-icon />
  <el-table :data="devices" empty-text="暂无设备版本上报；旧版客户端需先安装升级组件">
   <el-table-column prop="name" label="电脑" min-width="140" />
   <el-table-column label="连接" width="90"><template #default="{row}"><el-tag :type="online(row)?'success':'info'">{{online(row)?'在线':'离线'}}</el-tag></template></el-table-column>
   <el-table-column label="当前版本" min-width="110"><template #default="{row}">{{row.state.version||'尚未上报'}}</template></el-table-column>
   <el-table-column label="扩展版本" min-width="110"><template #default="{row}">{{row.state.extensionVersion||'尚未上报'}}</template></el-table-column>
   <el-table-column label="更新结果" min-width="190"><template #default="{row}">{{labels[row.state.status]||'等待客户端上报'}}<span v-if="row.state.targetVersion"> → {{row.state.targetVersion}}</span><small v-if="row.state.error" class="update-error">{{row.state.error}}</small></template></el-table-column>
   <el-table-column label="更新通道" width="130"><template #default="{row}"><el-select :model-value="row.channel" :disabled="saving===row.id" size="small" @change="channel=>save(row,channel,!!row.paused)"><el-option label="正式版" value="stable"/><el-option label="测试版" value="test"/></el-select></template></el-table-column>
   <el-table-column label="自动更新" width="105"><template #default="{row}"><el-switch :model-value="!row.paused" :disabled="saving===row.id" @change="enabled=>save(row,row.channel,!enabled)"/></template></el-table-column>
  </el-table>
  <p class="update-note">每 15 分钟检查签名版本，采集与待上传任务结束后升级；启动或扩展连接检查失败会回退。新增扩展权限须人工确认。最新正式版：{{latest('stable')}}；测试版：{{latest('test')}}。</p>
 </el-card>
</template>
<script setup>
import {ref,onMounted} from 'vue'
import {deliveryClientUpdatesApi} from '@/api'
const devices=ref([]),releases=ref([]),loading=ref(false),error=ref(''),saving=ref('')
const labels={current:'已连接更新服务',applied:'升级成功',installing:'正在升级',rolled_back:'升级失败，已回退'}
const online=row=>row.last_seen&&Date.now()-Date.parse(row.last_seen)<300000
const latest=channel=>releases.value.find(r=>r.channel===channel)?.version||'尚未发布'
async function load(){loading.value=true;error.value='';try{const r=await deliveryClientUpdatesApi.get();devices.value=r.devices.map(d=>({...d,state:JSON.parse(d.status_json||'{}')}));releases.value=r.releases}catch(e){error.value=e.response?.data?.error||'设备更新状态暂不可用'}finally{loading.value=false}}
async function save(row,channel,paused){saving.value=row.id;try{await deliveryClientUpdatesApi.set(row.id,{channel,paused});await load()}catch(e){error.value=e.response?.data?.error||'更新设置未保存'}finally{saving.value=''}}
onMounted(load)
</script>
<style scoped>
.update-heading{display:flex;justify-content:space-between;align-items:center}.update-note{font-size:12px;color:var(--el-text-color-secondary);line-height:1.8;margin:12px 0 0}.update-error{display:block;color:var(--el-color-danger)}
</style>
