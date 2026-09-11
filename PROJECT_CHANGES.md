# 中控后台 · 改动与部署记录

> 本文档记录本项目相对"基础版"的所有自定义改动，以及云服务器部署信息。
> **更新项目/重新部署前先读本文档**，避免被旧版本覆盖丢失功能。

---

## 一、云服务器部署（上云）

### 服务器信息
| 项目 | 值 |
|------|-----|
| 公网 IP | 134.175.41.247（腾讯云轻量，实例 lhins-c2q2pyy7） |
| 访问地址 | http://134.175.41.247（nginx 80 → node 3456） |
| SSH | 端口 22，用户 ubuntu |
| 项目目录 | `/home/ubuntu/app` |
| 数据目录 | `/home/ubuntu/app/data`（database.sqlite） |
| 服务 | systemd `zhongkong.service`（崩溃自动重启） |

### 连接工具（本地）
- 目录：`server-access/`（私钥 `zhongkong_company`、`sshrun.py`、备份 `backup/`）
- 私钥等同服务器钥匙，**切勿外传**
- 快捷连接：`ssh -i server-access\zhongkong_company ubuntu@134.175.41.247`

### 部署 / 更新步骤（重要）
```bash
# 1. 上传源码（每次改完代码都做）
scp -i server-access\zhongkong_company server.js package.json package-lock.json config.json stores.json ubuntu@134.175.41.247:/home/ubuntu/app/
scp -i server-access\zhongkong_company -r lib css js tools demo ubuntu@134.175.41.247:/home/ubuntu/app/

# 2. 上传前端（先本地 npm run build）
scp -i server-access\zhongkong_company -r frontend\src frontend\dist frontend\public ubuntu@134.175.41.247:/home/ubuntu/app/frontend/
scp -i server-access\zhongkong_company frontend\package.json frontend\package-lock.json frontend\vite.config.js frontend\index.html ubuntu@134.175.41.247:/home/ubuntu/app/frontend/

# 3. 上传数据库（仅在需要同步数据时）
scp -i server-access\zhongkong_company data\database.sqlite ubuntu@134.175.41.247:/home/ubuntu/app/data/database.sqlite

# 4. 云端重启
ssh -i server-access\zhongkong_company ubuntu@134.175.41.247 "cd /home/ubuntu/app && sudo systemctl restart zhongkong"
```

### 云端注意事项
- 服务器上没有 git，直接覆盖部署
- 覆盖前建议备份云端文件：`ssh ... "cp /home/ubuntu/app/data/database.sqlite /home/ubuntu/app/data/database.sqlite.bak-$(date +%Y%m%d%H%M%S)"`
- 云端旧数据库已备份到本地 `server-access/backup/server-database.sqlite`

---

## 二、2026-08-28 · 全国地图修复（DataV 防盗链）

### 问题
云端地图完全空白，控制台报：
```
Failed to load resource: 403
Uncaught (in promise) SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON
```
本地正常，上云后失效。

### 根因
`StoreMap.vue` 画省份色块用的 GeoJSON 来自**阿里云 DataV**：
`https://geo.datav.aliyun.com/areas_v3/bound/*.json`
DataV 校验浏览器 **Referer 防盗链**：本地 localhost 放行，云域名被拒 → 403 HTML → 前端 JSON 解析崩溃 → 地图空白。
（**不是高德问题**——高德 key 白名单已配好，脚本加载正常）

### 修改文件
1. **`frontend/src/views/store/StoreMap.vue`**
   - `GEO_BASE` 从 `https://geo.datav.aliyun.com/areas_v3/bound` 改为 `/api/geo/bound`
   - 3 处 fetch 改为带参形式：
     - `` fetch(`${GEO_BASE}?path=100000_full.json`) ``
     - `` fetch(`${GEO_BASE}?path=${adcode}_full.json`) ``（2 处）
2. **`server.js`**
   - JWT 中间件放行 `/api/geo/bound`（地图边界数据无需登录）
   - 新增代理接口 `GET /api/geo/bound?path=xxx_full.json`：
     - 后端转发到 DataV（服务器请求无 Referer 限制，实测 200）
     - 路径白名单校验（只允许 `xxx_full.json`，拦截目录穿越）

### 验证
- 本地/云端 `GET /api/geo/bound?path=100000_full.json` → 200，582KB GeoJSON
- 非法路径 → 400

---

## 三、历史功能改动清单（防止更新覆盖丢失）

> 以下功能都是在本项目基础版上新增的，**更新代码时务必保留这些改动**。

