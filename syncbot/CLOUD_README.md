# 中控同步机器人（zhongkong-sync-bot）

为现有中控项目（`/home/ubuntu/app`，`zhongkong.service`，端口 3456）配套的**独立平台报表同步机器人**。
目标：Playwright 驱动真实 Chromium，自动导出美团管家等平台报表 → 调用现有项目导入逻辑 → 校验 → 条件满足时推送日报。

> 当前进度：**阶段0（基础环境）**。
> 本阶段只搭环境：浏览器能启动、能人工登录、能截图，**不含任何平台页面自动化、不含导入、不含推送、不含定时任务**。

---

## 1. 与现有中控项目的隔离关系

| 维度 | 现有中控项目 | 同步机器人（本项目） |
|---|---|---|
| 代码目录 | `/home/ubuntu/app` | `/opt/zhongkong-sync-bot/app` |
| Linux 用户 | `ubuntu` | `syncbot`（无 sudo、无特权组、口令锁定） |
| systemd | `zhongkong.service` | `syncbot-*.service`（独立 unit） |
| Node 依赖 | `/home/ubuntu/app/node_modules` | `/opt/zhongkong-sync-bot/app/node_modules` |
| 浏览器登录态 | 无 | `/opt/zhongkong-sync-bot/browser-profiles/meituan`（0700） |
| 下载文件 | 无 | `/opt/zhongkong-sync-bot/downloads/meituan/` |
| 日志 | `journalctl -u zhongkong` | `/opt/zhongkong-sync-bot/logs/`（JSONL，自动脱敏） |
| 状态/锁 | 项目自有 | `/opt/zhongkong-sync-bot/state/` |
| 数据库 | `data/database.sqlite` | **不直接访问任何数据库**，只调用项目导入 API/服务函数 |

阶段0 **未修改**：`zhongkong.service`、nginx 配置、`/home/ubuntu/app` 任何文件、数据库、现有启动方式。

## 2. 目录结构

```
/opt/zhongkong-sync-bot/
├─ app/                       # 脚本与依赖
│  ├─ src/                    # paths / logger / lock / state / archive / config / browser / status / selftest
│  ├─ bin/                    # syncbot CLI、env-check.sh
│  ├─ systemd/                # 已安装的 5 个 service 源文件
│  └─ systemd/phase5-timers-not-installed/   # 阶段5 timer 模板（未安装）
├─ browser-profiles/meituan/  # 持久化 Profile + 登录态（0700，绝不可外传）
├─ downloads/meituan/         # 原始报表归档（YYYY-MM-DD/，保留 ≥90 天）
│  └─ _incoming/              # 下载临时落地区（等 .crdownload 消失后才归档）
├─ screenshots/YYYY-MM-DD/    # 执行截图
├─ logs/                      # 任务日志（JSONL，按天分文件，自动脱敏）
├─ state/
│  ├─ tasks/                  # <platform>-<YYYY-MM-DD>.json 任务状态与闸门
│  ├─ locks/                  # 防并发锁
│  ├─ runtime/                # 浏览器运行态（pid 等）
│  └─ secrets/                # X11 xauth cookie、VNC 口令（0600，仅 syncbot 可读，不入库）
└─ config/                    # 非敏感配置
```

## 3. 服务与端口

| unit | 用途 | 开机自启 | 监听 |
|---|---|---|---|
| `syncbot-xvfb.service` | 虚拟显示器 `:99`（1600x1000x24） | 是 | unix socket `/tmp/.X11-unix/X99` |
| `syncbot-wm.service` | fluxbox 窗口管理器 | 是 | - |
| `syncbot-vnc.service` | x11vnc 共享 `:99` | 是 | **127.0.0.1:5901** |
| `syncbot-novnc.service` | noVNC / websockify | 是 | **127.0.0.1:6080** |
| `syncbot-browser.service` | Playwright 持久化 Chromium（有界面） | **否（人工按需启动）** | - |

