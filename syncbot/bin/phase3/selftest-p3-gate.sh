#!/bin/bash
# 本地自检：覆盖闸门 + 全链路运行前检查的控制流（**纯本地 fixture**）
# 不访问美团、不重启浏览器、不页面预检、不导出、不下载、不导入、不推送。
#
# 关键：必须同时包含负向用例（命中→停止）与**正向对照**（未命中→浏览器动作确实发生），
# 否则"命中时台账为空"这类断言会因为机制从未生效而空洞通过。
set -u

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
PY="$(command -v python3 || command -v python || true)"
GATE_NAME="p3-gate.py"
PRE_NAME="p3-preflight.sh"
TMP="$(mktemp -d)"
TMPW="$(cd "$TMP" && pwd -W 2>/dev/null || echo "$TMP")"
trap 'rm -rf "$TMP"' EXIT

PASS=0; FAIL=0
ck() {
  if [ "$2" = "1" ]; then PASS=$((PASS+1)); printf '  ok   %s\n' "$1";
  else FAIL=$((FAIL+1)); printf '  FAIL %s\n         %s\n' "$1" "${3:-}"; fi
}
[ -n "$PY" ] || { echo "缺少 python3/python"; exit 2; }
[ -f "$SELF_DIR/$GATE_NAME" ] || { echo "缺少 $GATE_NAME"; exit 2; }
[ -f "$SELF_DIR/$PRE_NAME" ] || { echo "缺少 $PRE_NAME"; exit 2; }
echo "python=$PY"
echo "workdir=$TMP"

echo
echo "=== 0. 构建 fixture 数据库 ==="
"$PY" - "$TMPW" <<'PY'
import os, sqlite3, sys
tmp = sys.argv[1]

def mk(name, rows):
    p = os.path.join(tmp, name)
    if os.path.exists(p):
        os.remove(p)
    con = sqlite3.connect(p)
    con.execute("""CREATE TABLE business_import_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source_type TEXT NOT NULL, platform TEXT DEFAULT '',
        file_name TEXT DEFAULT '', row_count INTEGER DEFAULT 0, date_from TEXT, date_to TEXT,
        imported_by INTEGER, imported_by_name TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now','localtime')))""")
    for r in rows:
        con.execute('INSERT INTO business_import_batches '
                    '(source_type,platform,file_name,row_count,date_from,date_to,imported_by_name) '
                    'VALUES (?,?,?,?,?,?,?)', r)
    con.commit(); con.close()

# 区间覆盖目标日期（date_from < 目标 < date_to）
mk('covered.db', [('pos', '收银系统综合营业统计', 'a.xlsx', 132, '2026-09-15', '2026-09-20', '系统管理员')])
# 精确等于目标日期
mk('exact.db', [('pos', '收银系统综合营业统计', 'd.xlsx', 132, '2026-09-19', '2026-09-19', '系统管理员')])
# 相邻日期有批次，但不覆盖目标日期
mk('clear.db', [('pos', '收银系统综合营业统计', 'b.xlsx', 110, '2026-09-18', '2026-09-18', '系统管理员')])
# 只有第三方平台来源覆盖目标日期（不应命中本闸门）
mk('platform_only.db', [('platform', '美团外卖', 'c.xlsx', 10, '2026-09-15', '2026-09-20', '系统管理员')])
print('fixtures ok')
PY
ck "fixture 构建成功" "$([ $? -eq 0 ] && echo 1 || echo 0)" "python 构建失败"

run_gate() {  # db date phase
  ( cd "$SELF_DIR" && "$PY" "$GATE_NAME" --db="$1" --date="$2" --phase="${3:-pre_browser}" ) > "$TMP/gate.out" 2>&1
  GRC=$?
}
run_pre() {   # db through recordfile
  ( cd "$SELF_DIR" && bash "$PRE_NAME" --date=2026-09-19 --db="$1" --backend=record --record="$3" --through="$2" ) > "$TMP/pre.out" 2>&1
  PRC=$?
}
rec_has()   { grep -q -- "$2" "$1" 2>/dev/null && echo 1 || echo 0; }
rec_lines() { [ -f "$1" ] && grep -c . "$1" 2>/dev/null || echo 0; }