### 1. 菜品分类（菜品管理 → 菜品分类）
| 文件 | 改动 |
|------|------|
| `lib/db.js` | 新增 `menu_categories` 表 + 历史分类迁移 |
| `server.js` | `/api/menu-category/*` CRUD、`/api/menu-categories` 改造 |
| `frontend/src/views/menu/MenuCategory.vue` | 新增页面 |
| `frontend/src/views/menu/MenuModuleHeader.vue` | 导航加「菜品分类」 |
| `frontend/src/App.vue` / `stores/app.js` / `router/index.js` | 菜单与路由 |

### 2. 菜品销售明细（dish_sales 表 + 数据）
| 文件 | 改动 |
|------|------|
| `lib/db.js` | 新增 `dish_sales` 表（门店/菜品编码/名称/规格/数量/金额/优惠/收入/时间/退款/订单号/结账方式/退款金额）+ 索引 |
| `server.js` | `/api/dish-sales`（分页查询）、`/api/dish-sales/stats`、`/api/dish-sales/analytics`（菜品分析聚合，支持门店筛选/分页） |
| 数据 | 已导入 190,437 条菜品销售明细（5/1–8/9），门店名称对齐后台 23 家 |
| `frontend/src/views/analysis/BusinessAnalytics.vue` | 总数据视角新增「菜品销售分析」面板 |

### 3. 堂食菜品绑定（总数据视角）
| 文件 | 改动 |
|------|------|
| `lib/db.js` | 新增 `dish_sales_mappings` 表，唯一键 `(product_code, product_name, spec)`（**规格参与唯一键，上庄/下庄不混绑**） |
| `server.js` | `/api/dish-sales/mappings` 列表（含 mapped 状态筛选）、`POST` 绑定、`POST /batch` 批量、`POST /auto-bind` 一键、`DELETE` 解绑 |
| `frontend/src/views/analysis/DishSalesBinding.vue` | 新增页面（筛选/多选批量/一键绑定/规格区分） |
| 路由/菜单 | `/analysis/total/binding`、「堂食菜品绑定」入口 |

### 4. 团购/外卖菜品绑定
| 文件 | 改动 |
|------|------|
| `lib/business-analytics.js` | 商品分析返回 `mapping_id`；新增 `deleteProductMapping` |
| `server.js` | `DELETE /api/business-analytics/mappings/:id`、`POST /batch`、`POST /auto-bind` |
| `frontend/src/views/analysis/ProductBinding.vue` | 绑定页（筛选/多选批量/一键绑定） |
| 路由/菜单 | `/analysis/group-buy/binding`、`/analysis/delivery/binding` |

### 5. 其他
- `lib/db.js` 的 `save()`：写盘失败重试 3 次（Windows 防病毒瞬时锁文件）
- `frontend/index.html`：加载高德 JS API（key `95fc48463fa6945f4c5a2380dd549d7b`，需在高德控制台配域名白名单，含云 IP）

---

## 四、更新项目时的注意事项（防覆盖）

1. **不要用旧版覆盖这些文件**（含上述所有自定义功能）：
   - `lib/db.js`、`lib/business-analytics.js`、`server.js`
   - `frontend/src/views/analysis/*`、`frontend/src/views/menu/MenuCategory.vue`
   - `frontend/src/App.vue`、`stores/app.js`、`router/index.js`、`api/index.js`
2. **前端 dist 每次更新需重新构建**：`cd frontend && npm run build`（dist 是构建产物，别用旧 dist）
3. **数据库**：`data/database.sqlite` 是核心数据（88MB，19 万条销售明细），**不要用旧库覆盖**
4. **上云后**：按「一、部署/更新步骤」重新上传修改过的文件并重启服务
5. 高德白名单：云 IP `134.175.41.247` 需在 key 的域名白名单里（已配）
6. `config.json` 含真实凭据（corpid/botSecret/AI key），部署时保留

---

*记录日期：2026-08-28*

## 2026-09-02 淘宝闪购“账单汇总”真实到账导入（真实实收口径修正）

背景：此前导入的“营业额收入单量”实收未扣第三方费用（8月=182,995.64），平台真实到账需扣除推广/保障/余额变动等费用。
- 新增表 taobao_flash_bills（账单汇总原始行：结算入账ID/门店ID/门店名称/账单日期/结算金额/结算日期/账单类型 + 整行 raw_json，未来新增列自动收录；UNIQUE(门店ID,账单日,账单类型)，可重复导入覆盖）
- lib/business-analytics.js：importTaobaoFlashWorkbook 自动识别“账单汇总”子表（仅该子表入库）→ importTaobaoFlashBillWorkbook：每店每日净额=当日全部账单类型金额之和，覆盖写入 business_revenue_records（channel=taobao_flash, actual=真实实收, gross=外卖结算金额, 有效订单数延续旧记录）；对“整月商品销量汇总”文件给出明确报错不入库；日期范围已有账单汇总时拒绝旧“营业额收入单量”误覆盖
- 前端 BusinessDataImport.vue：淘宝闪购入口新增“真实到账·账单汇总（推荐）”卡片与字段说明，导入结果显示 净额合计/原始明细
- 2026-08 导入结果：账单汇总 1449 行、18 门店全匹配、479 条每店每日净额、净额合计 ¥169,393.83（旧口径 ¥182,995.64 − 第三方费用 ¥13,601.81）

