<template>
  <view class="detail-page" v-if="issue">
    <!-- 事项信息 -->
    <view class="head">
      <view class="mp-between head-top">
        <text class="issue-no">{{ issue.issue_no }}</text>
        <text class="mp-chip" :class="statusStyle(issue.status_display).cls">{{ issue.status_display }}</text>
      </view>
      <view class="title">{{ issue.title }}</view>
      <view class="desc" v-if="issue.description">{{ issue.description }}</view>

      <view class="metas">
        <view class="meta-row">
          <text class="meta-k">发起人</text>
          <text class="meta-v">{{ issue.created_by_name || '—' }}</text>
        </view>
        <view class="meta-row">
          <text class="meta-k">参与人</text>
          <text class="meta-v">{{ issue.participants_name.length ? issue.participants_name.join('、') : '—' }}</text>
        </view>
        <view class="meta-row">
          <text class="meta-k">开始时间</text>
          <text class="meta-v">{{ issue.start_time || '—' }}</text>
        </view>
        <view class="meta-row">
          <text class="meta-k">截止日期</text>
          <text class="meta-v" :class="{ 'meta-v--over': issue.overdue }">
            {{ issue.deadline || '—' }}{{ issue.overdue ? '（已逾期）' : '' }}
          </text>
        </view>
        <view class="meta-row" v-if="issue.completed_at">
          <text class="meta-k">完成时间</text>
          <text class="meta-v">{{ issue.completed_at }}</text>
        </view>
      </view>

      <view v-if="canDelete" class="revoke" @tap="revoke">撤销该事项</view>
    </view>

    <!-- 跟进时间线 -->
    <view class="timeline-title">
      <text>跟进记录</text>
      <text class="mp-muted">{{ replies.length }} 条</text>
    </view>

    <view class="timeline">
      <view v-for="(r, idx) in replies" :key="r.id" class="tl-item">
        <view class="tl-left">
          <view class="avatar">{{ (r.user_name || '?').slice(0, 1) }}</view>
          <view v-if="idx !== replies.length - 1" class="tl-line"></view>
        </view>
        <view class="tl-body">
          <view class="mp-between">
            <text class="tl-name">{{ r.user_name || '—' }}</text>
            <text class="mp-muted">{{ r.created_at }}</text>
          </view>
          <view class="tl-content" :class="{ 'tl-content--sys': isSys(r.content) }">{{ r.content }}</view>
          <view v-if="r.images && r.images.length" class="tl-imgs">
            <image
              v-for="(img, i) in r.images"
              :key="i"
              class="tl-img"
              :src="img"
              mode="aspectFill"
              @tap="preview(r.images, i)"
            />
          </view>
        </view>
      </view>

      <view v-if="!replies.length" class="mp-empty">还没有跟进记录</view>
    </view>

    <!-- 推进操作 -->
    <view v-if="issue.can_advance" class="advance-bar">
      <view class="advance-btn" @tap="openAdvance">推进事项状态</view>
    </view>

    <!-- 底部回复栏 -->
    <view class="reply-bar">
      <template v-if="canReply">
        <view class="reply-imgs" v-if="pending.length">
          <view v-for="(p, i) in pending" :key="i" class="reply-img-wrap">
            <image class="reply-img" :src="p.local" mode="aspectFill" @tap="previewLocal(i)" />
            <view class="reply-img-del" @tap="removeImage(i)">✕</view>
          </view>
        </view>
        <view class="reply-input-row">
          <textarea
            v-model="content"
            class="reply-input"
            :maxlength="500"
            auto-height
            :adjust-position="true"
            placeholder="填写跟进情况…"
            placeholder-class="ph"
          />
          <view class="reply-add" @tap="chooseImage">📷</view>
          <view class="reply-send" :class="{ 'reply-send--off': !content.trim() && !pending.length }" @tap="sendReply">
            发送
          </view>
        </view>
      </template>
      <view v-else class="reply-closed">
        {{ issue.status === '已完成' ? '事项已完成，不可再回复' : '事项已关闭（未完成），不可再回复' }}
      </view>
    </view>

    <!-- 推进弹层 -->
    <view v-if="advanceShow" class="mask" @tap="advanceShow = false">
      <view class="sheet" @tap.stop>
        <view class="sheet-title">推进到下一步</view>
        <view class="sheet-tip">状态流转不可逆：{{ issue.status }} →
          {{ issue.next_status.join(' / ') }}
        </view>
        <view class="status-picker">
          <view
            v-for="s in issue.next_status"
            :key="s"
            class="status-opt"
            :class="{ 'status-opt--on': advanceStatus === s }"
            @tap="advanceStatus = s"
          >{{ s }}</view>
        </view>
        <textarea
          v-model="advanceNote"
          class="sheet-note"
          :maxlength="200"
          placeholder="推进说明（必填，例如：已安排店长整改）"
          placeholder-class="ph"
        />
        <view class="sheet-actions">
          <view class="mp-btn mp-btn--ghost sheet-cancel" @tap="advanceShow = false">取消</view>
          <view class="mp-btn mp-btn--primary sheet-ok" :class="{ 'mp-btn--disabled': !advanceNote.trim() || !advanceStatus }" @tap="doAdvance">
            确认推进
          </view>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import api from '../../common/api'
