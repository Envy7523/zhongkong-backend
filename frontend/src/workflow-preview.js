import {createApp} from 'vue'
import {createPinia} from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import Workflows from './views/Workflows.vue'
import {useAuthStore} from './stores/auth'
const app=createApp(Workflows),pinia=createPinia();app.use(pinia);useAuthStore(pinia).user={position_permissions:['*']};app.use(ElementPlus).mount('#app')