## 2026-09-02 记账本覆盖更新（删除 ≥8/10 旧记账 → 导入 Sheet1 权威数据）
- 新增 lib/bookkeeping-import.js + POST /api/bookkeeping/import-replace：解析含 日期/门店名称/大类/小类/金额 的记账流水子表（按有效数据行数自动选主表，仅 Sheet1 这类流水表；门店按名称匹配本地 stores；大类/小类按名复用或自动创建；早于 replace_from 的行拒绝）
- 处理：先 DELETE bookkeeping_entries date>=2026-08-10（删除 733 条旧数据），再导入 记账本更新92.xlsx Sheet1 全部 2396 条（8/10~8/31，21 家门店全匹配，0 跳过）
- 核验：本地记账总量 6852（<=8/9 保留 4456 + >=8/10 新 2396）；8/10-8/31 各大类合计与文件逐项一致（销售收入 +1,451,877.22 / 原材料 -420,650.02 / …），合计 609,090.25

## 2026-09-02 美团外卖“真实到账”结算账单导入（与淘宝闪购同法）
- 新表 meituan_delivery_bills：按(美团门店ID, 账单日期, D交易类型)汇总 R商家应收款（含交易笔数/描述快照，未来新列自动收录）；来源“订单明细”导出（表头不固定在第1行亦可识别）
- lib/business-analytics.js：importMeituanDeliveryWorkbook 自动识别“订单明细”结算表 → importMeituanDeliveryBillWorkbook；rebuildMeituanDeliveryRevenue：营业额/优惠后收入/单量来自美团营业额日报，真实到账=当日全部交易类型商家应收款之和，费用按类型归入 推广/保险/退款/服务；只重建 source_type='platform'，保留收银机(pos)记录
- 补充绑定：美团外卖 platform_id 保利上城(26)=34251847、未来花园(27)=34251852（档案原为空）
- 2026-08 导入结果：1918 条(门店,日,类型)账单、18 店全匹配、521 条每店每日净额；真实到账合计 ¥218,536.74（与官方“账单明细”按店日汇总 521/521 完全一致），费用合计 ¥17,832.19
- 前端：美团外卖入口新增“真实到账 · 结算账单”卡片与字段说明，导入结果显示 优惠后收入/平台费用/真实实收

## 2026-09-10 总数据视角「菜品销量」替换为「菜品销售分析」（去重复）
背景：总数据视角（品牌/门店）里，页签「总数据菜品销量」与「经营总览」底部的「菜品销售分析」面板功能重合。按用户决定，保留字段更完善的菜品销售分析，删掉总数据菜品销量。
- 前端 frontend/src/views/analysis/BusinessAnalytics.vue：
  - 页签「菜品销量」在总数据视角改名为「菜品销售分析」（外卖/团购平台看板仍叫「菜品销量」，未受影响）
  - 该页签内容换成菜品销售分析口径：菜品数/总销量/销售额/菜品收入/优惠金额/退款金额/预估成本(已绑定 x/y)/净收入 + 排序(按收入/销量/金额) + 服务端分页
  - 并入原总数据菜品销量的两项独有能力：来源订单明细展开（按 菜品编码+名称 从收银机品项明细取数）、行内绑定本地菜品 SKU（写 dish_sales_mappings，与「堂食菜品绑定」同表同唯一键）
  - 删除「经营总览」内重复的菜品销售分析面板（时段订单走势图保留）
  - 保留赠品维度：新增「赠品数量 / 赠品金额」两列与两张指标卡。dish_sales 表没有赠品列，故按 (菜品编码,菜品名称) 从同一批收银机品项明细（来源订单明细）汇总到菜品行上；口径与总数据菜品销量一致——赠品已含在销量/销售额内，只标注不重复相加