import { uploadImage } from '../../common/request'
import { store } from '../../common/store'
import { statusStyle } from '../../common/config'

const id = ref(0)
const issue = ref(null)
const replies = ref([])
const content = ref('')
const pending = ref([])        // [{ local, url }]
const advanceShow = ref(false)
const advanceStatus = ref('')
const advanceNote = ref('')
const sending = ref(false)

const canReply = computed(() => issue.value && ['待开始', '进行中'].includes(issue.value.status))
const canDelete = computed(() => issue.value && issue.value.status === '待开始' && issue.value.created_by === store.user?.id)

onLoad((options) => {
  id.value = Number(options.id || 0)
  if (id.value) load()
})

async function load() {
  try {
    const res = await api.issueDetail(id.value)
    issue.value = res.issue
    replies.value = res.replies || []
    uni.setNavigationBarTitle({ title: res.issue.title })
  } catch (e) {
    setTimeout(() => uni.navigateBack(), 800)
  }
}

function isSys(text) {
  return String(text || '').startsWith('状态更新：')
}

function preview(urls, current) {
  uni.previewImage({ urls, current })
}

function previewLocal(i) {
  uni.previewImage({ urls: pending.value.map(p => p.local), current: i })
}

function chooseImage() {
  const remain = 3 - pending.value.length
  if (remain <= 0) {
    uni.showToast({ title: '最多 3 张图片', icon: 'none' })
    return
  }
  uni.chooseMedia({
    count: remain,
    mediaType: ['image'],
    sizeType: ['compressed'],
    sourceType: ['camera', 'album'],
    success: async (res) => {
      uni.showLoading({ title: '上传中' })
      try {
        for (const f of res.tempFiles) {
          if (f.size > 4 * 1024 * 1024) {
            uni.showToast({ title: '单张图片不能超过 4MB', icon: 'none' })
            continue
          }
          const url = await uploadImage(f.tempFilePath)
          pending.value.push({ local: f.tempFilePath, url })
        }
      } catch (e) {
        uni.showToast({ title: e.message || '上传失败', icon: 'none' })
      } finally {
        uni.hideLoading()
      }
    },
  })
}

function removeImage(i) {
  pending.value.splice(i, 1)
}

async function sendReply() {
  if (sending.value) return
  if (!content.value.trim() && !pending.value.length) {
    uni.showToast({ title: '请填写跟进内容', icon: 'none' })
    return
  }
  sending.value = true
  try {
    await api.issueReply(id.value, content.value.trim(), pending.value.map(p => p.url))
    content.value = ''
    pending.value = []
    uni.showToast({ title: '已提交', icon: 'success' })
    load()
  } catch (e) {
    // 已在 request 层提示
  } finally {
    sending.value = false
  }
}

