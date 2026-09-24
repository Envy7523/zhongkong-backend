# 上云 parity 与 dist 残留清理 · 判定依据留档

> 记录时间：2026-09-19
> 场景：本地与云端代码对齐后的收尾——parity 核对、dist 历史残留回收、游离副本归档
> 参与：本机（Windows 开发源）负责构建与静态判定；云服务器侧负责推送、归档、重启、冒烟

---

## 0. 一句话概括

一轮"代码上云"的收尾里踩了**两个会误导判断的坑**，都值得写下来：

1. **BFS 起点决定"被引用"判定** —— 旧构建的入口 chunk 仍躺在磁盘上，它 import 着 30 个旧 chunk；
   从现役 `index.html` 出发看是"全部未引用"，从全目录反向搜却是"30 个仍被引用"。二者都对，判据在**链的根**。
2. **脚本报告里出现非 ASCII 文件名必须转义** —— 报告里把中文文件名显示成 `?`，
   结果被当成 ASCII 通配去对号入座，得出"推送后反而线上缺失"的错误结论，白排查一轮。

---

## 1. 坑一：BFS 起点决定"被引用"判定

### 现象

清理 `frontend/dist/assets` 历史残留时，两套算法给出相反结论：

| 算法 | 起点 | 结论 |
|---|---|---|
| 开发源脚本 | 现役 `index.html` 做 BFS（含动态 import / modulepreload / CSS url()） | 32 个"未被引用" |
| 复核脚本 | 全目录反向 grep 该文件名 | 32 个里 **30 个"仍被引用"** |

### 根因

```
现役 index.html  →  index-BPWElJ-G.js   （现役入口，34 个引用）
                    ↑ 无人引用
旧入口 index-BAJWl12K.js  →  import 了 31 个旧 chunk（pinia / vue-router / echarts / 各页面 chunk…）
```

旧入口文件**没有被删除**，所以「旧入口 → 31 个旧 chunk」这条链在磁盘上依然成立。
反向 grep 会找到引用者（就是旧入口本身），于是判"被引用"。

### 正确判据

**看链的根有没有被现役入口引用，而不是看链内互相引用。**

```bash
# 关键判定：旧入口是否还被任何东西引用
grep -rl --binary-files=without-match -F 'index-BAJWl12K' frontend/dist/
# 无输出 → 旧入口是孤立的根 → 整条链可回收
```

同时确认**没有第二个静态服务入口**会引用旧 chunk：

```bash
grep -nE 'proxy_pass|root|location' /etc/nginx/sites-enabled/*
# 本机结果：只有 proxy_pass http://127.0.0.1:3456;  → nginx 不直接提供静态文件，无第二份引用
```

### 结论与做法

32 个可回收，但**必须 mv 不 rm**，且**先移旧入口**（断链的根）：

```bash
cd /home/ubuntu/app/frontend/dist
DEST=/home/ubuntu/bak-archive/dist-stale-20260919
mkdir -p "$DEST"
mv assets/index-BAJWl12K.js "$DEST"/          # ① 先移根
mv assets/<其余 31 个> "$DEST"/                # ② 再移链上其余
ls assets | wc -l                              # 期望 54（= 现役构建的文件数）
```

还原：`mv $DEST/* assets/`（所以只能 mv）。

**实测结果**：assets 86 → 54（与本地 54 完全吻合），现役入口的 34 个引用抽查全部 200，未误删。

---

## 2. 坑二：非 ASCII 文件名必须 `\uXXXX` 转义

### 现象

云端排查脚本的输出把中文文件名显示成 `?`，操作方据此认为
`docs/miniprogram-handover.md`、`docs/poultry-body-map-design.md`
"推送后反而变成线上缺失"，并怀疑是 Windows tar 的中文名编码问题。

### 真相

**两个文件从来都在，且与本地逐字节一致**：

| 文件 | 线上 | 本地 |
|---|---|---|
| `docs/miniprogram-handover.md` | 20548 字节 / 346 行 / md5 `f8f153732d455e64` | 完全相同 |
| `docs/poultry-body-map-design.md` | 12890 字节 / 262 行 / md5 `942fca925cdf26d5` | 完全相同 |

用 `xxd` 看服务端文件名的十六进制，是标准 ASCII 短横线，**没有编码异常**：

```
[6d696e6970726f6772616d2d68616e646f7665722e6d64] miniprogram-handover.md
```

### 根因

不是文件集合筛选规则排除了非 ASCII 名，而是**报告里把 `?` 当 ASCII 通配去做名字匹配**，
于是既匹配不上线上、也匹配不上本地，就报成"两边都没有/线上缺失"。

### 规矩（建议固化）

- **凡是脚本输出的文件名、路径、标识符，一律转义成 `\uXXXX`**（或 JSON `ensure_ascii`）
- 判定"文件在不在"时，用**标准化后的键**比对，不要用人类可读的显示串
- 怀疑传输/编码问题时，第一件事是**取 md5 与字节数比对**，而不是看文件名渲染

### 顺带修正

非 ASCII 名文件被误判时，容易连带把"本地独有的中文 docs"数错。
本次**真正本地有、线上没有**的中文 docs 是两个：