- server.js：GET /api/dish-sales/analytics 的列表行补充 mapping_id/menu_item_id/menu_sku_label/unit_cost 等已绑定 SKU 字段（原字段与 estimated_cost、net_income 口径不变），供行内展示与改绑使用
- 核验：_tmp/verify-dish-analytics-fields.js 直连库跑新 SQL（5/1-8/9 区间 mapped 行返回 sku="招牌烧鹅饭 · 常规"、unit_cost=13.5）；_tmp/verify-gift-join.js 核对赠品行级取数（9/10 超爽柠檬茶 11 份 / ¥88.00，与汇总一致）；_tmp/probe-total-dish.cjs 经 CDP 渲染总数据品牌/门店视角，页签=菜品销售分析、16 列表头（含赠品数量/赠品金额/净收入/退款金额）、展开列与绑定选择器各 20 个、来源明细可展开、无 console 错误；外卖平台视角仍为「菜品销量」

### 追加修正：本地菜品自动识别（不再要求「本地菜品绑本地菜品」）
问题：上线后总数据视角 361 行全部显示「选择本地菜品 SKU」——没有手工记录时只认 dish_sales_mappings，把本来就取自本地菜品库的品项当成未关联。
- server.js `/api/dish-sales/analytics` 改为两段式：SQL 只做分组汇总（不设 LIMIT，分组数在千级），本地 SKU 识别 / 排序 / 翻页在 JS 完成
- 识别优先级（与旧「总数据菜品销量」同一套规则）：手工绑定 → 菜品编码=menu_items.skuid（名称互校，防错归）→ 名称+规格唯一 → 名称唯一；手工绑定可指向已下架菜品，另按 id 补查
- 预估成本 / 净收入 /「已关联 x/y 款」随识别结果计算（口径不变：数量 × 单位成本；订单量仍走 SQL 全区间去重，不由分组相加）
- 排序：已关联在前，未关联自动沉到列表末尾（与外卖/团购看板对齐），再按收入/销量/金额倒序
- 前端：绑定列显示识别出的 SKU 名称，自动识别的按钮提示「已按菜品编码/名称自动识别，点击可改绑」；指标卡文案改为「已关联 x/y 款 · 含自动识别」
- 9/10 实测：361 分组自动识别 126 个（35%），预估成本 ¥23,242.20、净收入 ¥40,392.81（改前均为 0）；其余 208 个是外卖套餐/别名（如「限量!招牌烧鹅腿饭 [一人份]」「【太公烧鹅饭】含时蔬+海咸鸭蛋 [1人份]」），本地菜品库无此名称，**故意不做模糊自动绑**（会把套餐成本算错），仍走智能推荐人工确认
- 附带发现：部分已识别菜品在菜品管理里成本为 0（叉鸭双拼饭 / 太公烧鹅·半只 / 招牌烧鹅（约100克）），这几行净收入=收入，需补维护成本
- 核验：_tmp/verify-dish-automatch.js 直连库统计识别覆盖率；CDP 渲染三条路由各自独立会话：总数据品牌/门店页签=菜品销售分析且顶部行显示「招牌烧鹅饭 · 常规」「太公烧鹅 · 下庄 · 份」，外卖平台仍为「菜品销量」，均无 console 错误

## 2026-09-11 新增「菜品管理 → 菜品核算」（选门店+时间段反推禽类消耗只数）
背景：需要知道某门店某时间段大概消耗了多少只鹅/鸭/鸡。系统里只有菜品销量，没有任何「一份菜用掉多少只禽」的数据，所以先补三层基础档案再算。
> 位置说明：按需求暂挂「菜品管理」下，功能打通后整体迁往「成本核算」。

### 数据模型（lib/db.js 新增 4 张表）
三层模型，全部以「只」为最终锚点：
- `poultry_birds` 禽类档案：一只禽的品种/单只净重(kg)/单只成本/状态
- `poultry_yields` 整只出成拆解：一只禽出哪些部位、每个部位出几个（`parts_per_bird`）、单份克重
- `poultry_dish_usage` 菜品耗用：每份该菜品吃掉几个该部位（`usage_qty`），UNIQUE(menu_item_id,yield_id)，**一菜可挂多行 → 双拼/套餐/鸡鸭双拼天然支持**
- `poultry_purchases` 实际采购只数：手动录入，UNIQUE(store_id,month,bird_id)，用于理论 vs 实际对比

公式：`消耗只数 = Σ(菜品销量 × 每份耗用部位数 ÷ 一只出该部位数)`；折重 = 只数 × 单只净重；理论成本 = 只数 × 单只成本。

