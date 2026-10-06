# 美团外卖营业表机器人

独立浏览器：`syncbot-meituan-delivery-browser.service`，专用 Profile `browser-profiles/meituan_delivery`，Unix Socket `state/runtime/meituan-delivery/host.sock`（0600）。共用现有 Xvfb 显示器；不开放新的网络控制端口。

命令：`node bin/meituan-delivery.js run --date=YYYY-MM-DD`。程序自动导航、设置日期与字段、创建导出任务、下载、归档、导入和回读对账。恢复已创建任务时不重新导出；导入按日期和文件 SHA256 幂等，回执不确定时需同源回读核验，禁止重复创建批次。登录态失效或出现验证码时暂停，由人工登录。

定时入口 `bin/meituan-delivery-schedule.js`：读取中控“报表同步计划”的 `meituan_delivery_operating` 计划。默认 04:00（北京时间），默认关闭，完整真实验收后启用。systemd timer 每分钟唤醒，只有计划时间后的 15 分钟窗口会执行，且每个计划日只启动一次。失败留待人工关注，开启不会补跑历史日期。

浏览器服务执行用户 `syncbot`，Node 使用现有 `/usr/local/bin/node`；环境为 `HOME=/home/syncbot`、`DISPLAY=:99`、`XAUTHORITY=/opt/zhongkong-sync-bot/state/secrets/x11-xauth`，`UMask=0077`。所有业务程序从明确提交的独立发布目录执行。计划服务同一用户，调用该发布目录的 schedule.js，并 `After=syncbot-meituan-delivery-browser.service`。浏览器服务须在报表 timer 启用后保持常驻。

机器人只向 `http://127.0.0.1:3456` 发送文件；复用现有 0600 HMAC 密钥。没有日报推送凭据和消息发送路径。
