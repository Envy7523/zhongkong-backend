#!/bin/bash
# 阶段3 全链路「运行前检查」：三道覆盖闸门（G1 浏览器动作前 / G2 导出前 / G3 导入前）
#
# 硬规则：
#   * 闸门命中（exit 20）或无法判定（exit 21）→ **立即非零退出**，
#     绝不执行后续的浏览器重启、页面预检、导出、下载、导入、推送。
#   * 本脚本**永不执行导出、导入或推送**：它只做闸门 + （可选）浏览器/页面只读准备。
#     导出与导入必须由各自被单独授权的步骤执行，并在执行前后各自再跑一次本闸门。
#   * --backend=record 时不执行任何真实动作，只把"将要执行的动作"写入台账，
#     用于在无浏览器、无美团访问的前提下验证控制流与停止语义。
#   * --backend=real 必须显式加 --confirm-real-preflight。
#
# 用法：
#   bash p3-preflight.sh --date=2026-09-19 --db=/home/ubuntu/app/data/database.sqlite --through=gate3
#   bash p3-preflight.sh --date=2026-09-19 --backend=record --record=/tmp/x.jsonl --through=browser
set -u

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
PY="$(command -v python3 || command -v python || true)"
GATE_NAME="p3-gate.py"
GATE="$SELF_DIR/$GATE_NAME"

DATE=""
DB="/home/ubuntu/app/data/database.sqlite"
BACKEND="record"
RECORD=""
THROUGH="gate3"
CONFIRM_REAL=0
BOT="${P3_BOT_ROOT:-/opt/zhongkong-sync-bot}"
REPORT_TYPE="cashier_composite"

for a in "$@"; do
  case "$a" in
    --date=*)    DATE="${a#*=}" ;;
    --db=*)      DB="${a#*=}" ;;
    --backend=*) BACKEND="${a#*=}" ;;
    --record=*)  RECORD="${a#*=}" ;;
    --through=*) THROUGH="${a#*=}" ;;
    --confirm-real-preflight) CONFIRM_REAL=1 ;;
    *) echo "未知参数：$a" >&2; exit 2 ;;
  esac
done

if [ -z "$DATE" ]; then
  echo "用法: p3-preflight.sh --date=YYYY-MM-DD [--db=PATH] [--backend=record|real] [--record=FILE] [--through=gate1|browser|gate2|gate3] [--confirm-real-preflight]" >&2
  exit 2
fi
if [ -z "$PY" ]; then echo "缺少 python3/python" >&2; exit 2; fi
if [ ! -f "$GATE" ]; then echo "缺少闸门脚本：$GATE" >&2; exit 2; fi
[ -n "$RECORD" ] || RECORD="$SELF_DIR/p3-preflight.record.jsonl"

case "$THROUGH" in
  gate1)   RUN_BROWSER=0; RUN_GATE2=0; RUN_GATE3=0 ;;
  browser) RUN_BROWSER=1; RUN_GATE2=0; RUN_GATE3=0 ;;
  gate2)   RUN_BROWSER=1; RUN_GATE2=1; RUN_GATE3=0 ;;
  gate3)   RUN_BROWSER=1; RUN_GATE2=1; RUN_GATE3=1 ;;
  *) echo "未知 --through=$THROUGH" >&2; exit 2 ;;
esac

case "$BACKEND" in
  record) ;;
  real)
    if [ "$CONFIRM_REAL" != "1" ]; then
      echo "real 后端会真正重启 syncbot-browser 并执行只读页面预检；需显式加 --confirm-real-preflight" >&2
      exit 2
    fi ;;
  *) echo "未知 --backend=$BACKEND" >&2; exit 2 ;;
esac

: > "$RECORD"
ledger() { printf '%s\n' "$1" >> "$RECORD"; }
ledger "{\"phase\":\"preflight_start\",\"date\":\"$DATE\",\"backend\":\"$BACKEND\",\"through\":\"$THROUGH\"}"

GATE_RC=0
gate() {
  local phase="$1" out rc
  # 在脚本自身目录内以相对文件名调用，避免跨平台（Windows/Git Bash↔Linux）绝对路径差异
  out="$( cd "$SELF_DIR" && "$PY" "$GATE_NAME" --db="$DB" --date="$DATE" --phase="$phase" 2>&1 )"
  rc=$?
  printf '%s\n' "$out"
  echo "GATE[${phase}] exit=${rc}"
  GATE_RC=$rc
  return 0
}

stop_at() {
  local gate_name="$1"
  echo "STOP(${gate_name}): 闸门未通过 exit=${GATE_RC}（20=命中区间覆盖；21=无法判定）。"
  echo "          不重启浏览器、不执行页面预检、不导出、不下载、不导入、不推送。"
  ledger "{\"phase\":\"stopped\",\"at_gate\":\"${gate_name}\",\"exit\":${GATE_RC}}"
  exit "$GATE_RC"
}