### 口径（已与业务确认）
- 退款行整体排除：`refunded IN ('部分退','是','1')` 不计入（报表只有退款金额、无退菜数量，无法精确扣减）
- 渠道由 `dish_sales.payment_detail` 关键字判定，优先级 **团购 > 外卖 > 堂食 > 其他**（「店内销售|收银POS|POS|抖音团购」属团购核销，不算纯堂食）
- ⚠️ 实测约 65% 销量（17.5 万份）的 payment_detail 形如「扫码支付-微信 25.00」，**不含渠道信息**，归入「其他/未分类」并在页面单独标注，不参与渠道筛选
- 只数保留 2 位小数；只数先定稿再由它推折重/成本，保证页面上「只数 × 净重/单价」能对上（行级舍入 vs 合计舍入会差出 0.6 元那类错位）

### 菜品匹配三级兜底（提升覆盖率）
① `dish_sales_mappings` 绑定 → ② 名称 + 归一化规格直配 → ③ 名称唯一命中 → ④ 计入「未绑定」清单。
两个易踩的坑已处理：
- **空菜名不得参与匹配**（报表/档案里的空名行会互相误挂）
- **孤儿绑定视为未绑定**：库里有 10 条 `dish_sales_mappings` 指向已被删除的菜品（旧库遗留，FK 未生效），否则缺口清单会出现没有菜品名、也无法去配置的空行；现已退回名称兜底，兜不住才按未绑定报出

### 后端
- 新模块 `lib/poultry-accounting.js`（三层档案 CRUD + 核算 + 采购对比 + Excel 模板/导入）
- `server.js` 新增 17 个 `/api/poultry/*` 接口：species CRUD、yields 整表保存、dish-usage（单菜品配置 + 全菜品总览 + 已配置列表）、accounting 主核算、accounting/purchase-comparison、purchases CRUD、template、import
- Excel 模板**预填本地全部菜品行**（只需补品种/部位/每份耗用），导入逐行容错：非法禽类值报错跳过、不存在品种/菜品报错回报、预填空行静默跳过

### 前端
- 新增页面 `frontend/src/views/menu/MenuAccounting.vue`：筛选条（门店/日期默认本月/渠道/禽类）→ 只数汇总卡（鹅鸭鸡各多少只+折重+成本）→ 覆盖率提示条（覆盖销量占比、未绑定/未配出成缺口下钻、>1只/份 复核提醒、渠道构成）→ 按菜品下钻表（每份折合只数、消耗只数、占比）→ 理论 vs 实际采购对比表 + 采购录入 → 基础档案抽屉（禽类档案/整只出成/菜品耗用三页签 + 模板下载 + 导入）
- 5 处注册：`router/index.js`（`/menu-management/accounting`）、`App.vue`（COMPONENT_MAP + 弹窗菜单「菜品数据」组 + **WORKSPACE_TAB_ROUTES** + **workspaceRouteTabId**）、`stores/app.js`（SUB_LABELS）、`MenuModuleHeader.vue`（navItems）
- 新增页面漏注册会「地址栏正确但内容区空白/落到数据概括」，详见下方修复第 1 条
- **迁移说明**：只需改 tab id 前缀 `menu-management-accounting` → `cost-accounting-accounting`、路由 path、文件目录，业务代码与接口无需改动（文件头已写迁移步骤）

### 同期修复的两个既有缺陷
1. **`App.vue` `workspaceRouteTabId` 漏登记独立静态路由**（本次由 UI 探针发现）：`/menu-management/accounting`（以及**既有的 `/menu-management/category`**）走的是静态路由而非 `:section` 通配，反查不到 tab id → 地址栏正确但**刷新/直接打开/分享链接时内容区落到数据概括**。已在 `workspaceRouteTabId` 的简单页面映射里补上这两条，并加注释提醒后续新增同类页面要同步登记。
2. 核算模块自身修掉的缺陷：采购对比按月录入却按 `YYYY-MM-01` 查询（永远查不到，对比恒为 0）；页面在「档案已加载但核算未返回」时会读空 `summary` 报错（已加结果守卫）；导入把非法禽类值（如「猪」）静默改写成「鹅」。

### 验证（`_tmp/verify-poultry.ps1`，43 项全部 PASS，跑完自动清理）
- 公式对照：招牌烧鹅饭 9806 份 ÷ 出成 16 = **612.88 只**；折重 2757.96kg = 612.88×4.5；成本 ¥73,545.60 = 612.88×120
- **独立交叉核对**（`_tmp/crosscheck-poultry.js` 直连库用 sql.js 复算）：博罗店 201 份 → 12.56 只、全区间总销量 269,135.14、四个渠道 174801.1/62711.48/24635.57/6987 与接口逐项完全一致
- 门店/渠道筛选、采购同键覆盖与整月判定、Excel 三页签真实导入（含错误行回报）、一菜挂鹅+鸭两行（鸭 9806÷2 = 4903 只）
- 数据库已验证回到空态（species/yields/configured/purchases 全 0），未残留测试数据
- ⚠️ **未经真实浏览器渲染验证**：本机沙箱阻止 Chrome（CDP 端口起不来、headless 无法写文件），页面渲染只在构建层面确认过（vite 编译通过、产物含全部页面与接口路径、路由返回 200、无 console 异常无从取得）。UI 探针脚本 `_tmp/probe-accounting-ui.cjs` 已写好，在非沙箱环境可直接跑（先以 `--remote-debugging-port=9335` 启动 Chrome）

