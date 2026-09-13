# 小程序端交接说明（/api/mp + miniprogram）

> 交接时间：2026-09-12 ｜ 状态：初版可用，营业数据口径已与 PC 后台对齐并验收通过（41 项端到端断言）

---

## 进度快照（2026-09-12 收工）

### 今天完成了什么

- `/api/mp` 装进**本仓库**：`lib/mp/` 4 个文件 + `server.js` 两处挂载 + `lib/db.js` 两张表，与 PC 后台**同进程、同端口（3456）**
- 营业数据口径改为复用 `businessAnalytics.getOverview()`，不再自行汇总；
  基准校验：**方洲店 2026-09-09 ¥4,453.64 与后台完全一致**
- 移动端新增「门店营业数据」页：营业额+环比、实收/订单/客单价/优惠/平台费用/平台入账、
  渠道构成、渠道分组、营收构成、平台费用明细、热销菜品
- 验收：端到端 41/41 通过、口径映射回归 36/36 通过

### 明天开工三条命令

```powershell
Set-Location F:\NewDeom; npm run dev                          # 后端（3456，改代码自动重启）
Set-Location F:\NewDeom\miniprogram; npm run dev:mp-weixin     # 小程序编译（首次需先 npm install）
# 微信开发者工具 → 导入 F:\NewDeom\miniprogram\dist\dev\mp-weixin → 登录 admin/admin123
```

### 待办（按优先级）

| # | 事项 | 关键点 |
|---|---|---|
| 1 | **小程序工程收拢到本仓库** | 现在 `miniprogram/` 只有源码、未装依赖；跑起来后删掉 `G:\zhongkong-backend\miniprogram` 实验副本，避免"改的不是跑的那份" |
| 2 | **手机真机测试** | 需 4 件事：① 申请小程序**测试号** AppID 填 `src/manifest.json` 第 9 行（游客模式不能预览）② 管理员 PowerShell 放行 3456 端口 ③ 登录页「服务器地址」填 `http://<本机局域网 IP>:3456` ④ 手机端右上角「…」→ 打开调试 |
| 3 | **上线准备** | AppID 填正式号、`DEFAULT_BASE_URL` 换 https 域名、`urlCheck` 改回 `true`、**删掉登录页演示账号区块**（明文 admin/admin123 是审核必拒项） |
| 4 | 功能候选 | ① 趋势图（后台 `overview` 已返回 `trend` 数组）② 多店对比排行（已返回 `stores` 数组）—— 两者都只动小程序前端、不碰口径，风险最低 |
| 5 | 数据库驱动改造 | `lib/db.js` 的 `save()` 每次写操作整库重写（本地库 268.8MB）；收益最大但最需谨慎，建议单独一轮做 |
| 6 | ~~上云~~ **✅ 已完成（2026-09-14）** | 代码已部署到 `<生产服务器 IP（见内部文档 CLOUD_DEPLOY/SERVER_ACCESS）>`（含 `/api/mp`），鸡鸭鹅数据已同步；详见文末「附 B 上云作业单」的执行记录 |

---

## 附 C：数据库查看（开发辅助工具，2026-09-14 新增）

**入口**：侧栏「系统管理 → 数据库查看」，或直接访问 `/db-viewer`。

| 能力 | 说明 |
|---|---|
| 数据表浏览 | 左侧按业务分类列出全部表（含行数、被引用次数），右侧看结构 / 索引 / 数据（分页、排序、全字段关键字过滤） |
| 引用关系 | 每张表列出**被哪些文件、哪一行、哪个接口/函数**引用 |
| 功能 → 数据 | **页面 → 接口 → 数据表** 的完整链路；并支持反查「某张表被哪些接口读/写」、以及列出未被引用的表 |
| 文件浏览 | 项目内文件树 + 文本预览（图片可内联预览） |
| SQL 控制台 | 只读查询，显示耗时与行数 |

**安全设计（重要）**：

1. **只读**：所有接口只发 SELECT，不提供任何写操作。
2. **标识符白名单**：表名/字段名必须先经 `sqlite_master` / `PRAGMA` 校验存在才拼进 SQL，值全部参数绑定 → 从根上防注入（实测 `dish_sales; DROP TABLE users` 被拒）。
3. **SQL 控制台**：仅允许单条 `SELECT`/`WITH`，屏蔽 `INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/PRAGMA/ATTACH` 等；无 LIMIT 时自动补 `LIMIT 1000`。
4. **文件访问越界防护**：解析真实路径后必须仍在项目内，且**屏蔽 `config.json`（含企微凭据）、私钥、`.git`、`node_modules`、数据库二进制文件**。