echo "PREFLIGHT date=$DATE db=$DB backend=$BACKEND through=$THROUGH"
echo "record_file=$RECORD  bot_root=$BOT"
echo "note: 本脚本不执行导出/导入/推送；导出与导入由各自被单独授权的步骤执行。"

echo
echo "=== G1 浏览器动作前：区间覆盖查询 ==="
gate pre_browser
[ "$GATE_RC" -eq 0 ] || stop_at pre_browser
ledger "{\"phase\":\"gate_pass\",\"gate\":\"pre_browser\"}"

if [ "$RUN_BROWSER" = "1" ]; then
  echo
  echo "=== BROWSER 阶段（G1 已通过）==="
  if [ "$BACKEND" = "record" ]; then
    PIDF="${P3_FAKE_PID_FILE:-}"
    PB="null"
    if [ -n "$PIDF" ] && [ -f "$PIDF" ]; then PB="$(tr -d '\r\n' < "$PIDF")"; fi
    ledger "{\"action\":\"browser_pid_before\",\"pid\":${PB}}"
    ledger "{\"action\":\"browser_restart\",\"service\":\"syncbot-browser\"}"
    ledger "{\"action\":\"page_command\",\"cmd\":\"precheck-set-date\",\"report_type\":\"$REPORT_TYPE\",\"date\":\"$DATE\"}"
    PA="null"
    if [ -n "$PIDF" ] && [ -f "$PIDF" ]; then PA="$(tr -d '\r\n' < "$PIDF")"; fi
    ledger "{\"action\":\"browser_pid_after\",\"pid\":${PA}}"
    ledger "{\"action\":\"download_dir_verify\",\"expect\":\"$BOT/downloads/meituan/$REPORT_TYPE/_incoming\"}"
    echo "record 后端：未执行任何真实动作（仅写入台账）"
  else
    echo "real 后端：仅重启 syncbot-browser（不动中控/nginx/VNC）"
    sudo systemctl restart syncbot-browser || { ledger '{"action":"browser_restart","ok":false}'; exit 4; }
    ledger '{"action":"browser_restart","ok":true}'
    for _i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
      sleep 2
      if systemctl is-active --quiet syncbot-browser && sudo test -f "$BOT/state/runtime/browser-meituan.json"; then break; fi
    done
    EXPECT="$BOT/downloads/meituan/$REPORT_TYPE/_incoming"
    RUNDIR="$(sudo "$PY" -c "import json;print(json.load(open('$BOT/state/runtime/browser-meituan.json')).get('download_dir',''))" 2>/dev/null)"
    echo "runtime download_dir=$RUNDIR"
    ledger "{\"action\":\"download_dir_verify\",\"expect\":\"$EXPECT\",\"actual\":\"$RUNDIR\"}"
    if [ "$RUNDIR" != "$EXPECT" ]; then echo "STOP: 分层下载目录校验失败，未执行页面预检"; exit 5; fi
    echo "只读页面预检（不含导出/下载/下载清单点击）"
    ( cd "$BOT/app" && sudo -n -u syncbot -H env HOME=/home/syncbot DISPLAY=:99 node src/phase2/precheck-set-date.js --date="$DATE" )
    PRC=$?
    ledger "{\"action\":\"page_command\",\"cmd\":\"precheck-set-date\",\"exit\":${PRC}}"
    if [ "$PRC" -ne 0 ]; then echo "STOP: 页面预检失败，不导出"; exit 6; fi
  fi
fi

if [ "$RUN_GATE2" = "1" ]; then
  echo
  echo "=== G2 导出前：再次区间覆盖查询（防人工并行导入）==="
  gate pre_export
  [ "$GATE_RC" -eq 0 ] || stop_at pre_export
  ledger "{\"phase\":\"gate_pass\",\"gate\":\"pre_export\"}"
fi

if [ "$RUN_GATE3" = "1" ]; then
  echo
  echo "=== G3 导入前：再次区间覆盖查询（防人工并行导入）==="
  gate pre_import
  [ "$GATE_RC" -eq 0 ] || stop_at pre_import
  ledger "{\"phase\":\"gate_pass\",\"gate\":\"pre_import\"}"
fi

echo
echo "=== 结论 ==="
echo "已执行检查点：$([ "$RUN_BROWSER" = 1 ] && echo -n 'BROWSER ' ; true)G1 $([ "$RUN_GATE2" = 1 ] && echo -n 'G2 ' ; true)$([ "$RUN_GATE3" = 1 ] && echo -n 'G3' ; true)"
echo "全部通过：未命中区间覆盖。本脚本未执行导出、未执行导入、未推送、未建 timer。"
ledger "{\"phase\":\"preflight_done\",\"ok\":true}"
exit 0
