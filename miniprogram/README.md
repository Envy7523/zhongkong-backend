# 鹅太公中控 · 小程序端

P0 目标：**协同事项一条完整闭环**（登录 → 列表 → 详情 → 跟进回复 → 状态推进 → 撤销）。
技术栈：uni-app（Vue3 + Vite）→ 编译为微信小程序（后续同一套码可再出 H5 内嵌企业微信工作台）。

---

## 一、当前状态

| 层 | 位置 | 状态 |
|---|---|---|
| 后端接口（协同事项） | `../lib/mp/`（`auth.js` / `router.js` / `upload.js`） | ✅ 冒烟测试 41/41 |
| 后端接口（营业数据，只读） | `../lib/mp/router.js` 的「门店营业数据」段 | ✅ 冒烟测试 34/34 |
| 数据表 | `mp_identities`、`mp_audit_logs`（`lib/db.js` 自动建） | ✅ |
| 小程序端 | 本目录 | ✅ 协同事项 4 页 + 营业数据 1 页 |

**P1 范围（已按你的口径确认）**：只读 —— 选择门店 + 选择日期 → 查看该店营业数据。不做填报、不做权限区分（所有登录用户可看全部门店）。

**设计前提**：个人测试期先跑通，企业阶段再切换身份源 —— 后端登录方式是 provider 抽象的，
`password`（现在用）→ `openid`（普通微信）→ `wxwork`（企业微信免登，企业主体后自动出现）。
切到企业阶段时，小程序页面代码不需要改。

---

## 二、跑起来的完整步骤（个人开发测试期，零成本）

### 1. 启动后端

```powershell
cd G:\zhongkong-backend
npm start                 # 默认 3456 端口
```

确认自检接口可用：浏览器打开 <http://localhost:3456/api/mp/health>，应返回
`{"ok":true,"service":"zhongkong-mp-api",...}`。

### 2. 编译小程序

```powershell
cd G:\zhongkong-backend\miniprogram
npm install               # 首次
npm run dev:mp-weixin     # 开发模式（改代码自动重编译）
# 或 npm run build:mp-weixin   生产构建
```

产物目录：`miniprogram/dist/dev/mp-weixin`（`build` 则是 `dist/build/mp-weixin`）。

### 3. 用微信开发者工具打开

1. 打开「微信开发者工具」→ **导入项目**
2. 目录选：`G:\zhongkong-backend\miniprogram\dist\build\mp-weixin`
   （用 `npm run dev:mp-weixin` 时则是 `dist\dev\mp-weixin`）
