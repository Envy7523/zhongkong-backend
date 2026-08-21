# 中控后台

企业微信集成中控台 —— 读取企业通讯录、智能表格数据，并通过 Webhook 推送到群聊。

前后端分离架构：HTML/CSS/JS 前端 + Node.js Express 后端。

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 创建配置文件
cp config.example.json config.json
# 编辑 config.json，填入你的 corpid、corpsecret、webhook 地址

# 3. 启动服务
npm start
```

访问 http://localhost:3456

## 当前项目进度（2026-08-21）

### 已完成

- 门店、菜品、成本核算、营业数据导入与数据分析基础能力已接入项目数据库。
- 数据分析已支持总数据、团购、外卖等业务视角，以及日、周、月和自定义时间的查询口径。
- 企业设置 → 机器人设置已上线：可配置企业微信智能机器人长连接并查看连接、认证与收发状态。
- 企微机器人当前可识别时间、门店、总数据/团购/外卖、平台和常用指标，并从本项目数据库计算后回复。
- 外卖聚合查询已固定按美团外卖、淘宝闪购、京东外卖三平台返回实收、汇总实收、门店总实收和实收占比；无记录的平台按 0 展示。
- AI 模型配置已支持多档案保存、切换和编辑；模型仅接收“用户问题 + 已核验的项目数据”用于生成经营解读，不直接访问数据库。当前可选本地模拟解读或 OpenAI 兼容 API（已完成 DeepSeek 接入验证）。

### 当前问答链路

```text
企业微信消息 → 规则识别（时间/门店/业务范围） → 项目数据库精确计算 → AI 解读（可选） → 企业微信回复
```

当 AI API 不可用时，机器人仍会返回已核验的规则计算结果，避免因模型异常而无法查询经营数据。

## 未来待开发：多 Agent 协作

> 此部分仅记录规划，当前尚未实现。现阶段仍采用“单一问答协调器 + 确定性数据查询 + 可选 AI 解读”的方式。

目标是由企微接待 Agent 统一接收问题，再按意图调用专业数据 Agent，最后将经过权限校验的事实交给 AI 分析并回复：

```text
企微接待/协调 Agent → 专业数据 Agent（权限校验与精确查询） → AI 分析 Agent → 企微回复
```

规划中的专业 Agent：

| Agent | 职责 |
|------|------|
| 营业数据 Agent | 营业额、实收、优惠、订单、渠道/平台构成、环比与占比 |
| 商品销售 Agent | 平台商品销量、销售额、爆款/滞销品、标准菜品关联 |
| 菜品成本 Agent | 菜品配方、材料明细、单份成本、成本率与毛利 |
| 门店经营诊断 Agent | 汇总营业、商品、成本、渠道结果，输出可执行经营建议 |
| 权限与审计 Agent | 根据企微成员身份限制门店、指标与时间范围，并记录查询审计日志 |

实施原则：专业数据 Agent 应优先作为项目内部的确定性查询工具，而非每一步都调用大模型；只有最终解释、诊断或复杂归纳时调用 AI，从而保证数字准确、权限可控、Token 成本稳定。

## 功能

| 功能 | 说明 |
|------|------|
| 仪表盘 | 查看 API / Webhook 配置状态 |
| API 配置 | 配置 corpid、corpsecret、Webhook 地址 |
| 数据查询 | 查询部门列表、成员列表、成员详情 |
| 智能表格读取 | 读取企业微信文档/智能表格数据 |
| 一键推送 | 读取数据 → 格式化 → 推送到企业微信群 |

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/config | 查看当前配置（脱敏） |
| POST | /api/config | 保存配置 |
| GET | /api/wechat/token | 获取 access_token |
| POST | /api/wechat/send | 通过 Webhook 发送消息 |
| POST | /api/wechat/doc | 读取企业数据（通讯录等） |
| POST | /api/wechat/pipeline | 读取数据 → 推送到群 |
| POST | /api/wechat/table/info | 获取文档基础信息 |
| POST | /api/wechat/table/sheets | 获取工作表列表 |
| POST | /api/wechat/table/records | 读取表格记录 |
| POST | /api/wechat/table/pipeline | 读取表格 → 推送到群 |

## 前置条件

1. 企业微信管理后台 **自建应用** 配置好 corpid 和 corpsecret
2. 应用的「企业可信 IP」中加入当前服务器公网 IP，否则 API 调用返回 `48002`
3. 如需使用文档/表格功能，还需在应用权限中开启「文档」读写权限

## 部署到云服务器

```bash
# 上传到服务器后
cd /path/to/zhongkong-backend
npm install
cp config.example.json config.json
# 编辑 config.json 填入凭据
npm start

# 推荐使用 pm2 持久化运行
npm install -g pm2
pm2 start server.js --name zhongkong
```

## 技术栈

- 前端：原生 HTML/CSS/JS
- 后端：Node.js + Express 5
- 运行端口：3456（可通过 `PORT` 环境变量修改）
