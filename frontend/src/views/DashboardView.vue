<template>
  <div class="dashboard-page">
    <!-- 统计卡片 -->
    <div class="dash-stat-grid">
      <div class="dash-stat-card">
        <div class="dash-stat-icon" style="background:#e8f4ff;"><el-icon size="22"><Shop /></el-icon></div>
        <div class="dash-stat-body">
          <div class="dash-stat-value primary">{{ stats.storeCount ?? '—' }}</div>
          <div class="dash-stat-label">门店总数</div>
        </div>
      </div>
      <div class="dash-stat-card">
        <div class="dash-stat-icon" style="background:#e8f8e8;"><el-icon size="22"><CircleCheck /></el-icon></div>
        <div class="dash-stat-body">
          <div class="dash-stat-value success">{{ stats.activeStores ?? '—' }}</div>
          <div class="dash-stat-label">正常营业</div>
        </div>
      </div>
      <div class="dash-stat-card">
        <div class="dash-stat-icon" style="background:#e8f4ff;"><el-icon size="22"><User /></el-icon></div>
        <div class="dash-stat-body">
          <div class="dash-stat-value primary">{{ stats.employeeCount ?? '—' }}</div>
          <div class="dash-stat-label">在职员工</div>
        </div>
      </div>
      <div class="dash-stat-card">
        <div class="dash-stat-icon" style="background:#fff7e8;"><el-icon size="22"><DishDot /></el-icon></div>
        <div class="dash-stat-body">
          <div class="dash-stat-value warning">{{ stats.menuCount ?? '—' }}</div>
          <div class="dash-stat-label">在售菜品</div>
        </div>
      </div>
    </div>

    <!-- 状态卡片 -->
    <div class="dash-stat-grid">
      <div class="dash-stat-card">
        <div class="dash-stat-icon" :style="{ background: apiConfigured ? '#e8f8e8' : '#fff7e8' }">
          <el-icon size="22"><Link /></el-icon>
        </div>
        <div class="dash-stat-body">
          <div class="dash-stat-value" :class="apiConfigured ? 'success' : 'warning'">{{ apiConfigured ? '已配置' : '未配置' }}</div>
          <div class="dash-stat-label">API 状态</div>
        </div>
      </div>
      <div class="dash-stat-card">
        <div class="dash-stat-icon" :style="{ background: webhookConfigured ? '#e8f8e8' : '#fff7e8' }">
          <el-icon size="22"><ChatDotRound /></el-icon>
        </div>
        <div class="dash-stat-body">
          <div class="dash-stat-value" :class="webhookConfigured ? 'success' : 'warning'">{{ webhookConfigured ? '已配置' : '未配置' }}</div>
          <div class="dash-stat-label">Webhook</div>
        </div>
      </div>
      <div class="dash-stat-card">
        <div class="dash-stat-icon" style="background:#e8f8e8;"><el-icon size="22"><Upload /></el-icon></div>
        <div class="dash-stat-body">
          <div class="dash-stat-value success">{{ stats.pushSuccess ?? 0 }}/{{ stats.pushTotal ?? 0 }}</div>
          <div class="dash-stat-label">推送成功率</div>
        </div>
      </div>
      <div class="dash-stat-card">
        <div class="dash-stat-icon" :style="{ background: store.serverOnline ? '#e8f8e8' : '#fff0f0' }">
          <el-icon size="22"><Monitor /></el-icon>
        </div>
        <div class="dash-stat-body">
          <div class="dash-stat-value" :class="store.serverOnline ? 'success' : 'danger'">{{ store.serverOnline ? '在线' : '离线' }}</div>
          <div class="dash-stat-label">后端状态</div>
        </div>
      </div>
    </div>

    <!-- 快速操作 -->
    <div class="dash-section-title">快速操作</div>
    <div class="dash-action-grid">
      <div class="dash-action-card" @click="store.openTabFromId('api-config')">
        <div class="dash-action-icon"><el-icon size="26"><Link /></el-icon></div>
        <span class="dash-action-text">中控绑定</span>
      </div>
      <div class="dash-action-card" @click="store.openTabFromId('store-management-info-basic')">
        <div class="dash-action-icon"><el-icon size="26"><Shop /></el-icon></div>
        <span class="dash-action-text">门店管理</span>
      </div>
      <div class="dash-action-card" @click="store.openTabFromId('pipeline')">
        <div class="dash-action-icon"><el-icon size="26"><Upload /></el-icon></div>
        <span class="dash-action-text">一键推送</span>
      </div>
      <div class="dash-action-card" @click="store.openTabFromId('cost-accounting-daily')">
        <div class="dash-action-icon"><el-icon size="26"><Money /></el-icon></div>
        <span class="dash-action-text">成本核算</span>
      </div>
      <div class="dash-action-card" @click="store.openTabFromId('data-import')">
        <div class="dash-action-icon"><el-icon size="26"><Download /></el-icon></div>
        <span class="dash-action-text">数据导入</span>
      </div>
      <div class="dash-action-card" @click="store.openTabFromId('ai-assistant')">
        <div class="dash-action-icon"><el-icon size="26"><ChatDotRound /></el-icon></div>
        <span class="dash-action-text">AI 助手</span>
      </div>
      <div class="dash-action-card" @click="store.openTabFromId('analysis-revenue')">
        <div class="dash-action-icon"><el-icon size="26"><TrendCharts /></el-icon></div>
        <span class="dash-action-text">营收分析</span>
      </div>
      <div class="dash-action-card" @click="store.openTabFromId('user-management')">
        <div class="dash-action-icon"><el-icon size="26"><User /></el-icon></div>
        <span class="dash-action-text">人员管理</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useAppStore } from '@/stores/app'