**扫描机制与已知限制**：

- 表名取自 SQL 中 `FROM / INTO / UPDATE / JOIN` 之后且**确实存在于 `sqlite_master`** 的标识符 —— 这一步过滤掉了关键字误报。
- 接口维度：按 `app.get/post/...` 切块统计；lib 维度：按函数切块统计（**含 `lib/mp/` 等子目录**）。
- 前端维度：`views/**/*.vue` 调用了哪些 `api/index.js` 里的函数 → 映射到接口路径 → 再接上接口用到的表。
- ⚠️ **扫不到的情况**：① 由 `server.js` 里的**工具函数**（非路由处理器）访问的表，例如 `config`；
  ② 表名动态拼接的场景。这类表会出现在「未被直接引用」列表里，属预期行为。

**自测**：

```powershell
node tools/db-viewer-smoke.js http://localhost:3456   # 35 项，含注入/越界/写操作拦截等安全边界
```

---

## 附 A：集团↔门店 通知/任务/反馈 布局讨论（2026-09-12，仅设计，未动代码）

### 三样东西必须分开

| | 方向 | 单位 | 终点状态 | 指标 |
|---|---|---|---|---|
| 通知 | 集团 → 多店 | 以**门店**为单位（谁已读） | 已读回执 | 触达率、已读率 |
| 任务 | 集团 → 多店 | **每店一份实例** | 验收通过 | 完成率、逾期率、驳回率 |
| 上报 | 门店 → 集团 | 以事项为单位 | 已回复并关闭 | 响应时长、闭环率 |

**关键决定：任务必须拆成 `issue`(模板) + `issue_target`(每店实例)**，否则算不出完成率，
一家店提交就会把整条任务推到"待验收"。这是唯一"现在不做、以后必返工"的点。

### 现有资产盘点（勘察结论）

- ✅ `collab_issues` / `collab_replies` 已有 `visibility`、`archived_at`、`reply_type`、楼中楼、
  **`completion_status` + `reviewed_by/at/review_note`（提交→审核→驳回 的骨架已具备）**
- ✅ `store_regions` 三级区域树（广东省→深圳市/惠州区/揭阳区/东莞市、湖南省→郴州市、浙江省→杭州市）
  可直接做"发给哪个范围"；`store_region_members` 25 行
- ⚠️ `store_manager_assignments` **只有 1 行**；`users` 里只有 3 个"管理员"
  → **门店↔人↔角色 的地基必须先补**，否则权限无从谈起
- ❌ 通知表、回执表、上报表、每店实例：63 张表里一张都没有（空白）
- 现网已有使用痕迹：`王督导` 发起过事项、`visibility=internal` 已在使用

### 触达通道（修正此前结论）

**小程序能做提醒，走「订阅消息」，落在微信「服务通知」里：**

- 一次性订阅：**授权 1 次 = 1 条下发额度**，按模板累积；勾选「总是保持以上选择」后不再弹窗、
  可静默累积 —— 游戏"该上线了"的提醒就是这么攒出来的
- 长期订阅：多次下发但**仅特定类目开放**（企业管理类基本没有，可在后台模板库自查）
- ⚠️ 真实约束：① 模板字段固定、正文塞不进去（只做"标题级响铃"）② **没进过小程序就没额度**
  ③ 拒过后一段时间不再弹窗 ④ 内容必须与模板匹配
- 设计成「**以事换量**」：店长登录/提交/点确认收到时顺手请求订阅累积额度，
  在发布任务、截止前 24h、逾期、每日汇总时消耗
- **必须有降级链路**：订阅消息 →（额度不足/被拒）企业微信群消息 →（最后）小程序内红点

> 结论：订阅消息做**日常提醒**，企业微信群消息做**兜底与汇总**，小程序做**办事与留痕**。

### 落地节奏（三刀，每刀可单独上线）

1. **通知 + 回执 + 上报**（不动现有状态机，风险最低）
2. **任务每店实例 + 完成看板 + 催办**（改动最大，等第 1 刀验证门店真会用手机办事）
3. **与企业微信打通响铃 + 每日/每周汇总**（有内容才谈触达）

### 六个坑

1. 回执别做成强制；2. 任务必须有"驳回重做"（字段已就绪）；3. 逾期必须自动提醒；
4. **别给门店"发起任务"权限**，门店只能上报；5. 完成率口径要提前定义；
6. "已读"不等于"做到"，重要通知后面通常要跟一条任务。

---