安全约束：5901/6080 **只绑定 127.0.0.1**，公网无法访问，只能经 SSH 隧道；
即使云安全组误开放这两个端口，外网也连接不上。

## 4. 常用操作

### 4.1 启动浏览器

```bash
# 在服务器上（以 ubuntu 用户）
sudo systemctl start syncbot-xvfb.service syncbot-wm.service   # 首次或重启后
sudo systemctl start syncbot-browser.service                    # 启动浏览器

# 或使用 CLI
/opt/zhongkong-sync-bot/app/bin/syncbot browser-start
```

浏览器以**有界面**方式运行在 Xvfb `:99` 上，Profile 持久化在
`/opt/zhongkong-sync-bot/browser-profiles/meituan`，登录一次后下次复用。

### 4.2 停止浏览器

```bash
sudo systemctl stop syncbot-browser.service
/opt/zhongkong-sync-bot/app/bin/syncbot browser-stop      # 等价
# 全部停止（含显示与 VNC）
/opt/zhongkong-sync-bot/app/bin/syncbot display-down
```

浏览器进程收到 SIGTERM 会优雅关闭 Profile，不会损坏登录态。

### 4.3 通过 SSH 隧道进入 noVNC（人工登录美团）

在**你自己的电脑**上执行：

```bash
ssh -i F:\NewDeom\server-access\zhongkong_company -N -L 6080:127.0.0.1:6080 ubuntu@134.175.41.247
```

（macOS/Linux 把密钥路径换成 `~/.../zhongkong_company`；Windows 用 PowerShell 同样命令）

然后本机浏览器打开：

```
http://127.0.0.1:6080/vnc.html?host=127.0.0.1&port=6080
```

再输入 VNC 口令（见 4.4），即可看到 Xvfb 桌面与 Chromium 窗口，
自行完成账号登录、扫码、短信验证、以及后续人工查找报表。

> 一次性把隧道跑在后台（PowerShell）：
> `Start-Process ssh -ArgumentList '-i','F:\NewDeom\server-access\zhongkong_company','-N','-L','6080:127.0.0.1:6080','ubuntu@134.175.41.247'`

### 4.4 获取 / 修改 VNC 口令

口令由安装脚本随机生成，**不写入代码、Git、日志、截图或普通配置文件**，仅存在于：

```
/opt/zhongkong-sync-bot/state/secrets/vnc-passwd   （0600，owner=syncbot）
```

该文件是 `x11vnc -storepasswd` 的二进制格式，不能用文本方式读取。取回明文口令的官方方式：

```bash
# 在服务器上执行；明文只打印到你的 SSH 终端，不落盘、不进日志
sudo /usr/bin/x11vnc -showrfbauth /opt/zhongkong-sync-bot/state/secrets/vnc-passwd
```

（若该 x11vnc 版本不支持 `-showrfbauth`，直接重设一个新口令即可：）

```bash
sudo -u syncbot env HOME=/home/syncbot x11vnc -storepasswd '新的强口令' /opt/zhongkong-sync-bot/state/secrets/vnc-passwd
sudo chmod 600 /opt/zhongkong-sync-bot/state/secrets/vnc-passwd
sudo systemctl restart syncbot-vnc.service
```

> 注意：用 `x11vnc -storepasswd '口令' 文件` 这种带参数形式时，shell 历史可能记录口令。
> 更稳妥的写法是先 `HISTCONTROL=ignorespace` 并在命令前加空格，或交互式执行
> `sudo -u syncbot x11vnc -storepasswd /opt/.../vnc-passwd`（不带参数，提示输入两次）。

### 4.5 诊断

```bash
/opt/zhongkong-sync-bot/app/bin/syncbot status      # 总览
/opt/zhongkong-sync-bot/app/bin/syncbot env         # 环境自检
/opt/zhongkong-sync-bot/app/bin/syncbot logs 80     # 最新日志
/opt/zhongkong-sync-bot/app/bin/syncbot locks       # 查看并发锁
/opt/zhongkong-sync-bot/app/bin/syncbot shots       # 最近截图
/opt/zhongkong-sync-bot/app/bin/syncbot disk        # 占用 + 保留策略预览（不删除）
```