import { getDashboardStats, getConfig } from '@/api'

const store = useAppStore()
const stats = ref({})
const apiConfigured = ref(false)
const webhookConfigured = ref(false)

onMounted(async () => {
  try {
    const [s, cfg] = await Promise.allSettled([getDashboardStats(), getConfig()])
    if (s.status === 'fulfilled') stats.value = s.value.stats || {}
    if (cfg.status === 'fulfilled') {
      apiConfigured.value = cfg.value.configured
      webhookConfigured.value = cfg.value.webhookConfigured
    }
  } catch {}
})
</script>

<style scoped>
.dashboard-page {
  max-width: 1200px;
}

/* 统计卡片网格 */
.dash-stat-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin-bottom: 20px;
}

@media (max-width: 1100px) {
  .dash-stat-grid { grid-template-columns: repeat(2, 1fr); }
}

.dash-stat-card {
  background: #fff;
  border-radius: 10px;
  padding: 18px 16px;
  box-shadow: 0 2px 12px rgba(0,0,0,0.06);
  display: flex;
  align-items: center;
  gap: 14px;
  transition: box-shadow 0.2s, transform 0.2s;
}

.dash-stat-card:hover {
  box-shadow: 0 4px 16px rgba(0,0,0,0.1);
  transform: translateY(-2px);
}

.dash-stat-icon {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: #409EFF;
}

.dash-stat-icon :deep(.el-icon) {
  color: inherit;
}

.dash-stat-icon[style*="e8f8e8"] { color: #67C23A; }
.dash-stat-icon[style*="fff7e8"] { color: #E6A23C; }
.dash-stat-icon[style*="fff0f0"] { color: #F56C6C; }

.dash-stat-body {
  min-width: 0;
}

.dash-stat-value {
  font-size: 26px;
  font-weight: 700;
  color: #303133;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dash-stat-value.primary { color: #409EFF; }
.dash-stat-value.success { color: #67C23A; }
.dash-stat-value.warning { color: #E6A23C; }
.dash-stat-value.danger  { color: #F56C6C; }

.dash-stat-label {
  font-size: 13px;
  color: #909399;
  margin-top: 4px;
}

/* 分区标题 */
.dash-section-title {
  font-size: 15px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 16px;
}

/* 快速操作网格 */
.dash-action-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
}

@media (max-width: 1100px) {
  .dash-action-grid { grid-template-columns: repeat(4, 1fr); }
}

.dash-action-card {
  background: #fff;
  border-radius: 10px;
  padding: 20px 12px;
  box-shadow: 0 2px 12px rgba(0,0,0,0.06);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  transition: box-shadow 0.2s, transform 0.2s;
  user-select: none;
}

.dash-action-card:hover {
  box-shadow: 0 6px 20px rgba(64,158,255,0.15);
  transform: translateY(-3px);
}

.dash-action-icon {
  width: 50px;
  height: 50px;
  border-radius: 12px;
  background: #ecf5ff;
  color: #409EFF;
  display: flex;
  align-items: center;
  justify-content: center;
}

.dash-action-text {
  font-size: 13px;
  color: #606266;
  font-weight: 500;
}
</style>
