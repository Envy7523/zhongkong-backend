#!/usr/bin/env bash
# 阶段1 样本只读留档入口（人工导出完成后执行一次）
#   sudo /opt/zhongkong-sync-bot/app/bin/sample-intake.sh
#
# 行为：① 先抓一张当前 :99 桌面截图（含浏览器窗口，即"导出完成后的浏览器截图"）
#       ② 再对 _incoming 里的样本做只读留档（名称/路径/大小/时间/SHA-256/工作表/表头）
# 不做：移动、改名、删除、写数据库、调用导入、调用推送、创建定时任务。
set -uo pipefail
ROOT="${SYNCBOT_ROOT:-/opt/zhongkong-sync-bot}"
SVC_USER=syncbot
XA="$ROOT/state/secrets/x11-xauth"
DAY="$(date +%F)"
TS="$(date +%H%M%S)"
SHOTDIR="$ROOT/screenshots/$DAY"
SHOT="$SHOTDIR/export-screenshot-$TS.png"
NODE="$(command -v node || echo /usr/local/bin/node)"

echo "===== 1 抓取浏览器截图（:99 整屏，含浏览器窗口）====="
mkdir -p "$SHOTDIR"
chown $SVC_USER:$SVC_USER "$SHOTDIR" 2>/dev/null || true
chmod 0750 "$SHOTDIR" 2>/dev/null || true
TMPX="$(mktemp /tmp/_intake_shot_XXXX.xwd)"
if sudo -u $SVC_USER env DISPLAY=:99 XAUTHORITY="$XA" xwd -root -silent -display :99 > "$TMPX" 2>/dev/null && [ -s "$TMPX" ]; then
  xwdtopnm "$TMPX" 2>/dev/null | pnmtopng > "$SHOT" 2>/dev/null
  rm -f "$TMPX"
  chown $SVC_USER:$SVC_USER "$SHOT"; chmod 0640 "$SHOT"
  echo "  ✓ 截图已保存：$SHOT ($(stat -c %s "$SHOT") 字节)"
else
  rm -f "$TMPX"
  echo "  ! 截屏失败（Xvfb/xwd 不可用），留档将不含截图"
  SHOT=""
fi

echo
echo "===== 2 只读留档 ====="
CSV="$ROOT/state/samples/columns-$DAY-$TS.csv"
if [ -n "$SHOT" ]; then
  sudo -u $SVC_USER -H env HOME=/home/syncbot "$NODE" "$ROOT/app/src/sample-intake.js" --screenshot="$SHOT" --csv-out="$CSV" "$@"
else
  sudo -u $SVC_USER -H env HOME=/home/syncbot "$NODE" "$ROOT/app/src/sample-intake.js" --csv-out="$CSV" "$@"
fi
echo "  列清单 CSV（可用 Excel 打开审阅）: $CSV"

echo
echo "===== 3 样本文件仍然原样在位（未移动/未改名）====="
ls -la --time-style=long-iso "$ROOT/downloads/meituan/_incoming/" | sed 's/^/  /'
echo
echo "===== 4 合规自检：无定时任务 / 未触及项目 ====="
echo "  syncbot timer 数：$(systemctl list-timers --all --no-pager --no-legend 2>/dev/null | grep -ci syncbot)"
echo "  zhongkong.service：$(systemctl is-active zhongkong) (since $(systemctl show -p ActiveEnterTimestamp --value zhongkong))"
echo "  项目数据库 mtime：$(stat -c '%y' /home/ubuntu/app/data/database.sqlite 2>/dev/null)"
echo
echo "SAMPLE_INTAKE_DONE"