# 精确按 JSON 的 action 字段判定，避免子串误判
# （例如 "download_dir_verify" 与 expect 路径里的 "downloads/..." 都不等于 download 动作）
has_forbidden_action() {
  "$PY" - "$1" <<'PY'
import json, sys
FORBIDDEN = {'export', 'submit_export', 'submitExport', 'download', 'download_file',
             'downloadFile', 'import', 'validate_import', 'push', 'create_timer'}
found = []
try:
    with open(sys.argv[1], encoding='utf-8') as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            a = str(o.get('action', ''))
            if a in FORBIDDEN:
                found.append(a)
except OSError:
    pass
print('1' if found else '0')
PY
}
list_actions() {
  "$PY" - "$1" <<'PY'
import json, sys
acts = []
try:
    with open(sys.argv[1], encoding='utf-8') as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            if o.get('action'):
                acts.append(str(o['action']))
except OSError:
    pass
print(','.join(acts) if acts else '(no actions)')
PY
}

echo
echo "=== 1. 闸门退出码语义 ==="
run_gate "$TMPW/covered.db" 2026-09-19;               ck "G1 区间覆盖 → exit 20（命中必须停止）" "$([ "$GRC" = 20 ] && echo 1 || echo 0)" "exit=$GRC"
grep -q '"verdict": "covered"' "$TMP/gate.out" && ck "G1 verdict=covered 且输出命中批次" "$(grep -q '"hit_count": 1' "$TMP/gate.out" && echo 1 || echo 0)" "$(head -c 200 "$TMP/gate.out")"
run_gate "$TMPW/exact.db" 2026-09-19;                 ck "G2 精确同日批次 → exit 20" "$([ "$GRC" = 20 ] && echo 1 || echo 0)" "exit=$GRC"
run_gate "$TMPW/clear.db" 2026-09-19;                 ck "G3 相邻日不覆盖 → exit 0（clear）" "$([ "$GRC" = 0 ] && echo 1 || echo 0)" "exit=$GRC"
run_gate "$TMPW/platform_only.db" 2026-09-19;         ck "G4 仅第三方平台来源覆盖 → exit 0（不计入）" "$([ "$GRC" = 0 ] && echo 1 || echo 0)" "exit=$GRC"
run_gate "$TMPW/nonexistent.db" 2026-09-19;           ck "G5 数据库缺失 → exit 21（fail-closed，绝不当作 clear）" "$([ "$GRC" = 21 ] && echo 1 || echo 0)" "exit=$GRC"
run_gate "$TMPW/clear.db" 2026-02-30;                 ck "G6 非法日期 2026-02-30 → exit 2" "$([ "$GRC" = 2 ] && echo 1 || echo 0)" "exit=$GRC"
run_gate "$TMPW/clear.db" 2026-9-19;                  ck "G7 非法日期 2026-9-19 → exit 2" "$([ "$GRC" = 2 ] && echo 1 || echo 0)" "exit=$GRC"

echo
echo "=== 2. 命中时必须立即停止：无浏览器动作/无页面命令/无导出/无下载 ==="
PIDF="$TMPW/pid.txt"; printf '877507\n' > "$PIDF"
export P3_FAKE_PID_FILE="$PIDF"
REC="$TMPW/rec-hit.jsonl"
run_pre "$TMPW/covered.db" gate3 "$REC"
ck "P1 命中 → preflight exit 20" "$([ "$PRC" = 20 ] && echo 1 || echo 0)" "exit=$PRC"
ck "P2 命中 → 无 browser_restart" "$([ "$(rec_has "$REC" browser_restart)" = 0 ] && echo 1 || echo 0)" "$(cat "$REC")"
ck "P3 命中 → 无 page_command（未访问任何页面）" "$([ "$(rec_has "$REC" page_command)" = 0 ] && echo 1 || echo 0)" "$(cat "$REC")"
ck "P4 命中 → 未采样 browser_pid（连 PID 都没读）" "$([ "$(rec_has "$REC" browser_pid_before)" = 0 ] && echo 1 || echo 0)" "$(cat "$REC")"
ck "P5 命中 → 无 export / download 动作（按 action 字段精确判定）" "$([ "$(has_forbidden_action "$REC")" = 0 ] && echo 1 || echo 0)" "actions=$(list_actions "$REC")"
ck "P5b 命中 → 台账中不存在任何 action（完全未动作）" "$([ "$(list_actions "$REC")" = "(no actions)" ] && echo 1 || echo 0)" "actions=$(list_actions "$REC")"
ck "P6 命中 → PID 哨兵文件内容不变（PID 不变）" "$([ "$(tr -d '\r\n' < "$PIDF")" = "877507" ] && echo 1 || echo 0)" "$(cat "$PIDF")"
ck "P7 命中 → 台账记录停止点 at_gate=pre_browser" "$(rec_has "$REC" '"at_gate":"pre_browser"')" "$(cat "$REC")"

