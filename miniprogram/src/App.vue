<script>
import { getToken, getUser } from './common/request'
import { store } from './common/store'

export default {
  onLaunch() {
    // 启动时把本地会话灌进内存态，页面里就能直接读 store
    const token = getToken()
    const user = getUser()
    if (token && user) {
      store.token = token
      store.user = user
    }
  },
}
</script>

<style>
/* ==================== 全局设计令牌 ==================== */
/* 主色取烧腊暖色系，与 PC 后台的蓝灰区分开，更贴近门店场景 */
page {
  --brand: #d94f2b;
  --brand-soft: #fdf0eb;
  --text-1: #1f2329;
  --text-2: #4e5969;
  --text-3: #86909c;
  --line: #e9ecf0;
  --bg: #f5f6f8;
  --card: #ffffff;
  --warn: #ff7d00;
  --danger: #f53f3f;
  --success: #00b42a;

  background-color: var(--bg);
  color: var(--text-1);
  font-size: 28rpx;
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Helvetica Neue', sans-serif;
  line-height: 1.5;
}

/* ==================== 通用原子类 ==================== */
.mp-card {
  background: var(--card);
  border-radius: 20rpx;
  padding: 28rpx;
  margin: 0 24rpx 24rpx;
  box-shadow: 0 2rpx 12rpx rgba(31, 35, 41, 0.04);
}

.mp-row {
  display: flex;
  align-items: center;
}

.mp-between {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.mp-muted {
  color: var(--text-3);
  font-size: 24rpx;
}

.mp-ellipsis {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 状态胶囊 */
.mp-chip {
  display: inline-flex;
  align-items: center;
  height: 40rpx;
  padding: 0 16rpx;
  border-radius: 999rpx;
  font-size: 22rpx;
  line-height: 1;
  flex-shrink: 0;
}

.mp-chip--pending { background: #f2f3f5; color: #86909c; }
.mp-chip--doing { background: #fff3e8; color: #ff7d00; }
.mp-chip--done { background: #e8ffea; color: #00b42a; }
.mp-chip--undone { background: #ffece8; color: #f53f3f; }

.mp-btn {
  height: 88rpx;
  border-radius: 16rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 30rpx;
  font-weight: 500;
}

.mp-btn--primary {
  background: var(--brand);
  color: #fff;
}

.mp-btn--ghost {
  background: #fff;
  color: var(--text-1);
  border: 2rpx solid var(--line);
}

.mp-btn--disabled {
  opacity: 0.5;
}

.mp-empty {
  padding: 160rpx 0;
  text-align: center;
  color: var(--text-3);
  font-size: 26rpx;
}
</style>
