<template>
  <div>
    <div class="card-compact">
      <div class="card-header">📥 日报数据导入</div>
      <el-alert type="info" :closable="false" style="margin-bottom:16px;">
        选择 Excel 日报文件（.xlsx/.xls），将门店经营数据导入到数据库中。
      </el-alert>
      <el-space>
        <el-upload :auto-upload="false" :on-change="handleFile" accept=".xlsx,.xls" :limit="1">
          <el-button type="primary">📤 选择日报文件</el-button>
        </el-upload>
        <el-button type="success" @click="importFile" :loading="importing" :disabled="!fileData">导入日报</el-button>
      </el-space>
      <div v-if="importResult.text" style="margin-top:12px;">
        <el-alert :type="importResult.type" :closable="false">{{ importResult.text }}</el-alert>
      </div>
    </div>

    <div class="card-compact">
      <div class="card-header">📋 耗材数据录入</div>
      <el-form label-width="100px" style="max-width:600px;">
        <el-form-item label="门店">
          <el-select v-model="supplyForm.storeId" placeholder="选择门店" style="width:100%;">
            <el-option v-for="s in stores" :key="s.id" :label="s.store_name" :value="s.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="日期">
          <el-date-picker v-model="supplyForm.date" type="date" style="width:100%;" />
        </el-form-item>
        <el-form-item label="耗材名称">
          <el-input v-model="supplyForm.item" placeholder="如：打包盒、竹签" />
        </el-form-item>
        <el-row :gutter="12" style="width:100%;">
          <el-col :span="8">
            <el-form-item label="数量">
              <el-input-number v-model="supplyForm.qty" :min="0" :step="0.1" style="width:100%;" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="单位">
              <el-input v-model="supplyForm.unit" placeholder="个" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="单价">
              <el-input-number v-model="supplyForm.price" :min="0" :step="0.01" :precision="2" style="width:100%;" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item>
          <el-button type="primary" @click="addSupplyItem" :loading="addingSupply">➕ 记录耗材</el-button>
        </el-form-item>
      </el-form>
      <div v-if="supplyResult.text" style="margin-top:12px;">
        <el-alert :type="supplyResult.type" :closable="false">{{ supplyResult.text }}</el-alert>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { getStores, importDailyReport, addSupply } from '@/api'

const fileData = ref(null)
const importing = ref(false)
const importResult = reactive({ type: 'info', text: '' })

const stores = ref([])
const supplyForm = reactive({ storeId: null, date: new Date(), item: '', qty: 1, unit: '个', price: 0 })
const addingSupply = ref(false)
const supplyResult = reactive({ type: 'info', text: '' })

onMounted(async () => {
  try {
    const data = await getStores({ page: 1, page_size: 200 })
    stores.value = data.stores || []
  } catch {}
})

function handleFile(file) {
  fileData.value = file.raw
}

async function importFile() {
  if (!fileData.value) return
  importing.value = true
  importResult.text = '⏳ 正在导入...'; importResult.type = 'info'
  try {
    const reader = new FileReader()
    reader.onload = async (e) => {
      const b64 = e.target.result.split(',')[1]
      const data = await importDailyReport({ data: b64 })
      importResult.type = 'success'; importResult.text = '✅ ' + data.message
      fileData.value = null
    }
    reader.readAsDataURL(fileData.value)
  } catch (e) {
    importResult.type = 'error'; importResult.text = '导入失败：' + e.message
  } finally { importing.value = false }
}

async function addSupplyItem() {
  if (!supplyForm.item) { supplyResult.type = 'error'; supplyResult.text = '请输入耗材名称'; return }
  addingSupply.value = true
  try {
    const store = stores.value.find(s => s.id === supplyForm.storeId)
    await addSupply({
      store_id: supplyForm.storeId,
      store_name: store?.store_name || '',
      date: supplyForm.date instanceof Date ? supplyForm.date.toISOString().slice(0, 10) : supplyForm.date,
      item: supplyForm.item,
      quantity: supplyForm.qty,
      unit: supplyForm.unit,
      unit_price: supplyForm.price,
    })
    supplyResult.type = 'success'
    supplyResult.text = `✅ 已记录: ${supplyForm.item} ×${supplyForm.qty}${supplyForm.unit} ¥${(supplyForm.qty * supplyForm.price).toFixed(2)}`
    supplyForm.item = ''
  } catch (e) {
    supplyResult.type = 'error'; supplyResult.text = '记录失败：' + e.message
  } finally { addingSupply.value = false }
}
</script>