3. AppID：
   - 直接点 **「测试号」/ 游客模式** 就能跑（构建产物里预置的是 `touristappid`），模拟器调试足够；
   - 需要**真机预览**时，在开发者工具「详情 → 基本信息」把 AppID 换成自己的
     **小程序测试号**（免费、无需主体，[申请入口](https://developers.weixin.qq.com/miniprogram/dev/devtools/sandbox.html)）
     或已注册的个人主体小程序 AppID。
4. 首次打开若提示域名问题：**详情 → 本地设置 → 勾选**
   「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」
   （`src/manifest.json` 里已预置 `mp-weixin.setting.urlCheck: false`，通常会直接生效）

### 4. 登录

内置演示账号（`src/common/config.js` 的 `DEMO_ACCOUNTS`）：

| 账号 | 密码 | 角色 |
|---|---|---|
| `admin` | `admin123` | 管理员（全部门店） |
| `agent` | `agent123` | 专员 |

登录页点账号行可直接填充。

### 5. 真机调试（手机上看效果）

- 开发者工具右上角 **预览** → 手机扫码
- 手机端需在 **右上角「…」→ 打开调试**（否则走域名校验会失败）
- 服务器地址 `localhost` 在手机上不可达：在 **登录页 → 服务器地址** 改成电脑的局域网 IP，
  例如 `http://192.168.1.8:3456`（手机与电脑同一 WiFi，Windows 防火墙放行 3456）
- 想用公网演示：填 `http://134.175.41.247`（现有生产服务器）—— ⚠️ 那是生产库，别在里面写测试数据

`ipconfig` 查本机局域网 IP；放行端口：

```powershell
New-NetFirewallRule -DisplayName "zhongkong-3456" -Direction Inbound -Protocol TCP -LocalPort 3456 -Action Allow
```

---

## 三、目录结构

```
miniprogram/
├─ src/
│  ├─ manifest.json          # 小程序 AppID / urlCheck 等（企业阶段把 urlCheck 改成 true）
│  ├─ pages.json             # 页面路由与导航栏样式
│  ├─ App.vue                # 全局设计令牌（品牌色 / 卡片 / 状态胶囊 / 按钮）
│  ├─ common/
│  │  ├─ config.js           # 服务器默认地址、演示账号、状态样式
│  │  ├─ request.js          # 统一请求：token 注入、401 跳登录、网络错误人话提示、图片上传
│  │  ├─ api.js              # /api/mp 接口封装（与 lib/mp/router.js 一一对应）
│  │  └─ store.js            # 极简全局状态（不引 pinia）
│  └─ pages/
│     ├─ login/login.vue     # 账号密码登录 + 服务器地址设置 + 连接自检
│     ├─ collab/
│     │  ├─ list.vue         # 状态统计 / 标签筛选 / 与我相关 / 搜索 / 下拉刷新 / 触底加载
│     │  ├─ detail.vue       # 时间线 / 拍照回复 / 状态推进弹层 / 撤销
│     │  └─ create.vue       # 发起事项（标题/描述/起止日期/参与人）
│     └─ revenue/
│        └─ index.vue        # 门店营业数据（选门店 + 选日期 + 指标卡 + 渠道构成 + 环比）
```

协同事项页顶部有「门店营业数据」入口卡片，点击进入营业数据页。

---

## 四、后端接口对应关系

| 小程序调用 | 后端 | 说明 |
|---|---|---|
| `GET /api/mp/health` | 自检 | 联调第一步先打这个 |
| `GET /api/mp/auth/providers` | 登录方式探测 | 决定登录页是否显示企业微信免登 |
| `POST /api/mp/auth/login/:provider` | `password` / `openid` / `wxwork` | 统一入口，返回 7 天有效的 mp_token |
| `GET /api/mp/me` | 当前身份 | 含 `storeScope`（数据范围） |
| `GET /api/mp/collab/issues` | 列表 | `status` / `keyword` / `onlyMine` / 分页 |
| `GET /api/mp/collab/stats` | 状态计数 | 列表页顶部五个数字 |
| `GET /api/mp/collab/issues/:id` | 详情 | 返回 `next_status`（可推进的状态）供前端渲染按钮 |
| `POST /api/mp/collab/issues` | 发起 | |
| `POST /api/mp/collab/issues/:id/reply` | 跟进回复 | 图片传 URL（上传接口返回） |
| `PUT /api/mp/collab/issues/:id/advance` | 状态推进 | 仅发起人；状态机与 PC 端共用 `lib/collab-service.js` |
| `DELETE /api/mp/collab/issues/:id` | 撤销 | 仅发起人 + 仅「待开始」 |
| `POST /api/mp/upload` | 图片上传 | base64 入、URL 出，落盘 `data/uploads/mp/` |
| `GET /api/mp/stores` | 门店列表 | 营业数据页的门店选择器（`includeClosed=1` 可含已闭店） |
| `GET /api/mp/revenue/dates?store_id=` | 有数据的日期 | 倒序，用于日期快选与默认值 |
| `GET /api/mp/revenue?store_id=&date=` | 营业数据 | 不传 `date` 则返回最近有数据的一天；含渠道构成、支付来源、环比 |

### 营业数据口径（与 PC 后台 / Excel 一致）

| 指标 | 算法 |
|---|---|
| 营业额 | `daily_reports.revenue` |
| 实收 | `actual_revenue`；缺失时 = 店内+自提+美团外卖+淘宝闪购+京东外卖 |
| 客单价 | 实收 ÷ 有效订单数 |
| 优惠占比 | 优惠金额 ÷ 营业额 × 100（兼容 `'12.34%'` / `0.1234` / `12.34` 三种历史写法） |
| 销售渠道（5 项） | 店内 / 自提 / 美团外卖 / 淘宝闪购 / 京东外卖 —— **合计即实收** |
| 堂食消费来源（6 项） | 美团一键买单 / 美团团购 / 抖音团购 / 储值消费 / 优惠券 / 店内+自提收入 |
| 环比 | 对比**上一个有数据的日期**（自动跳过未填报的日子），而非自然日的前一天 |

> ⚠️ 界面上「销售渠道」和「堂食消费来源」是**两个不同维度**，分开显示、各自合计，不做相加。
> PC 后台的「门店营收构成」把这两组混在一个合计里，移动端刻意做了区分。

**为什么图片不直接存库**：PC 端协同事项目前把 base64 存在 `collab_replies.images` 里，
线上库已 265MB，移动端高频拍照会加速膨胀。小程序改成「落盘 + 库里只存 URL」，
展示时对历史 base64 数据做了兼容（`normalizeImage`）。

---

## 五、联调与回归

```powershell
# ---------- 协同事项接口 ----------
$env:PORT="3457"; node server.js                      # 另开一个窗口
node tools\mp-smoke.js http://localhost:3457          # 41 个用例
node tools\mp-clean.js                                # 清理测试数据（运行中执行也可以）

# ---------- 营业数据接口 ----------
# 情况 A：本地开发库 daily_reports 是空的 → 造一个独立演示库（不碰开发库）
node tools\_dsh_seed_revenue.js                       # 生成 data/_scratch_rev.sqlite（30 天仿真数据）
$env:ZK_DB_PATH="data/_scratch_rev.sqlite"; $env:PORT="3458"; node server.js
node tools\mp-revenue-smoke.js http://localhost:3458  # 34 个用例

# 情况 B：已有真实数据（开发库或生产库副本）→ 直接打那个地址
node tools\mp-revenue-smoke.js http://localhost:3456

# ---------- 数据库驱动自检 ----------
node tools\_dsh_check_dbapi.js                        # 驱动 API 兼容性 24 项
node tools\_dsh_check_fresh.js                        # 全新空库初始化 20 项
node tools\db-backup.js                               # 在线备份
```

> 💡 `ZK_DB_PATH` 环境变量可以把服务指向任意库文件，用来在独立库上做实验，
> 不会碰到开发库 `data/database.sqlite`。

✅ **运维红线已放开**：数据库已从 sql.js（内存态、需整体重写）换成原生 SQLite + WAL，
现在多进程访问由数据库自身加锁协调，**运行中直接改库是安全的**（`tools/_dsh_check_livewrite.js` 可复现验证）。
仍建议：批量写操作尽量避开高峰，或走 API。

⚠️ **但备份方式变了**：WAL 模式下 `cp data/database.sqlite` 会漏掉还在 `-wal` 里的最新事务。
请改用 `node tools/db-backup.js`（VACUUM INTO，在线一致性快照，服务无需停止）。

---

## 六、下一步（按优先级）

| 优先级 | 事项 |
|---|---|
| **当前待办** | 真机过一遍协同事项 + 营业数据两页；把生产库副本拉下来后用真实数据复验营业数据口径 |
| P1 | 订阅消息提醒（被指派 / 被回复），替代小程序不能长连接的限制 |
| P1 | 底部 tabBar（协同事项 / 营业数据），模块变多后再上 |
| P2 | 菜品销量维度的营业数据（生产库有 `dish_sales` 等表，需确认字段后再做） |
| P2 | 日报填报（本次已确认为"只读"，暂不做；如后续要填，需要先定与 Excel 导入的优先级规则） |
| P2 | 微信授权 + 邀请码登录（后端已支持 `openid` provider，配 `config.json` 的 `mp.appid`/`mp.secret` 即启用） |
| P2 | 企业微信免登（企业主体 + 关联自建应用后，`wxwork` provider 自动出现） |
| 正式上线前 | 删掉 `DEMO_ACCOUNTS` 与登录页演示区块；`urlCheck` 改 `true`；换 https 备案域名 |