## 附 B：上云作业单（2026-09-12）

### 目标

1. 把本仓库代码部署到 `<生产服务器 IP（见内部文档 CLOUD_DEPLOY/SERVER_ACCESS）>`（含 `/api/mp`，小程序即可连生产）
2. **只同步鸡鸭鹅数据**，其他运营数据**一概不动**

### 鸡鸭鹅数据的精确边界（已勘察）

**要同步（鸡鸭鹅专属表）：**

| 表 | 本机 F | 生产 | 说明 |
|---|---|---|---|
| `poultry_birds` | 3 | 0 | 禽类建档（鹅/鸡/鸭，毛重+成本） |
| `poultry_yields` | 27 | 0 | 出成部位（整只/半只/上庄…含 `part_kind`/`zone_code`/`yield_mode`） |
| `poultry_dish_usage` | 39 | 0 | 菜品↔部位用量 |
| `poultry_purchases` | 15 | 0 | 各店月度采购 |
| `poultry_scope_dishes` | 0 | **表不存在** | 范围配置 |
| `poultry_scope_keywords` | 4 | **表不存在** | 范围关键词（鹅/鸭 include、蛋 exclude） |

合计 **88 行**，两张新表。

**归属判断（已确认）：**
`dish_sales_mappings` 110→53 里有 **54 行被 `poultry_dish_usage` 引用**（收银商品名→菜品ID 的映射，
缺了它生产上禽类菜品销售就汇总不出来）→ **必须带**；
`business_product_mappings` 169→166 里 2 行是鹅类外卖商品映射 → **一起带**；
`menu_cost_components` 15→11 → **不带**（是与禽类无关的套餐成本）。

**原计划不同步、后经确认改为同步：**
`dish_sales`（本机 229,613 行，比生产多 39,176 行 = 09-01~09-10 那批收银品项明细）。
原因：禽类消耗反推依赖 `dish_sales`，不同步会导致生产上的禽类核算缺这 10 天数据。
最终以 **append 模式**只追加生产缺的行（详见下方执行记录）。

**始终不同步（运营数据）：** `menu_items`、`stores`、`business_revenue_records`、
`business_revenue_compositions`、`business_product_sales`、`pos_product_sale_details`、
`bookkeeping_entries`、`daily_reports`、`users`、`employees`、`collab_*`、`cost_accounting`。

### ✅ 执行记录（2026-09-14 00:40 已完成）

**实际执行结果：**

| 步骤 | 结果 |
|---|---|
| 生产库备份 | `data/database.sqlite.bak-20260914004135`（停服务期间拷贝） |
| 代码部署 | tar 上传解压 → 前端构建到 `dist.new` 再原子替换（避免构建期白屏）→ 服务重启 |
| 数据写入 | **9 张表 / 39,543 行**，脚本自动补建 `poultry_yields.zone_code`、`yield_mode` 两个缺失字段 |
| 服务状态 | `active`，停机窗口约 10 秒 |

**实际同步范围（与最初计划有两处调整，均已与用户确认）：**

| 表 | 模式 | 结果 |
|---|---|---|
| poultry_birds / yields / dish_usage / purchases / scope_dishes / scope_keywords | replace | 3 / 27 / 39 / 15 / 0 / 4 行 |
| dish_sales_mappings | replace | 53 → **110** 行 |
| business_product_mappings | replace | 166 → **169** 行 |
| `dish_sales` | **append（只追加）** | 190,437 → **229,613** 行（+39,176，09-01~09-10） |
| menu_cost_components | **同步排除** | 4 行与禽类无关（套餐成本），留在本机 |

**追加安全性（写库前逐项验证过）：**

- 本机 dish_sales 是生产的**严格超集**（生产多出 0 行），待追加 id 全部 > 生产最大 id(380874) → **零冲突**
- 同 id 内容抽样 200 个**全部一致** → 两库同源
- 生产在 08-31~09-10 区间的 dish_sales 为 **0 行**，而同一批收银明细（`pos_product_sale_details`）生产已有 41,356 行 → 追加是**补数据不是重复**
- 导入逻辑本身按「门店+订单号」先删后插（`business-analytics.js:788`）→ 将来重传同一报表**不会翻倍**

**运营数据零变动（写入前后一致）：** business_revenue_records 21,538 / compositions 41,668 / bookkeeping_entries 7,807 / menu_items 160 / stores 25 / users 3

**上线验收 13/13 通过**（`node tools/_cloud_verify_deploy.js http://<生产服务器 IP（见内部文档 CLOUD_DEPLOY/SERVER_ACCESS）>`）：

