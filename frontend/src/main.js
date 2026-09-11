import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/dist/locale/zh-cn.mjs'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import 'element-plus/dist/index.css'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
// 统一一周从周一开始：type="week" 的周起始由 dayjs locale 的 firstDayOfWeek 决定
dayjs.locale('zh-cn')

import App from './App.vue'
import router from './router'
import './style.css'
import './styles/enterprise.css'

const app = createApp(App)

// 注册 Element Plus 图标
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

app.use(createPinia())
app.use(router)
app.use(ElementPlus, { locale: zhCn })
app.mount('#app')
