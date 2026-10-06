#!/usr/bin/env bash
# 环境自检（只读）：确认阶段0 依赖是否齐备
ROOT="${SYNCBOT_ROOT:-/opt/zhongkong-sync-bot}"
APP="$ROOT/app"
ok=0; bad=0
chk() { # chk <说明> <命令...>
  local label="$1"; shift
  if out="$("$@" 2>&1)"; then echo "  ✓ ${label}: ${out%%$'\n'*}"; ok=$((ok+1));
  else echo "  ✗ ${label}: 不可用 -> ${out%%$'\n'*}"; bad=$((bad+1)); fi
}
have() { # have <说明> <路径>
  if [ -x "$2" ]; then echo "  ✓ $1: $2"; ok=$((ok+1)); else echo "  ✗ $1: 缺失 ($2)"; bad=$((bad+1)); fi
}

echo "==== 同步机器人环境自检 ===="
echo "--- 运行用户与权限 ---"
echo "  当前用户: $(id -un)  根目录: $ROOT"
if id syncbot >/dev/null 2>&1; then
  echo "  ✓ syncbot 用户存在: $(id syncbot)"
  echo "    syncbot 是否属于 sudo/docker 等特权组: $(id -nG syncbot)"
else echo "  ✗ syncbot 用户不存在"; bad=$((bad+1)); fi

echo "--- 可执行文件 ---"
have "node" /usr/local/bin/node
have "Xvfb" /usr/bin/Xvfb
have "x11vnc" /usr/bin/x11vnc
have "fluxbox" /usr/bin/fluxbox
have "websockify" /usr/bin/websockify
have "xauth" /usr/bin/xauth
have "fc-list" /usr/bin/fc-list
[ -d /usr/share/novnc ] && { echo "  ✓ noVNC web 资源: /usr/share/novnc"; ok=$((ok+1)); } || { echo "  ✗ noVNC web 资源缺失"; bad=$((bad+1)); }

echo "--- 版本 ---"
chk "node" /usr/local/bin/node -v
chk "Xvfb" /usr/bin/Xvfb -help
chk "x11vnc" /usr/bin/x11vnc -version
chk "websockify" /usr/bin/websockify --help

echo "--- 中文字体 ---"
if fc-list :lang=zh 2>/dev/null | grep -qi "noto.*cjk\|wenquanyi"; then
  echo "  ✓ 已安装中文字体：$(fc-list :lang=zh | wc -l) 个条目"
  fc-list :lang=zh family 2>/dev/null | sort -u | head -5 | sed 's/^/      /'
  ok=$((ok+1))
else echo "  ✗ 未检测到中文字体（会出现方块字）"; bad=$((bad+1)); fi

echo "--- Playwright / Chromium ---"
if [ -f "$APP/node_modules/playwright/package.json" ]; then
  echo "  ✓ playwright 版本: $(node -p "require('$APP/node_modules/playwright/package.json').version" 2>/dev/null)"
  ok=$((ok+1))
else echo "  ✗ playwright 未安装到 $APP/node_modules"; bad=$((bad+1)); fi
if [ -x "/home/syncbot/.cache/ms-playwright" ] || ls -d /home/syncbot/.cache/ms-playwright/chromium* >/dev/null 2>&1; then
  echo "  ✓ Chromium 已下载: $(ls -d /home/syncbot/.cache/ms-playwright/chromium* 2>/dev/null | xargs -n1 basename | tr '\n' ' ')"
  ok=$((ok+1))
else echo "  ✗ Chromium 未下载（/home/syncbot/.cache/ms-playwright 为空）"; bad=$((bad+1)); fi

echo "--- 目录与权限（登录态必须 0700）---"
for d in app browser-profiles browser-profiles/meituan downloads downloads/meituan screenshots logs state config state/secrets state/locks; do
  if [ -d "$ROOT/$d" ]; then printf "  %-34s %s\n" "$d" "$(stat -c '%A %U:%G' "$ROOT/$d")";
  else echo "  ✗ 缺少目录 $d"; bad=$((bad+1)); fi
done

echo "--- 监听端口（必须为回环，不得 0.0.0.0）---"
LST="$(ss -tlnp 2>/dev/null | grep -E ':(5901|6080)\b' || true)"
if [ -n "$LST" ]; then
  echo "$LST" | sed 's/^/  /'
  # 只看本地地址列（ss 第 4 列）；对端地址列恒为 0.0.0.0:* 不能用于判断
  BADS="$(echo "$LST" | awk '{print $4}' | grep -vE '^(127\.0\.0\.1|\[::1\]):' || true)"
  if [ -n "$BADS" ]; then
    echo "  ✗ 存在非回环监听，违反安全约束：$BADS"; bad=$((bad+1))
  else echo "  ✓ 仅监听回环地址"; ok=$((ok+1)); fi
else echo "  · 5901/6080 当前未监听（服务未启动）"; fi

echo "--- 现有中控项目（只读确认，未做任何改动）---"
systemctl is-active zhongkong.service | sed 's/^/  zhongkong.service active=/'
echo "  项目目录: $(ls -ld /home/ubuntu/app 2>/dev/null | awk '{print $1, $3":"$4, $9}')"

echo "--- 框架自检 ---"
if [ -f "$APP/src/selftest.js" ]; then
  if (cd "$APP" && node src/selftest.js >/tmp/_syncbot_selftest.out 2>&1); then echo "  ✓ 框架自检通过（8 项）"; ok=$((ok+1));
  else echo "  ✗ 框架自检失败："; tail -20 /tmp/_syncbot_selftest.out | sed 's/^/      /'; bad=$((bad+1)); fi
else echo "  ✗ src/selftest.js 缺失"; bad=$((bad+1)); fi

echo "==== 通过 $ok 项，异常 $bad 项 ===="
exit $(( bad > 0 ? 1 : 0 ))
