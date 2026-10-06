#!/bin/bash
# 阶段3 步骤4-B：历史审计取证 + DB 覆盖复查 + 重启浏览器 + 真实页面预检
# 注：本脚本为 2026-09-18 的历史一次性脚本，已被 p3-preflight.sh 的三道闸门取代；
#     保留仅作取证记录。其覆盖闸门改为调用同目录 p3-gate.py，命中即非零退出。
set -u
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
B=/opt/zhongkong-sync-bot
BD=2026-09-18
TODAY=$(date +%F)
BLOG=$B/logs/browser-meituan-$TODAY.log

echo "===== A. 历史增量取证：两个套件失败是否为既有历史所致 ====="
echo "--- 文件指纹（若 mtime 早于本次会话即证明非本轮写入）---"
sudo stat -c 'path=%n size=%s mtime=%y ctime=%z' $B/state/downloads-meituan.jsonl
echo "now=$(date -Is)"
echo "sha256=$(sudo sha256sum $B/state/downloads-meituan.jsonl | cut -d' ' -f1)"
echo "lines=$(sudo wc -l < $B/state/downloads-meituan.jsonl)"
echo "--- 逐行事件与时间（只输出审计元数据字段）---"
sudo python3 - <<'PY'
import json
p='/opt/zhongkong-sync-bot/state/downloads-meituan.jsonl'
for i,l in enumerate(open(p,encoding='utf-8'),1):
    l=l.strip()
    if not l: continue
    try: d=json.loads(l)
    except Exception: print(i,'PARSE_FAIL',l[:100]); continue
    print(i, d.get('event'), d.get('at'), 'size=%s'%d.get('size'), 'archived=%s'%str(d.get('archived_filename'))[:50])
PY

echo
echo "===== B. DB 区间覆盖复查（2026-09-18）— 命中必须立即非零退出 ====="
python3 "$SELF_DIR/p3-gate.py" --db=/home/ubuntu/app/data/database.sqlite --date=2026-09-18 --phase=pre_browser
GATE_EXIT=$?
echo "GATE_EXIT=$GATE_EXIT"
if [ "$GATE_EXIT" -ne 0 ]; then
  echo "STOP: 覆盖闸门未通过（0=无覆盖；20=命中区间覆盖；21=无法判定/fail-closed）。"
  echo "      按规则立即停止：不重启浏览器、不执行页面预检、不导出、不下载、不导入、不推送。"
  exit "$GATE_EXIT"
fi
echo "GATE=PASS(无覆盖)，继续后续只读步骤"

echo
echo "===== C. 仅重启 syncbot-browser 并验证分层下载目录 ====="
for s in syncbot-browser zhongkong nginx syncbot-xvfb syncbot-wm syncbot-vnc syncbot-novnc; do
  printf 'PRE  %-18s active=%-8s pid=%-8s since=%s\n' "$s" "$(systemctl is-active $s 2>/dev/null)" "$(systemctl show -p MainPID --value $s 2>/dev/null)" "$(systemctl show -p ActiveEnterTimestamp --value $s 2>/dev/null)"
done
sudo systemctl restart syncbot-browser
echo "restart_at=$(date -Is)"
for i in $(seq 1 20); do
  sleep 2
  if systemctl is-active --quiet syncbot-browser && sudo test -f $B/state/runtime/browser-meituan.json && sudo grep -q "browser.ready" $BLOG 2>/dev/null; then
    echo "ready_after=$((i*2))s"; break
  fi
done
for s in syncbot-browser zhongkong nginx syncbot-xvfb syncbot-wm syncbot-vnc syncbot-novnc; do
  printf 'POST %-18s active=%-8s pid=%-8s since=%s\n' "$s" "$(systemctl is-active $s 2>/dev/null)" "$(systemctl show -p MainPID --value $s 2>/dev/null)" "$(systemctl show -p ActiveEnterTimestamp --value $s 2>/dev/null)"
done
echo "--- 运行态 download_dir ---"
sudo python3 -c "
import json
d=json.load(open('$B/state/runtime/browser-meituan.json'))
print('  pid=',d.get('pid'),' download_dir=',repr(d.get('download_dir')))
print('  DOWNLOADDIR_VERIFY=', 'PASS' if d.get('download_dir')=='$B/downloads/meituan/cashier_composite/_incoming' else 'FAIL')
"
echo "--- browser.start / armed ---"
sudo grep -h "browser.start" $BLOG 2>/dev/null | tail -1 | python3 -c "
import sys,json
l=sys.stdin.read().strip()
print('  download_dir =', repr(json.loads(l)['data'].get('download_dir')) if l else 'none')
"

echo
echo "===== D. 真实页面只读预检 2026-09-18 ====="
cd $B/app
sudo -n -u syncbot -H env HOME=/home/syncbot DISPLAY=:99 node src/phase2/precheck-set-date.js --date=$BD > /tmp/psd0918b.out 2>&1
echo "psd_exit=$?"
sudo chmod 644 /tmp/psd0918b.out
python3 - <<'PY'
import json
raw=open('/tmp/psd0918b.out',encoding='utf-8').read()
i=raw.find('{\n  "task_id"')
if i<0:
    print('NO_JSON tail:'); print(raw[-2000:]); raise SystemExit
d=json.loads(raw[i:]); f=d.get('flow') or {}
print('  ok=%s error=%s task=%s' % (d.get('ok'), d.get('error'), d.get('task_id')))
print('  read_only_except_date=%s clicked_export=%s export_dialog_touched=%s visited_download_list=%s downloaded=%s' % (
    d.get('read_only_except_date'), d.get('clicked_export'), d.get('export_dialog_touched'), d.get('visited_download_list'), d.get('downloaded')))
for s in (f.get('steps') or []):
    if s.get('name')=='set_date_range': print('  门槛1 日期双值 =', json.dumps(s.get('values')), 'clicks=', s.get('clicks'))
    if s.get('name')=='filter_state': print('  门槛2 筛选 page_checked=%s matched=%s' % (s.get('page_checked'), s.get('matched')))
    if s.get('name')=='table_summary': print('  门槛3 声明门店=%s  门槛4 合计含22单元=%s' % (s.get('declared'), s.get('total_store_count_cells')))
print('  flow.ok=%s flow.reason=%s' % (f.get('ok'), f.get('reason')))
print('  序列=', [s.get('name') for s in (f.get('steps') or [])])
PY

echo
echo "===== E. 完整性 ====="
echo "browser_pid=$(systemctl show -p MainPID --value syncbot-browser)"
echo "approvals:"; sudo cat $B/state/runtime/approvals.json 2>/dev/null | python3 -c "
import json,sys; d=json.load(sys.stdin)
print(' ',{k:d.get(k) for k in ('export_submit','download_list','download_file','temporary_for_task','temporary_until')})
"
echo "downloads_audit_lines=$(sudo wc -l < $B/state/downloads-meituan.jsonl)"
echo "downloads 文件数=$(sudo find $B/downloads -type f 2>/dev/null | wc -l)"
echo "layered_incoming=$(sudo find $B/downloads/meituan/cashier_composite/_incoming -type f 2>/dev/null | wc -l)"
echo "locks=$(sudo find $B/state/locks -type f 2>/dev/null | wc -l)"
echo "===== DONE12 ====="