```
✅ PC 后台登录 / 营收分析正常（全连锁 gross=105,317.94）
✅ 小程序接口已部署（/api/mp/health）
✅ 小程序营业额 == 后台营业额（方洲店 09-09：4,453.64）
✅ 鸡鸭鹅档案上云（鹅 出成12项/菜品23个、鸭 9/16、鸡 6/0）
✅ 出成部位 27 条，含新增字段 zone_code=whole / yield_mode=fraction
✅ 菜品用量配置 38 个菜品已配置
✅ dish_sales 已补至 229,613 行
✅ 前台页面与 25 个静态资源全部 HTTP 200
```

> ⚠️ 本次部署的是**工作区当前状态（含未提交的 WIP）**，非 git 提交版本。
> 生产库备份保留在服务器 `data/database.sqlite.bak-20260914004135`，
> 回滚方式：停服务 → 用该文件覆盖 `data/database.sqlite` → 起服务。

---

### 环境快照

| 项 | 值 |
|---|---|
| 本机局域网 IP | **<本机局域网 IP>**（手机测试用这个，不是 localhost） |
| 3456 | 本仓库服务；**AI 助手不占用任何端口**（3457-3460 空闲） |
| 仓库关系 | `F:\NewDeom` = 唯一正式仓库；`G:\zhongkong-backend` = 旧的 7 月快照 + 实验区 |
| 待清理文件 | `G:\zhongkong-backend\data\prod-copy.sqlite`（253MB 生产库副本；口径已改为走接口，可安全删除） |
| 备份方式 | `node tools/db-backup.js`（注意：WAL 前的老库用 cp 备份是安全的，将来换原生 SQLite 后必须改用这个脚本） |

---

## 一、它在哪里、怎么跑

**关键点：小程序没有独立后端进程。** `/api/mp/*` 挂在你原有的服务里，与 PC 后台**同一个进程、同一个端口（3456）**。

| 部分 | 位置 | 说明 |
|---|---|---|
| 接口层 | `lib/mp/` | `auth.js`（登录）、`router.js`（路由）、`revenue-map.js`（口径映射）、`upload.js`（图片落盘） |
| 挂载点 | `server.js` | ① 鉴权中间件放行 `/api/mp/` ② 挂载路由与 `/uploads/mp` 静态目录（共 9 行） |
| 数据表 | `lib/db.js` | `mp_identities`（身份映射）、`mp_audit_logs`（移动端操作审计） |
| 小程序 | `miniprogram/` | uni-app（Vue3 + Vite），编译为微信小程序 |

**启动：**

```powershell
# 后端（改了代码会自动重启）
Set-Location F:\NewDeom
npm run dev

# 小程序（另开窗口，保持监听）
Set-Location F:\NewDeom\miniprogram
npm install          # 首次
npm run dev:mp-weixin

# 微信开发者工具 → 导入项目 → F:\NewDeom\miniprogram\dist\dev\mp-weixin
# AppID 用「测试号」即可；若提示域名问题：详情 → 本地设置 → 勾选「不校验合法域名」
```

登录账号就是后台的账号：`admin / admin123`（登录页点演示账号可直接填充）。
真机预览时把登录页的「服务器地址」改成电脑的局域网 IP（如 `http://192.168.1.8:3456`）。

> ⚠️ **不要为了小程序另起一个服务实例占别的端口**。曾经因为这样导致 PC 后台 404/502，也踩过"两个库互相覆盖"的坑。一个小程序只是 3456 的另一个客户端。

## 二、营业数据的口径（最容易踩的坑）

**规则：移动端不自己算营业额，一律调用 `businessAnalytics.getOverview()`。**

`lib/mp/revenue-map.js` 只做「搬运 + 改字段名」，一个数字都不重算。

为什么必须这样 —— 方洲店 2026-09-09 实例：

| 算法 | 结果 |
|---|---|
| 自行 `SUM(business_revenue_records.gross_amount)` | ¥6,388.13 ❌ |
| 后台 `getOverview().totals.gross_amount` | **¥4,453.64 ✅** |

三个差异来源：

1. **堂食**取「确认收入」2,798.79，不是 POS 原始营业额 3,434.40；
2. **外卖**只认平台侧结算（342.78 + 331.75），POS 侧那两行（812.10 / 664.10）不能重复计入；
3. **美团外卖**的营业额只能来自营业日报，没有日报时后台置 0 并标记 `gross_pending`（界面应提示"待补"）。