echo
echo "=== 3. 正向对照：未命中时机制确实生效（避免上述断言空洞通过）==="
REC2="$TMPW/rec-clear.jsonl"
run_pre "$TMPW/clear.db" browser "$REC2"
ck "P8 未命中 → preflight exit 0" "$([ "$PRC" = 0 ] && echo 1 || echo 0)" "exit=$PRC"
ck "P9 正对照 → 台账确实记录了 browser_restart" "$(rec_has "$REC2" browser_restart)" "$(cat "$REC2")"
ck "P10 正对照 → 台账确实记录了 page_command" "$(rec_has "$REC2" page_command)" "$(cat "$REC2")"
ck "P11 正对照 → 台账确实采样了 browser_pid_before=877507" "$(rec_has "$REC2" '\"pid\":877507')" "$(cat "$REC2")"
ck "P12 正对照 → 即使继续执行，也绝无 export/download（按 action 字段精确判定）" "$([ "$(has_forbidden_action "$REC2")" = 0 ] && echo 1 || echo 0)" "actions=$(list_actions "$REC2")"

echo
echo "=== 4. 阶段顺序：G1 必须早于浏览器动作；G2/G3 位置正确 ==="
REC3="$TMPW/rec-gate1.jsonl"
run_pre "$TMPW/clear.db" gate1 "$REC3"
ck "P13 --through=gate1 → exit 0 且无任何浏览器动作（G1 在浏览器动作之前）" "$([ "$PRC" = 0 ] && [ "$(rec_has "$REC3" browser_restart)" = 0 ] && [ "$(rec_has "$REC3" page_command)" = 0 ] && echo 1 || echo 0)" "exit=$PRC rec=$(cat "$REC3")"
REC4="$TMPW/rec-gate3.jsonl"
run_pre "$TMPW/clear.db" gate3 "$REC4"
ck "P14 --through=gate3 → exit 0，且 G2(pre_export)/G3(pre_import) 两个检查点均通过" "$([ "$PRC" = 0 ] && [ "$(rec_has "$REC4" '"gate":"pre_export"')" = 1 ] && [ "$(rec_has "$REC4" '"gate":"pre_import"')" = 1 ] && echo 1 || echo 0)" "exit=$PRC rec=$(cat "$REC4")"
ck "P15 gate1 在台账中的顺序早于 browser_restart" "$(awk '/preflight_start/{s=NR} /browser_restart/{b=NR} END{print (s && b && s<b) ? 1 : 0}' "$REC4")" "$(cat "$REC4")"

echo
echo "=== 5. fail-closed 与 非法参数：同样不得进入浏览器阶段 ==="
REC5="$TMPW/rec-unknown.jsonl"
run_pre "$TMPW/nonexistent.db" gate3 "$REC5"
ck "P16 数据库缺失 → preflight exit 21 且无浏览器动作" "$([ "$PRC" = 21 ] && [ "$(rec_has "$REC5" browser_restart)" = 0 ] && [ "$(rec_has "$REC5" page_command)" = 0 ] && echo 1 || echo 0)" "exit=$PRC rec=$(cat "$REC5")"
( cd "$SELF_DIR" && bash "$PRE_NAME" --date=2026-02-30 --db="$TMPW/clear.db" --backend=record --record="$TMPW/rec-baddate.jsonl" --through=gate3 ) > "$TMP/pre2.out" 2>&1
BADRC=$?
ck "P17 非法日期 → preflight exit 2 且无浏览器动作" "$([ "$BADRC" = 2 ] && [ "$(rec_has "$TMPW/rec-baddate.jsonl" browser_restart)" = 0 ] && echo 1 || echo 0)" "exit=$BADRC"