## 5. 基础框架能力（阶段0 已实现并自检通过）

| 能力 | 实现位置 | 说明 |
|---|---|---|
| 结构化日志 | `src/logger.js` | JSONL 按天分文件；**自动脱敏** password/secret/token/cookie/session/verify/captcha/webhook/apikey/sign/credential 等字段与 URL 参数 |
| 防并发锁 | `src/lock.js` | 原子创建锁文件；崩溃残留锁按 PID 存活 + 6h 超时自动接管；`LockBusyError` 明确拒绝并发 |
| 任务状态 | `src/state.js` | `state/tasks/<platform>-<日期>.json`，含 download/validate_file/import/validate_import/push 五段状态、attempts、失败原因与证据；`canPush()` 闸门 |
| 文件归档 | `src/archive.js` | 统一命名、sha256、同内容去重、**同名不同内容另存不覆盖历史**、`.crdownload` 未完成识别、90 天保留策略（默认 dry-run） |
| 浏览器 Profile | `src/browser.js` | Playwright persistent context + headed Chromium；防重复启动；运行态记录；SIGTERM 优雅关闭 |

自检：`cd /opt/zhongkong-sync-bot/app && node src/selftest.js`

## 6. 安全规则（必须遵守）

1. 美团账号只用具备「报表查看/下载」权限的**专用账号**，最小权限。
2. 不尝试绕过验证码、短信、扫码或任何平台安全机制；登录失效只记录异常并通知人工。
3. 不添加任何隐藏自动化特征 / 反检测绕过参数；使用真实 Chromium + 正常配置。
4. 凭据（账号口令、Cookie、企业微信 key、AI Key）**不得**写入代码、Git、截图、日志或 `config/*.json`；
   需要凭据时使用 `EnvironmentFile`（0600）或人工交互输入。
5. `browser-profiles/`（含登录 Cookie）权限 0700，禁止打包、复制到项目目录或提交 Git。
6. 5901/6080 只允许回环监听；远程桌面一律经 SSH 隧道。
7. 不直接写 SQLite 或任何数据库；所有数据必须经现有项目的导入 API/服务函数。
8. 任何校验失败：保留原始文件/日志/截图，标记失败，**不覆盖历史正确数据，不触发推送**。

## 7. 已知限制与已接受风险（阶段0 实测结论）

### 8.1 Chromium 沙箱处于关闭状态（**需要你知情**）
- Playwright 默认 `chromiumSandbox: false`，因此实际命令行含 `--no-sandbox`。
- 实测**无法开启**：本机 `kernel.apparmor_restrict_unprivileged_userns = 1`（Ubuntu 24.04 默认），
  非特权 user namespace 被禁止（`unshare --user` 报 `Operation not permitted`），
  以 `chromiumSandbox: true` 启动实测失败。
- 未采用的替代方案及原因：
  1. 把 `chrome-sandbox` 设为 `root:root 4755`：该二进制位于 syncbot 家目录（syncbot 可写），
     等于给 syncbot 提权到 root，**安全上更糟**，拒绝；
  2. 全局 `sysctl kernel.apparmor_restrict_unprivileged_userns=0`：削弱整机安全并影响现有项目，拒绝。
- 现有缓解措施：专用低权限账号（无 sudo、无特权组、口令锁定）、浏览器只用于美团报表页、
  不浏览任意外部链接、Profile 与项目完全隔离、VNC 仅回环 + 口令。
- **阶段2 前需你确认是否接受**；如需更严方案，可评估「独立只读挂载的 Chromium 副本 + setuid 沙箱」。

