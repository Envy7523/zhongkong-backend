# 鹅太公中控后台 — CodeWhale 项目说明

## 项目概述
企业微信集成中控台 + 门店管理系统。前后端分离：Vue3+Vite 前端 + Node.js Express 后端。

## 启动方式
```bash
# 后端 (端口 3456)
node server.js

# 前端 (端口 5173, 代理 /api → 3456)
cd frontend && npx vite --host
```

## 技术栈
- 前端：Vue 3 + Element Plus + ECharts + Pinia + 高德地图 JS SDK v1.4.15
- 后端：Node.js + Express 5 + sql.js (SQLite)
- 数据库文件：`data/database.sqlite`

## 关键文件
| 文件 | 说明 |
|------|------|
| `server.js` | 后端全部 API（门店CRUD、地理编码代理、地图标点CRUD） |
| `lib/db.js` | SQLite 数据库（schema + 种子数据 + 查询接口） |
| `config.json` | 配置（企业微信凭据、高德 Web API key） |
| `frontend/src/views/store/StoreMap.vue` | **全国地图页面**（核心功能最密集的文件） |
| `frontend/src/views/store/StoreBasic.vue` | 门店基本信息（编辑经纬度 + 地理编码按钮） |
| `frontend/src/api/index.js` | 前端 API 封装 |
| `frontend/index.html` | 高德 JS SDK 加载（key: 95fc...） |

## 全国地图功能 (StoreMap.vue)
### 层级导航
- 全国 → 省 → 市（ECharts 地图，仅区域着色）
- 区（高德 2D 地图，显示门店标记 + 自定义标点）

### 门店标记
- 颜色：正常营业=绿色、筹建中=黄色、闭店=灰色
- 3km 半径商圈圆圈
- 始终显示门店名称
- 点击门店标记 → 弹窗编辑备注

### 自定义标点
- 按钮「📌 自定义标点」进入标点模式 → 鼠标变 crosshair
- 点击地图 → 自动创建「自定义点位N」(蓝色, 3000m半径) → 保存到 `map_pins` 表
- ESC / 右键 / 再点按钮 → 退出标点模式
- 点击自定义标记(+号圆点) → 弹窗编辑名称/备注/颜色/半径
- 右键自定义标记 → 确认删除
- 「🗑 清空所有标记」删除全部

### 工具栏
- 状态筛选：全部/正常营业/筹建中/已闭店迁址
- 标点按钮 + 清空按钮（有标记时才显示）

### 关键 bug 修复记录
- `poly.on('click', () => {})` 会拦截地图 click → 已移除
- SVG data URI cursor 无效 → 改用 `crosshair`
- `setBounds` 时序问题 → 改用 `amap.on('complete')` + `setZoomAndCenter`
- 选中区未居中 → `featureCenter()` 计算几何中心

## 地理编码
- 后端代理 `/api/geocode?address=xxx` → 高德 Web API
- 前端 StoreBasic.vue 编辑弹窗有「📍 根据地址获取经纬度」按钮
- 高德 key: `c44a253659c36563b8dd44d8a00f1bba`（config.json amapWebKey）
- 批量脚本: `node tools/batch-geocode.js`

## 数据库扩展
- stores 表新增: `lat REAL`, `lng REAL`, `remark TEXT`
- 新建 `map_pins` 表 (id, lng, lat, name, remark, color, radius, created_by, store_id)

## 默认登录
- 账号: admin / 密码: admin123