echo
echo "=== 6. 静态守卫：本套脚本永不执行导出/导入/推送 ==="
for tok in '--confirm-real-download' 'importWorkbook' 'real-download-run' 'validateImport' 'createTimer'; do
  if grep -q -- "$tok" "$SELF_DIR/$PRE_NAME" "$SELF_DIR/$GATE_NAME" 2>/dev/null; then
    ck "S 脚本不含「$tok」" 0 "命中：$tok"
  else
    ck "S 脚本不含「$tok」" 1 ""
  fi
done

echo
echo "=== 7. run12.sh 覆盖闸门修复验证（原缺陷：命中后仍继续浏览器/页面预检）==="
R12="$SELF_DIR/run12.sh"
if [ -f "$R12" ]; then
  ck "R1 run12.sh 调用共享闸门（--phase=pre_browser）" "$(grep -q -- '--phase=pre_browser' "$R12" && echo 1 || echo 0)" "未找到"
  ck "R2 run12.sh 命中后硬性 exit（exit \"\$GATE_EXIT\"）" "$(grep -q 'exit "\$GATE_EXIT"' "$R12" && echo 1 || echo 0)" "缺少硬性退出"
  GL=$(grep -n -- '--phase=pre_browser' "$R12" | head -1 | cut -d: -f1)
  EL=$(grep -n 'exit "\$GATE_EXIT"' "$R12" | head -1 | cut -d: -f1)
  BL=$(grep -n 'precheck-set-date.js\|systemctl restart syncbot-browser' "$R12" | head -1 | cut -d: -f1)
  if [ -n "$GL" ] && [ -n "$EL" ] && [ -n "$BL" ]; then
    ck "R3 顺序正确：闸门 → 硬性 exit → 浏览器/预检动作" "$([ "$GL" -lt "$EL" ] && [ "$EL" -lt "$BL" ] && echo 1 || echo 0)" "gate=$GL exit=$EL browser=$BL"
  else
    ck "R3 顺序正确：闸门 → 硬性 exit → 浏览器/预检动作" 0 "gate=${GL:-none} exit=${EL:-none} browser=${BL:-none}"
  fi
  # 动态复刻 run12.sh 的闸门片段（同一语义），验证命中时确实停止
  SNIP="$TMP/r12gate.sh"
  {
    echo 'set -u'
    echo "PY='$PY'"
    echo 'GATE="$1"; DB="$2"; DATE="$3"'
    echo '"$PY" "$GATE" --db="$DB" --date="$DATE" --phase=pre_browser'
    echo 'GATE_EXIT=$?'
    echo 'echo "GATE_EXIT=$GATE_EXIT"'
    echo 'if [ "$GATE_EXIT" -ne 0 ]; then echo "STOP"; exit "$GATE_EXIT"; fi'
    echo 'echo "PROCEED"'
  } > "$SNIP"
  bash "$SNIP" "$SELF_DIR/$GATE_NAME" "$TMPW/covered.db" 2026-09-19 > "$TMP/r12covered.out" 2>&1
  RCV=$?
  ck "R4 命中 → 片段 exit 20 且 STOP（绝不输出 PROCEED）" "$([ "$RCV" = 20 ] && grep -q STOP "$TMP/r12covered.out" && ! grep -q PROCEED "$TMP/r12covered.out" && echo 1 || echo 0)" "exit=$RCV out=$(tr '\n' ' ' < "$TMP/r12covered.out" | tail -c 160)"
  bash "$SNIP" "$SELF_DIR/$GATE_NAME" "$TMPW/clear.db" 2026-09-19 > "$TMP/r12clear.out" 2>&1
  RCV2=$?
  ck "R5 正对照：未命中 → 片段 exit 0 且 PROCEED" "$([ "$RCV2" = 0 ] && grep -q PROCEED "$TMP/r12clear.out" && echo 1 || echo 0)" "exit=$RCV2 out=$(tr '\n' ' ' < "$TMP/r12clear.out" | tail -c 160)"
else
  ck "run12.sh 存在" 0 "未找到 $R12"
fi

echo
echo "=== 结果 ==="
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "SELFTEST_P3_GATE=OK" || echo "SELFTEST_P3_GATE=FAILED"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
