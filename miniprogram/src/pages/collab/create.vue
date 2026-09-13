<template>
  <view class="create-page">
    <view class="form">
      <view class="field">
        <text class="label">事项标题 <text class="req">*</text></text>
        <input
          v-model="form.title"
          class="input"
          type="text"
          :maxlength="100"
          placeholder="例如：龙岗万科店后厨卫生整改"
          placeholder-class="ph"
        />
        <text class="counter">{{ form.title.length }}/100</text>
      </view>

      <view class="field">
        <text class="label">事项描述</text>
        <textarea
          v-model="form.description"
          class="textarea"
          :maxlength="500"
          placeholder="补充说明、验收标准等（选填）"
          placeholder-class="ph"
        />
      </view>

      <view class="field-row">
        <view class="field field--half">
          <text class="label">开始时间</text>
          <picker mode="date" :value="form.start_time" @change="e => form.start_time = e.detail.value">
            <view class="picker" :class="{ 'picker--empty': !form.start_time }">
              {{ form.start_time || '选择日期' }}
            </view>
          </picker>
        </view>
        <view class="field field--half">
          <text class="label">截止日期</text>
          <picker mode="date" :value="form.deadline" @change="e => form.deadline = e.detail.value">
            <view class="picker" :class="{ 'picker--empty': !form.deadline }">
              {{ form.deadline || '选择日期' }}
            </view>
          </picker>
        </view>
      </view>
      <view class="hint">开始时间留空则保持「待开始」，需要手动推进</view>

      <view class="field">
        <text class="label">参与人</text>
        <view class="users">
          <view
            v-for="u in users"
            :key="u.id"
            class="user"
            :class="{ 'user--on': form.participants.includes(u.id) }"
            @tap="toggleUser(u)"
          >
            <text class="user-name">{{ u.display_name || u.username }}</text>
            <text class="user-role">{{ u.role }}</text>
          </view>
          <view v-if="!users.length" class="mp-muted">暂无可选人员</view>
        </view>
      </view>
    </view>

    <view class="submit-wrap">
      <view class="mp-btn" :class="canSubmit ? 'mp-btn--primary' : 'mp-btn--primary mp-btn--disabled'" @tap="submit">
        {{ submitting ? '提交中…' : '发起事项' }}
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import api from '../../common/api'

const users = ref([])
const submitting = ref(false)
const form = reactive({
  title: '',
  description: '',
  start_time: '',
  deadline: '',
  participants: [],
  participants_name: [],
})

const canSubmit = computed(() => form.title.trim().length > 0 && !submitting.value)

onLoad(async () => {
  try {
    const res = await api.collabUsers()
    users.value = res.users || []
  } catch {}
})

function toggleUser(u) {
  const i = form.participants.indexOf(u.id)
  if (i >= 0) {
    form.participants.splice(i, 1)
    form.participants_name.splice(i, 1)
  } else {
    form.participants.push(u.id)
    form.participants_name.push(u.display_name || u.username)
  }
}

async function submit() {
  if (!canSubmit.value) {
    uni.showToast({ title: '请填写事项标题', icon: 'none' })
    return
  }
  if (form.start_time && form.deadline && form.deadline < form.start_time) {
    uni.showToast({ title: '截止日期不能早于开始时间', icon: 'none' })
    return
  }
  submitting.value = true
  try {
    const res = await api.issueCreate({
      title: form.title.trim(),
      description: form.description.trim(),
      start_time: form.start_time || null,
      deadline: form.deadline || null,
      participants: form.participants,
      participants_name: form.participants_name,
    })
    uni.showToast({ title: `已发起 ${res.issue.issue_no}`, icon: 'none' })
    setTimeout(() => uni.navigateBack(), 700)
  } catch (e) {
    // 已在 request 层提示
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.create-page {
  min-height: 100vh;
  padding-bottom: 200rpx;
}
.form {
  background: #fff;
  padding: 12rpx 28rpx 28rpx;
}
.field {
  padding: 24rpx 0;
  border-bottom: 2rpx solid var(--line);
}
.field-row {
  display: flex;
  gap: 28rpx;
}
.field--half {
  flex: 1;
  border-bottom: none;
}
.label {
  display: block;
  font-size: 26rpx;
  color: var(--text-2);
  margin-bottom: 14rpx;
}
.req { color: var(--brand); }
.input {
  height: 76rpx;
  font-size: 30rpx;
}
.textarea {
  width: 100%;
  height: 180rpx;
  font-size: 28rpx;
  line-height: 1.6;
  box-sizing: border-box;
}
.ph { color: #c9cdd4; font-size: 28rpx; }
.counter {
  display: block;
  text-align: right;
  font-size: 22rpx;
  color: var(--text-3);
  margin-top: 6rpx;
}
.picker {
  height: 76rpx;
  line-height: 76rpx;
  background: #f7f8fa;
  border-radius: 14rpx;
  padding: 0 24rpx;
  font-size: 28rpx;
}
.picker--empty { color: #c9cdd4; }
.hint {
  font-size: 22rpx;
  color: var(--text-3);
  padding: 12rpx 0 0;
}

.users {
  display: flex;
  flex-wrap: wrap;
  gap: 16rpx;
}
.user {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 14rpx 24rpx;
  border-radius: 14rpx;
  background: #f7f8fa;
  border: 2rpx solid transparent;
}
.user--on {
  background: var(--brand-soft);
  border-color: var(--brand);
}
.user-name {
  font-size: 26rpx;
  color: var(--text-1);
}
.user--on .user-name {
  color: var(--brand);
  font-weight: 600;
}
.user-role {
  font-size: 20rpx;
  color: var(--text-3);
  margin-top: 4rpx;
}

.submit-wrap {
  padding: 40rpx 28rpx;
}
</style>
