import {createApp} from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import StoreOperations from './views/StoreOperations.vue'
createApp(StoreOperations).use(ElementPlus).mount('#app')