### 8.2 x11vnc 会额外监听一个 IPv6 回环 socket
- 实测监听：`127.0.0.1:5901`（服务端口）+ `[::1]:5900`（x11vnc 0.9.16 固定额外创建）。
- 已实测 `-no6`、`-noipv6`、`-unixsock`+`-rfbport 0`（完全不监听 TCP）**均无法消除**该 socket，
  只能通过 `-localhost` 把它限制在 IPv6 回环地址。
- 风险结论：两个地址都是回环地址，任何网卡/公网均不可达；本机也无全局 IPv6 地址；
  该 socket 同样受 `-rfbauth` 口令保护。**不构成公网暴露**。

### 8.3 内存占用与共存建议
| 组件 | 实测内存 |
|---|---|
| syncbot-browser（Chromium 全套） | 308 MB |
| syncbot-xvfb | 33 MB |
| syncbot-novnc | 22 MB |
| syncbot-vnc | 9 MB |
| syncbot-wm | 3 MB |
| **合计** | **约 375 MB** |

系统总内存 3.6 GB，现有中控项目占约 1.5 GB，浏览器启动后可用内存约 1.7 GB。
设计上 `syncbot-browser.service` **不设开机自启**，空闲即停，避免长期占用；
阶段2 起如遇 Meituan 报表页较重导致内存上涨，浏览器服务上限为 `MemoryMax=1500M`。

### 8.4 其它实测说明
- apt 安装 `novnc/websockify` 时依赖拉入了 `nodejs 18`（`/usr/bin/node`）。
  `/usr/local/bin/node`(v22.23.2) 仍在 PATH 之前，**现有项目与机器人都使用 v22**，已核实。
- `playwright install-deps` 触发 needrestart，重启了 `udisks2.service`；
  `zhongkong.service` 与 `nginx.service` **未被重启**（已通过 `ActiveEnterTimestamp` 前后一致核对）。
- `xauth` 文件只有一条 `VM-0-10-ubuntu/unix:99` 条目：`xauth add :99` 会被规范化为该形式；
  X 认证工作正常（Chromium 已成功连接 `:99` 并显示窗口）。
- 额外补装了桌面截图工具链 `x11-apps`(xwd) + `netpbm`(xwdtopnm/pnmtopng)，
  用于本阶段取证与后续阶段「页面异常截图」复用（Playwright 页面截图之外，还能抓整屏含浏览器外框）。

---

## 8. 阶段路线（未完成项，需人工逐阶段确认）

| 阶段 | 内容 | 状态 |
|---|---|---|
| 0 | 基础环境（本文件） | 已完成，待人工确认 |
| 1 | 人工在 noVNC 登录、确认报表路径/筛选/表头/字段含义，保存样本 Excel，对照项目代码找出导入接口 | 未开始 |
| 2 | 手工触发的下载机器人（选择业务日期 → 立即测试下载，不导入不推送） | 未开始 |
| 3 | 接入现有项目导入逻辑 + 导入前后校验 | 未开始 |
| 4 | 日报推送联调（测试企业微信群） | 未开始 |
| 5 | 启用 systemd timers（01:05 / 01:30 / 08:40 / 09:00） | 未开始（模板已备，未安装） |

禁止事项（阶段0 严格遵守）：未创建任何定时任务；未猜测美团任何路径/元素/下载方式；
未执行任何自动下载；未调用项目导入接口；未调用日报或企业微信推送；未修改项目数据库；
未向公网开放 6080/5901。

---

## 9. 阶段1 补充：下载落盘命名、样本只读留档、权限模型

### 9.1 目录权限模型（阶段1 收紧）