### 追加优化：菜品耗用改为「分组选菜 + 批量关联」（2026-09-11 同日）
问题：160 个菜品平铺在一个列表里逐个配耗用，实际同一分组的菜（如「烧鹅·濑粉」30 个）通常用同一套部位耗用，逐个点太慢。
- 后端 `listUsageOverview` 增加**分组（菜品分类）筛选**并返回每个分组的「已配置/总数」进度 + `all_total`；分组进度基于全部菜品统计，不受关键词/分组筛选影响，左侧分组条进度始终稳定
- 新增 `POST /api/poultry/dish-usage/batch`（`lib/poultry-accounting.js` 的 `batchSaveUsage`）：把同一套「部位 × 每份耗用」套用到多个菜品
  - `mode=replace` 覆盖：先清空这些菜品的原有配置（适合整组用同一套部位），并**回报被清掉的条数 `removed` / 受影响菜品数 `replaced_dishes`**，避免静默删掉手工配置
  - `mode=append` 追加：upsert 保留原配置（适合给已有配置的菜再加一条双拼部位）
  - 校验：空菜品列表 / 空耗用行 / 无效部位 / 耗用量≤0 / 同一部位重复 / 菜品不存在 均按 400 拒绝；单次上限 300 菜品、30 条关系
- 前端 `MenuAccounting.vue`「菜品耗用」页签：**分组选择条**（每个分组显示 `已配置/总数`，配满打 ✓）→ 关键词 + 状态筛选 → 表格加 **多选列** → 勾选后出现**批量操作条**（已选 N 个 / 选中本组全部 / 清空选择 / 批量关联禽类耗用）→ 批量弹窗（**应用方式：覆盖 / 追加** 用 el-segmented，逐行配部位×耗用，实时折算「每份 X 只」，底部预览将套用到哪些菜品）。单个菜品仍可「编辑」精调
- 细节：批量弹窗会**取选中项里第一个已配置的菜品作为初值**，减少重复录入；切换分组/筛选会**自动清空勾选**，避免把上一次的选择连同新条件一起提交
- 验证：`_tmp/verify-poultry-batch.ps1`，**31 项全部 PASS**（自清理），覆盖分组统计=160、分组筛选无越界、覆盖/追加两种模式、覆盖时 `removed`/`replaced_dishes` 回报、6 项参数校验、以及批量结果参与核算与手算对照（1273.15 份 ÷ 出成 4 = 318.29 只）；原 `_tmp/verify-poultry.ps1` 43 项回归仍全部 PASS

### ⚠️ 事故与修复：验证脚本曾整表清空用户数据（2026-09-11）
现象：验证脚本为了「可重复执行」，收尾时执行了**整表删除**（所有禽类档案 / 所有已配置的菜品耗用 / 所有采购记录），把用户在此期间手工录入的数据一并删掉了。
- 已定位责任范围：**只影响 `poultry_birds` / `poultry_yields` / `poultry_dish_usage` / `poultry_purchases` 四张新表**。`menu_categories`（菜品分类）与 `menu_items` 全程未被本功能的任何代码写入或删除 —— 与 12:30 备份逐行比对，160 个菜品及其分组完全一致，分类仅少一个 `#24 外卖菜品`（非本功能所致，本功能没有任何删除分类的调用路径；排序接口还带「必须提交全部分类完整排序」的校验且只 UPDATE 不 DELETE）。
- 已修：两个验证脚本改为**最小回收** —— 只删按名称前缀（`验证用*` / `批量验证用*` / 金丝雀）自己建的行，采购按 remark 标识回收；对真实菜品的耗用配置改为**先快照、收尾原样还原**；断言由「整表为空」改成「与基线一致」。
- 已证明：`_tmp/canary-safe-teardown.ps1` 先埋一份「用户数据」（禽类+出成+挂在 206 上的耗用+采购），再跑两个验证脚本，结果金丝雀**全部存活且数值未变**（禽类/出成/耗用 usage_qty=2/采购 555 均保留），脚本自身数据全部回收。
- 教训：**验证脚本绝不允许整表 DELETE**；沙箱里脚本可能被中断在收尾之前，所以「收尾」不能是唯一的清理屏障，删除范围必须一开始就限定在自己创建的行上。

