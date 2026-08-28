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