| 目录 | 权限 | 说明 |
|---|---|---|
| `app/`、`config/` | `0755` / 文件 `0644` | 脚本与非敏感配置 |
| `downloads/`、`downloads/meituan/`、`downloads/meituan/_incoming/` | `0750` | **原始报表：syncbot 可读写，其它普通用户不可读不可列** |
| `screenshots/`、`logs/`、`state/`、`state/tasks/`、`state/locks/`、`state/runtime/`、`state/samples/` | `0750` | 业务证据与状态 |
| `browser-profiles/`、`browser-profiles/meituan/` | `0700` | 登录态 / Cookie |
| `state/secrets/`（`x11-xauth`、`vnc-passwd`） | `0700` / 文件 `0600` | 凭据 |

因业务目录为 0750，`syncbot` CLI 会在检测到免密 sudo 时**自动以 root 重新执行自身**（只读诊断与 systemctl 都需要）。
原始报表**不会被任何程序自动清理**：`archive.cleanup()` 与 `logger.cleanupOldLogs()` 只能被人工显式调用，且默认 `dryRun: true`，当前无任何调度器引用它们。

### 9.2 下载落盘命名（阶段1 实测必需，可配置关闭）

**实测结论（三方案对比探针，非美团页面、仅本地合成链接）**

| 方案 | 结果 |
|---|---|
| Playwright 默认（`acceptDownloads` + `downloadsPath`，无 `download` 监听） | 文件以**随机 GUID** 命名落入 `_incoming`，真实文件名只在 `suggestedFilename()` 元数据里；且**未被 `saveAs` 认领的下载会在 context 关闭时被删除** |
| 加被动 `download` 监听 + `saveAs(suggestedFilename)` | ✅ 落盘为原始文件名（中文正常），GUID 临时文件被清理 |
| `acceptDownloads: false`（期望 Chromium 原生下载） | ✗ 仍被 Playwright 拦截，文件被丢弃，拿不到真实文件名 |

因此 `config/browser.config.json` 使用 `"downloadNaming": "suggested"`；`src/browser.js` 中的处理器是**被动式**的：
不访问任何页面、不含任何选择器、不点击任何按钮、不发起任何下载，仅在**人工（或后续阶段）已触发下载**时把文件
按浏览器给出的原始文件名另存进 `_incoming/`（含路径穿越防护、同名自动加时间戳、SHA 无关的只读落盘），
并写一条 `browser.download_saved` 日志记录原始文件名/大小/时间。设为 `"raw"` 可关闭（回到 GUID 行为，仅供排查）。

### 9.3 样本只读留档（阶段1 交付物）

```bash
# 人工在 noVNC 中完成导出后执行一次（会先抓一张含浏览器窗口的 :99 截图，再做只读留档）
sudo /opt/zhongkong-sync-bot/app/bin/sample-intake.sh
```
产出：原始文件名 / 完整路径 / 大小 / 创建与修改时间 / **SHA-256** / 是否仍存在 `.crdownload` /
xlsx 工作表清单与逐列表头（含每列的类型推断，用于识别日期列·门店列·订单列·金额列）。
清单位于 `state/samples/intake-<时间戳>.json`。

**只读保证**：不移动、不改名、不删除样本；不写入任何数据库；不调用项目导入、日报或企业微信推送；不创建任何定时任务。

### 9.4 部署流程教训（已固化到工具链）

1. **禁止用 `ssh 'sed -i "s/\r$//"'` 做换行归一化**：远端 bash 会把双引号内的 `\r` 解析成 `r`，
   命令实际变成 `s/r$//`，从而删掉每行末尾的字母 `r`（曾把 `ThreadingHTTPServer` 改成 `ThreadingHTTPServe` 导致探针启动失败）。
   本仓库源文件均为纯 LF，无需归一化。
2. `deploy-00.ps1` 改为**逐字节 sha256 比对**（上传后比对暂存目录，任何差异立即中止部署）。
3. **不要用源文件覆盖服务器上由 npm 管理的 `package.json`**：曾因覆盖导致 `npm install` 把 `playwright` 当多余包删除。
   现在 `app/package.json` 明确声明 `playwright@1.63.0` 与 `xlsx@0.18.5`，`npm install` 幂等，安装脚本会校验两者可 `require`。
