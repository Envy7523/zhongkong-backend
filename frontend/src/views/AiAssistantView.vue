<template>
  <div>
    <div class="card-compact">
      <div class="card-header">🤖 AI问答</div>
      <el-alert type="info" :closable="false" style="margin-bottom:16px;">
        输入问题，AI 助手将根据门店经营数据为您提供分析建议。
      </el-alert>
      <el-input v-model="question" type="textarea" :rows="3" placeholder="例如：哪个门店的利润率最高？" />
      <el-button type="primary" @click="ask" style="margin-top:12px;" :loading="asking">💬 提问</el-button>
      <div v-if="result" style="margin-top:12px;">
        <el-alert type="success" :closable="false">{{ result }}</el-alert>
      </div>
    </div>
    <div class="card-compact">
      <div class="card-header">📷 AI识别门店烤制</div>
      <el-alert type="info" :closable="false" style="margin-bottom:16px;">
        此功能将通过摄像头或上传图片，自动识别烤制品的成熟度和品质。开发中，敬请期待。
      </el-alert>
      <el-upload :auto-upload="false" accept="image/*" disabled>
        <el-button disabled>🔍 开始识别</el-button>
      </el-upload>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'

const question = ref('')
const asking = ref(false)
const result = ref('')

function ask() {
  if (!question.value) return
  asking.value = true
  setTimeout(() => {
    result.value = `🤖 AI助手正在积极学习中，此功能即将开放。您的问题:「${question.value}」已收到。`
    asking.value = false
  }, 500)
}
</script>