function openAdvance() {
  advanceStatus.value = (issue.value.next_status || [])[0] || ''
  advanceNote.value = ''
  advanceShow.value = true
}

async function doAdvance() {
  if (!advanceStatus.value || !advanceNote.value.trim()) {
    uni.showToast({ title: '请选择状态并填写说明', icon: 'none' })
    return
  }
  try {
    await api.issueAdvance(id.value, advanceStatus.value, advanceNote.value.trim())
    advanceShow.value = false
    uni.showToast({ title: '已推进', icon: 'success' })
    load()
  } catch (e) {
    // 已在 request 层提示
  }
}

function revoke() {
  uni.showModal({
    title: '撤销事项',
    content: '仅「待开始」状态可撤销，撤销后不可恢复，确认继续？',
    success: async (r) => {
      if (!r.confirm) return
      try {
        await api.issueDelete(id.value)
        uni.showToast({ title: '已撤销', icon: 'success' })
        setTimeout(() => uni.navigateBack(), 600)
      } catch (e) { /* 已提示 */ }
    },
  })
}
</script>

<style scoped>
.detail-page {
  min-height: 100vh;
  padding-bottom: 260rpx;
}

.head {
  background: #fff;
  padding: 32rpx 28rpx;
  margin-bottom: 20rpx;
}
.head-top { margin-bottom: 16rpx; }
.issue-no {
  font-size: 22rpx;
  color: var(--text-3);
  font-family: Menlo, Consolas, monospace;
}
.title {
  font-size: 38rpx;
  font-weight: 700;
  line-height: 1.4;
  margin-bottom: 14rpx;
}
.desc {
  font-size: 28rpx;
  color: var(--text-2);
  line-height: 1.7;
  padding: 20rpx;
  background: #f7f8fa;
  border-radius: 14rpx;
  margin-bottom: 20rpx;
}
.metas {
  border-top: 2rpx solid var(--line);
  padding-top: 16rpx;
}
.meta-row {
  display: flex;
  padding: 12rpx 0;
  font-size: 26rpx;
}
.meta-k {
  width: 150rpx;
  color: var(--text-3);
  flex-shrink: 0;
}
.meta-v {
  flex: 1;
  color: var(--text-1);
  word-break: break-all;
}
.meta-v--over { color: #f53f3f; font-weight: 600; }

.revoke {
  margin-top: 20rpx;
  text-align: center;
  height: 72rpx;
  line-height: 72rpx;
  border-radius: 14rpx;
  background: #fff5f5;
  color: #f53f3f;
  font-size: 26rpx;
}

.timeline-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8rpx 32rpx 16rpx;
  font-size: 28rpx;
  font-weight: 600;
}