后台返回的关键字段：`totals.gross_amount`（营业额）、`totals.confirmed`（实收/确认收入）、
`totals.discount_amount`、`totals.fees` + `fee_breakdown`、`totals.platform_income_amount`、
`channel_breakdown`（含 `source_used` / `gross_pending`）、`revenue_composition`、
`fee_detail_breakdown`、`top_products`。

**改口径时**：只需改 `business-analytics.js`，小程序自动跟随。
**禁止**在 `lib/mp/` 里新增任何自行汇总营业额的 SQL。

## 三、接口清单

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/mp/health` | 自检（联调第一步先打这个） |
| GET | `/api/mp/auth/providers` | 可用登录方式（决定是否显示企业微信免登） |
| POST | `/api/mp/auth/login/:provider` | `password` / `openid` / `wxwork`，返回 7 天有效的 mp_token |
| GET | `/api/mp/me` | 当前身份 + 数据范围 |
| GET | `/api/mp/stores` | 门店列表（选择器数据源） |
| GET | `/api/mp/revenue/dates?store_id=` | 有营收数据的日期（倒序） |
| GET | `/api/mp/revenue?store_id=&date=` | 营业数据（含 metrics/sections/环比） |
| GET | `/api/mp/collab/issues` | 协同事项列表（`status`/`keyword`/`onlyMine`/分页） |
| GET | `/api/mp/collab/stats` | 状态计数 |
| GET | `/api/mp/collab/issues/:id` | 详情（含 `next_status` 供前端渲染按钮） |
| POST | `/api/mp/collab/issues` | 发起事项 |
| POST | `/api/mp/collab/issues/:id/reply` | 跟进回复（图片传 URL） |
| PUT | `/api/mp/collab/issues/:id/advance` | 状态推进（仅发起人） |
| DELETE | `/api/mp/collab/issues/:id` | 撤销（仅发起人 + 仅「待开始」） |
| POST | `/api/mp/upload` | 图片上传（base64 入、URL 出，落盘 `data/uploads/mp/`） |

**鉴权是两套、互不相通**：小程序用 `/api/mp/auth/login` 拿到的 mp_token；
用 mp_token 调 `/api/*` 会 401，反过来也一样。

**协同事项的签名兼容**：本仓库的 `lib/collab-service.js` 与早期版本不同
（`addReply` 第 4 参是 `replyType`、`listIssues/getIssueDetail` 需要 `user`、未导出 `ALLOWED_TRANSITIONS`），
`lib/mp/router.js` 顶部已做自适应，改动这两个 service 时留意不要破坏兼容分支。

## 四、图片为什么不存库

PC 端协同回复把 base64 存在 `collab_replies.images` 里，库已 265MB+，移动端高频拍照会加速膨胀。
小程序改为「落盘 + 库里只存 URL」，展示时对历史 base64 数据做了兼容（`normalizeImage`）。

## 五、自测脚本

```powershell
# 端到端验收：小程序接口 vs PC 后台接口，逐项相等（含方洲店 4,453.64 基准）
node tools/mp-e2e-smoke.js http://localhost:3456

# 口径映射回归：直接拿后台 overview 喂给映射函数，校验不漂移
node tools/mp-revenue-map-smoke.js http://localhost:3456

# 协同事项接口冒烟（会创建测试数据）
node tools/mp-smoke.js http://localhost:3456
node tools/mp-clean.js          # 清理【冒烟测试】数据
```

## 六、加新页面的步骤

1. `miniprogram/src/pages/<模块>/<页面>.vue`
2. `miniprogram/src/pages.json` 注册路径
3. 接口封装加到 `miniprogram/src/common/api.js`
4. 页面只用后端下发的 `metrics` / `sections` 渲染（不要把口径写进页面）

## 七、后续可做（按优先级）

| 优先级 | 事项 |
|---|---|
| P1 | 日报填报（目前只有后台 Excel/平台账单导入；要做需先定与导入的优先级规则） |
| P1 | 趋势图（后台 `overview` 已返回 `trend` 数组，可直接画周/月走势） |
| P1 | 多店对比（后台 `stores` 数组一次返回全部门店，可做排行） |
| P2 | 订阅消息提醒（被指派/被回复），替代小程序不能长连接的限制 |
| P2 | 企业微信免登（企业主体 + 关联自建应用后，`wxwork` provider 自动出现） |
| P2 | 数据库驱动改造：`lib/db.js` 的 `save()` 目前每次写操作整库重写（本地库 268.8MB），建议换原生 SQLite + WAL（已在小程序侧代码验证过方案，实测单次写入从数百毫秒降到 ~1ms） |