### 部署记录：菜品核算上线云端（2026-09-11 17:05）
- 脚本 `_deploy-poultry.ps1`（logs: `_deploy_poultry_log.txt`）。上传：`server.js`、`lib/db.js`、`lib/poultry-accounting.js`（新增）、`lib/business-analytics.js`、`PROJECT_CHANGES.md`、`frontend/dist`（先清旧目录）、`frontend/src`。
- **刻意未上传**：`config.json`（云端凭据）、`data/database.sqlite`（云端业务数据）。云端新表由服务启动时的 `createTables()` 自动创建。
- 云端备份：`server.js.bak-20260911170553`、`lib/db.js.bak-…`、`lib/business-analytics.js.bak-…`、`PROJECT_CHANGES.md.bak-…`、`data/database.sqlite.bak-cloud-20260911170553`。
- 上线前差异核对：先用 md5 + 行级 diff 确认云端没有本地缺失的实现（云端多出的 11 行 server.js / 6 行 business-analytics.js 经核对都是**已被本地重写掉的旧版本片段**）；`db.js`、`PROJECT_CHANGES.md`、`frontend/src` 云端独有内容为 0。**结论：本地为严格更新的版本，覆盖安全。**
- 上线后验证：服务 active；4 张表已建且唯一键 `UNIQUE(menu_item_id, yield_id)` 正确；公网 `GET /api/poultry/{species,dish-usage,accounting,template}` 全部 200 且返回正常（分组 11 个 / 菜品 160 个 / 模板 77,668 base64）；页面 `/menu-management/accounting` 200 且引用新分包 `MenuAccounting-BmQr6aPu.js`；**15 个既有接口（门店/菜品/销售分析/绑定/成本构成/记账/协同/人事/用户/看板/业务分析/推送/机器人）全部正常**，未影响线上。
- ⚠️ **云端数据缺口（需业务决定）**：云端 `dish_sales` 仅覆盖 **2026-05-01 ~ 2026-08-09**（190,437 行），而本地已到 **2026-09-10**（229,613 行）。因此菜品核算在云端目前只能算到 8/9，算 8 月整月或 9 月会缺数据。**不要直接上传本地 database.sqlite 覆盖云端库** —— 云端的用户、协同事项、记账等是线上持续写入的，覆盖会丢（本项目历史上就出现过上云后要单独恢复云端用户的情况）。建议只补 8/10–9/10 的销量数据（走收银 POS 导入，或做一次只针对 `dish_sales` 的定向同步）。

### 修复：追加出成部位后，「菜品耗用」选不到新部位（2026-09-11）
现象（用户报告）：把一只鹅拆成 4 个规格并绑好菜品后，返回「整只出成拆解」追加 2 个规格，再回到「菜品耗用」，部位下拉里**看不到新增的 2 个规格**。
- 根因（纯前端缓存）：`MenuAccounting.vue` 里部位下拉的数据源是 `yieldOptions`，它只在页面挂载时加载一次；`saveYields()`（保存出成）后只刷新了出成表格与禽类档案，**没有刷新 `yieldOptions`**；而 `openUsageDialog` / `openBatchUsageDialog` 又写成「仅当列表为空时才去拉取」，导致一旦加载过就永远是旧快照。
- 修复（4 处，让数据源始终同步）：
  1. `saveYields()` 保存后追加 `await loadYieldOptions()`
  2. `openUsageDialog` / `openBatchUsageDialog` 改为**每次打开都重新拉取**（不再依赖空判断）
  3. `openArchive()` 打开抽屉时刷新部位下拉
  4. 新增 `onArchiveTabChange`：抽屉内切到「整只出成」重读出成表、切到「菜品耗用」重读部位下拉 + 耗用总览 —— 覆盖「在抽屉内来回切页签」这条路径
  5. 附带：`removeBird` 删品种后会级联删出成，一并刷新部位下拉，避免留下指向已删部位的失效选项
- 顺带优化：部位下拉改为按「禽类 · 品种」分组的 `el-option-group`（一个品种挂十来个部位时平铺很难找），并同步用于单个配置与批量关联两个弹窗
- 验证：`_tmp/verify-yield-append.ps1` 复现用户场景（自建临时禽类+临时菜品，收尾全回收），**11 项全部 PASS**：4 规格保存 → 绑定菜品 → 追加到 6 规格 → 接口回读 6 个部位 → **下拉数据源含全部 6 个且新规格 id/出成有效** → 原有绑定未丢失 → 新规格可直接绑定（双拼式两行）。结论：后端数据完全正确，问题只在前端缓存。
- 已部署：云端只更新 `frontend/dist` 与 `frontend/src`（后端无需改动），新分包 `MenuAccounting-J3jY6qQr.js`，公网校验通过。