.timeline {
  background: #fff;
  margin: 0 24rpx;
  border-radius: 20rpx;
  padding: 28rpx 28rpx 8rpx;
}
.tl-item {
  display: flex;
}
.tl-left {
  width: 72rpx;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.avatar {
  width: 64rpx;
  height: 64rpx;
  border-radius: 50%;
  background: var(--brand-soft);
  color: var(--brand);
  font-size: 26rpx;
  line-height: 64rpx;
  text-align: center;
  font-weight: 600;
}
.tl-line {
  flex: 1;
  width: 2rpx;
  background: var(--line);
  margin: 8rpx 0;
}
.tl-body {
  flex: 1;
  padding-bottom: 32rpx;
}
.tl-name {
  font-size: 26rpx;
  font-weight: 600;
}
.tl-content {
  margin-top: 8rpx;
  font-size: 28rpx;
  line-height: 1.6;
  color: var(--text-1);
  white-space: pre-wrap;
  word-break: break-all;
}
.tl-content--sys {
  color: #b8752a;
  background: #fffdf8;
  border-left: 6rpx solid #ffd9a8;
  padding: 12rpx 18rpx;
  border-radius: 8rpx;
  font-size: 25rpx;
}
.tl-imgs {
  display: flex;
  flex-wrap: wrap;
  gap: 12rpx;
  margin-top: 14rpx;
}
.tl-img {
  width: 180rpx;
  height: 180rpx;
  border-radius: 12rpx;
  background: #f2f3f5;
}

.advance-bar {
  padding: 28rpx 24rpx 0;
}
.advance-btn {
  height: 88rpx;
  line-height: 88rpx;
  text-align: center;
  border-radius: 16rpx;
  background: #fff;
  border: 2rpx solid var(--brand);
  color: var(--brand);
  font-size: 30rpx;
  font-weight: 500;
}

.reply-bar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  background: #fff;
  border-top: 2rpx solid var(--line);
  padding: 16rpx 24rpx calc(16rpx + env(safe-area-inset-bottom));
  z-index: 30;
}
.reply-input-row {
  display: flex;
  align-items: flex-end;
  gap: 16rpx;
}
.reply-input {
  flex: 1;
  min-height: 72rpx;
  max-height: 200rpx;
  background: #f7f8fa;
  border-radius: 14rpx;
  padding: 18rpx 24rpx;
  font-size: 28rpx;
}
.ph { color: #c9cdd4; }
.reply-add {
  width: 72rpx;
  height: 72rpx;
  line-height: 72rpx;
  text-align: center;
  font-size: 36rpx;
  background: #f7f8fa;
  border-radius: 14rpx;
}
.reply-send {
  height: 72rpx;
  padding: 0 32rpx;
  line-height: 72rpx;
  border-radius: 14rpx;
  background: var(--brand);
  color: #fff;
  font-size: 28rpx;
}
.reply-send--off { opacity: 0.45; }
.reply-imgs {
  display: flex;
  gap: 12rpx;
  padding-bottom: 16rpx;
}
.reply-img-wrap { position: relative; }
.reply-img {
  width: 130rpx;
  height: 130rpx;
  border-radius: 12rpx;
  background: #f2f3f5;
}
.reply-img-del {
  position: absolute;
  right: -8rpx;
  top: -8rpx;
  width: 40rpx;
  height: 40rpx;
  line-height: 38rpx;
  text-align: center;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 22rpx;
}
.reply-closed {
  text-align: center;
  color: var(--text-3);
  font-size: 26rpx;
  padding: 24rpx 0;
}

.mask {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 50;
  display: flex;
  align-items: flex-end;
}
.sheet {
  width: 100%;
  background: #fff;
  border-radius: 28rpx 28rpx 0 0;
  padding: 36rpx 32rpx calc(36rpx + env(safe-area-inset-bottom));
}
.sheet-title {
  font-size: 34rpx;
  font-weight: 700;
  margin-bottom: 10rpx;
}
.sheet-tip {
  font-size: 24rpx;
  color: var(--text-3);
  margin-bottom: 28rpx;
}
.status-picker {
  display: flex;
  gap: 20rpx;
  margin-bottom: 28rpx;
}
.status-opt {
  flex: 1;
  height: 84rpx;
  line-height: 84rpx;
  text-align: center;
  border-radius: 14rpx;
  background: #f7f8fa;
  color: var(--text-2);
  font-size: 28rpx;
  border: 2rpx solid transparent;
}
.status-opt--on {
  background: var(--brand-soft);
  border-color: var(--brand);
  color: var(--brand);
  font-weight: 600;
}
.sheet-note {
  width: 100%;
  height: 160rpx;
  background: #f7f8fa;
  border-radius: 14rpx;
  padding: 20rpx 24rpx;
  font-size: 28rpx;
  box-sizing: border-box;
  margin-bottom: 28rpx;
}
.sheet-actions {
  display: flex;
  gap: 20rpx;
}
.sheet-cancel { flex: 1; }
.sheet-ok { flex: 2; }
</style>
