// 仅由 tools/store-tasks-preview.js 的本地 Vite 服务提供，不加入生产构建入口。
import {createApp,h,ref} from 'vue'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/dist/locale/zh-cn.mjs'
import 'element-plus/dist/index.css'
import StoreTasks from './views/StoreTasks.vue'
const roles=[['admin','管理员'],['a','方州店 · 店员 A'],['b','方州店 · 店员 B'],['reviewer','方州店 · 审核人']]
const stored=localStorage.getItem('etaigong_token'), selected=ref(roles.some(r=>'preview-'+r[0]===stored)?stored:'preview-admin')
localStorage.setItem('etaigong_token',selected.value)
const Root={setup(){return()=>h('div',[
 h('div',{style:'background:#fff4e5;border-bottom:1px solid #efddc4;padding:14px 24px;display:flex;align-items:center;gap:20px;flex-wrap:wrap'},[
 h('strong','本地功能检查 · 独立测试数据'),h('span','切换身份体验共同执行和审核'),
 h('select',{value:selected.value,style:'padding:8px;border:1px solid #dcc7ab;border-radius:6px',onChange:e=>{localStorage.setItem('etaigong_token',e.target.value);location.reload()}},roles.map(([key,label])=>h('option',{value:'preview-'+key},label))),
 h('small','不会修改生产数据，上传照片仅保存在本机测试目录')]),h(StoreTasks)])}}
createApp(Root).use(ElementPlus,{locale:zhCn}).mount('#app')
document.body.style='margin:0;background:#f5f7fa;font-family:system-ui,sans-serif'