### 口径重构：料篮模型（2026-09-11，用户反馈「鹅头带颈 + 战斧饭 = 3 只鹅」不合理）
问题（用户实测）：一只鹅身上同时产出 2 份上庄 / 2 份下庄 / 2 条腿 / 2 只翅 / 1 个头颈 / 11 份肉，但旧公式是 `Σ(各菜品销量 × 每份耗用 ÷ 一只出成)`，等于**每个菜品各自买一只鸟**，把同一只鸟的多个部位重复计了鸟。实测 11,000.26 只，按料篮算只有 6,586.74 只（多算 1.67 倍）。

- **正确模型**：
  - **身体部位**（上庄/下庄/腿/腩/切片肉/整只/半只）＝ 同一块身体的不同卖法，互相抢鸟 → 需求**相加**
  - **副产品**（翅/头颈/掌/杂）＝ 随鸟附带产出，不额外占鸟 → 需求**取最大**；只有超过身体需求时才成为瓶颈
  - `只数 = max(身体各部位折鸟数之和, 各副产品折鸟数)`
  - 边界：全部取最大也会错（把互斥的整只/半只当成同一批鸟，7,497 只严重偏低）
- `lib/db.js`：`poultry_yields` 新增 `part_kind`（身体/副产品），并按部位名自动预判做迁移（翅/战斧/头/颈/掌/爪/杂/肝/肠/汁 → 副产品），用户无需重录
- `lib/poultry-accounting.js`：核算改为按「禽 + 部位」汇总需求再套料篮模型；返回新增
  - `summary.birds[].body_birds / byproduct_birds / governing / governing_part`（说清瓶颈在身体还是副产品）
  - `summary.birds[].birds_count_linear`、`summary.total_birds_linear`（旧口径参考值）
  - `parts[]` 部位汇总（部位/类别/一只出成/总需求/折鸟数/是否瓶颈）
  - 明细行带 `part_kind` 与 `bird_id`
- 页面：筛选条公式说明改为料篮口径；新增「按部位汇总 · 瓶颈在哪」面板（含**口径对照条**：新口径主数 + 旧口径参考值及多算倍数）；「整只出成」表格新增**部位类别**下拉 + 类别含义图例
- **验证**：`_tmp/verify-poultry.ps1` 重写为**非破坏性**（只用自建临时禽类 + 临时菜品，核算公式改为只读校验内部不变量），**49 项全部 PASS**：每行只数 = 销量×每份耗用÷一只出成（59 行一致）、部位折鸟 = 总需求÷出成（12 个一致）、`只数 = max(身体相加, 副产品最大)`（逐禽一致）、合计 = 逐禽之和、每种禽唯一瓶颈标注、旧口径 ≥ 新口径、占比合计 100%、临时数据不污染结果；`_tmp/verify-poultry-batch.ps1` **29 项全 PASS** 回归

### 顺带修掉项目级隐患：ON DELETE CASCADE 实际未生效
排查删品种被拦时发现：`lib/db.js` 里的 `PRAGMA foreign_keys=ON` **没有真正生效**（实测 `PRAGMA foreign_keys` 返回 0），因此全库所有 `ON DELETE CASCADE` 都不会执行。这是**既有问题**，也解释了之前 `dish_sales_mappings` 里那 10 条指向已删菜品的孤儿绑定。
- 影响本功能：删除菜品后 `poultry_dish_usage` 会残留孤儿行，导致 ① 品种的「挂菜数」虚增 ② 删品种时报「已被 N 个菜品引用」而那个菜品其实已不存在
- 处理（不改动全局，避免波及其它模块）：新增 `purgeOrphanUsage()`，在 `deleteBird` / `deleteYield` 前显式清理孤儿行；`listBirds` 的挂菜数改为 JOIN `menu_items` 只算还存在的菜品；`configured_dish_count` 同样过滤
- **建议后续单独处理**：全库启用外键（或给 `menu_items` 的删除接口补显式清理），并清理历史遗留的孤儿 `dish_sales_mappings`

### 部署记录（2026-09-11 17:4x，料篮模型 + 部位类别）
- 上传：`lib/db.js`、`lib/poultry-accounting.js`、`PROJECT_CHANGES.md`、`frontend/dist`（先清旧目录）、`frontend/src`；后端无 `server.js` 改动
- 云端新表由启动时 `createTables()` 自动补 `part_kind` 列并执行迁移
- 上线前同样先做差异核对，`_deploy-poultry.ps1` 已保留全部备份路径可回滚
