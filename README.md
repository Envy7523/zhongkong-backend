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