- `docs/菜品销售分析-成本口径问题.md`（4982 字节）
- `docs/岗位权限长期迭代计划.md`（2395 字节）

推送时**逐个传，不走 tar**，规避中文名在打包环节的任何不确定性。

---

## 3. 游离副本的判定（归档前必须静态查引用）

服务器根目录有一批与 `lib/` 同名的旧副本。判定"是否游离"时要注意
**相对 require 的解析基准是"写这行代码的文件所在目录"**，不是项目根：

```
lib/poultry-accounting.js:22  require('./business-analytics')  → 解析到 lib/business-analytics.js ✅
lib/collab-repository.js:1    require('./db')                  → 解析到 lib/db.js ✅
```

所以根目录那 6 个同名文件**不会被加载**（启动命令是 `node server.js`，只加载根目录 server.js）。
精确匹配要用"限定边界"的正则，否则 `require('./lib/db')` 会被 `require('./db` 误命中：

```bash
grep -rnE "require\(['\"]\./db(\.js)?['\"]\)" --include=*.js server.js lib/*.js
```

**归档后必须重启 + 冒烟**：静态判定只覆盖静态引用，若存在动态拼接路径的加载方式会立刻暴露。

```bash
# 冒烟（本机执行，未登录）
curl -s -o /dev/null -w 'index=%{http_code}\n'     http://127.0.0.1:3456/
curl -s -o /dev/null -w 'config=%{http_code}\n'    http://127.0.0.1:3456/api/config          # 期望 401
curl -s -o /dev/null -w 'analytics=%{http_code}\n' http://127.0.0.1:3456/api/business-analytics/overview  # 期望 401

# 登录后业务接口（token 换出来后逐条打，期望全 200）
T=$(curl -s -X POST http://127.0.0.1:3456/api/auth/login -H 'Content-Type: application/json' \
     -d '{"username":"admin","password":"<口令>"}' | grep -o '"token":"[^"]*' | cut -d'"' -f4)
for p in "staff?page=1&page_size=1" "notifications/summary" "dish-sales/dish-analytics?page=1&page_size=1" \
         "positions" "stores?page=1&page_size=1" "business-analytics/sync-runs"; do
  printf '%-46s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T" "http://127.0.0.1:3456/api/$p")"
done
```

本次实测：9 个游离副本归档后 **8 个接口全 200、无 5xx**，冒烟 PASS，未触发回滚。

---

## 4. parity 的最终口径（结论）

| 类别 | 数量 | 内容 |
|---|---|---|
| MATCH | 172 | 项目代码全部一致 |
| DIFFER | **1** | `config.json` —— 运行时密钥，**双向排除**（拉下来会把线上密钥带到本地；推上去会把线上密钥冲掉） |
| SERVER_ONLY | 0 | 已全部归档到 `bak-archive/stray-20260919/` |
| LOCAL_ONLY | 5 | 本地探针杂物（`_jd_probe.js`、`_jd_verify.js`、`_jd_fill.js`、`_probe_pos.js`、`_cloud2_verify.js`），判定为不上云 |

**除 `config.json` 外，代码已完全一致。**

> parity 对比集合应显式排除 `.agents/**`、`.codewhale/**` 等 agent 工具目录——它们不是中控代码，
> 混进来会让 DIFFER 虚高（本次排除后有 91 个此类差异被剔除）。

---

## 5. 归档目录（可一键还原）

| 目录 | 内容 | 还原方式 |
|---|---|---|
| `/home/ubuntu/bak-archive/dist-stale-20260919/` | 32 个旧构建 chunk（含旧入口 `index-BAJWl12K.js`） | `mv <目录>/* /home/ubuntu/app/frontend/dist/assets/` |
| `/home/ubuntu/bak-archive/stray-20260919/` | 9 个游离副本 | `mv` 回原位（根目录 6 个 + `lib/server.js` 等） |

均为 **mv 未 rm**，可完整还原。

---

## 6. 同一批待办（与本文档相关的其它未决项）

- **`doc/菜品销售分析-成本口径问题.md`**：菜品成本口径修复与残留口径争议，待全盘检查时敲定
- **口令轮换**：线上 `admin` 仍为项目种子默认口令，需尽快更换
  （改密接口 `PUT /api/users/:id/password`，**不校验旧密码**、仅要求 ≥6 位、明文入参、MD5 存库）
- **dist 新鲜度**：线上 dist 与本地同源（入口同为 `index-BPWElJ-G.js`），但若要绝对确认，
  可在内存充足时重建一次并逐个 chunk 校验

---

## 7. 铁律（下次照做）

1. **清理顺序**：先移旧入口（链的根）→ 再移链上其余 → `ls | wc -l` 对数量 → 抽查现役引用 → mv 保底
2. **判定"未被引用"**：以现役入口可达集为准；同时确认没有第二个静态服务入口
3. **脚本输出**：非 ASCII 一律 `\uXXXX`；判定存在性用标准化键，不用显示串
4. **归档一律 mv**，并记下还原命令
5. **归档后必重启 + 冒烟**，静态判定不能替代运行时验证
6. **密钥类文件（`config.json`）双向排除**，不参与 parity
7. **构建与清理无依赖**（文件名不同不互删），但按"清理 → 构建 → 上传校验"顺序做，核对更省事
