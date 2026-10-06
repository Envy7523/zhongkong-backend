#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""业务日期「区间覆盖」闸门（**只读**、**fail-closed**）

判定语义（区间覆盖，而非精确日期相等）：

    命中 = 存在批次满足
           source_type='pos' AND platform='收银系统综合营业统计'
           AND date_from <= 目标日期 AND date_to >= 目标日期

退出码：
    0  = 无覆盖（clear）        → 允许继续
    20 = 命中覆盖（covered）    → 必须停止：不导出、不导入、不推送
    21 = 无法判定（unknown）    → 同样必须停止（DB 缺失/不可读/结构异常，绝不"当作没覆盖"）
    2  = 参数非法

设计要点：
  - 只读打开（uri mode=ro + PRAGMA query_only=ON），绝无写入；
  - fail-closed：任何异常都返回 21 而不是 0；
  - 三个检查点共用本脚本，仅以 --phase 标注（pre_browser / pre_export / pre_import）。
"""
import argparse
import datetime
import json
import os
import re
import sqlite3
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

EXIT_ALLOW = 0
EXIT_HIT = 20
EXIT_UNKNOWN = 21
EXIT_USAGE = 2

PHASES = ('pre_browser', 'pre_export', 'pre_import')
DEFAULT_SOURCE_TYPE = 'pos'
DEFAULT_PLATFORM = '收银系统综合营业统计'
DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')


def strict_date(value):
    """严格 YYYY-MM-DD 且必须是真实存在的日历日期；不合法返回 None"""
    s = str(value if value is not None else '').strip()
    if not DATE_RE.match(s):
        return None
    try:
        datetime.date(int(s[0:4]), int(s[5:7]), int(s[8:10]))
    except ValueError:
        return None
    return s


def find_covering(db_path, date, source_type=DEFAULT_SOURCE_TYPE, platform=DEFAULT_PLATFORM):
    con = sqlite3.connect('file:%s?mode=ro' % db_path, uri=True)
    try:
        con.execute('PRAGMA query_only=ON')
        cur = con.cursor()
        cur.execute(
            'SELECT id,source_type,platform,file_name,row_count,date_from,date_to,imported_by_name,created_at '
            'FROM business_import_batches '
            'WHERE source_type=? AND platform=? AND date_from<=? AND date_to>=? '
            'ORDER BY id',
            (source_type, platform, date, date))
        cols = [c[0] for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]
    finally:
        con.close()


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False, indent=1))


def main(argv=None):
    ap = argparse.ArgumentParser(description='业务日期区间覆盖闸门（只读、fail-closed）')
    ap.add_argument('--db', required=True)
    ap.add_argument('--date', required=True)
    ap.add_argument('--phase', default='pre_browser', choices=PHASES)
    ap.add_argument('--source-type', default=DEFAULT_SOURCE_TYPE)
    ap.add_argument('--platform', default=DEFAULT_PLATFORM)
    a = ap.parse_args(argv)

    date = strict_date(a.date)
    if not date:
        emit({'ok': False, 'phase': a.phase, 'date': a.date, 'verdict': 'usage_error', 'must_stop': True,
              'reason': '--date 必须严格为 YYYY-MM-DD 且为真实存在的日历日期'})
        return EXIT_USAGE

    if not os.path.exists(a.db):
        emit({'ok': False, 'phase': a.phase, 'date': date, 'verdict': 'unknown', 'must_stop': True,
              'reason': 'db_missing: %s' % a.db, 'hit_count': None, 'hits': []})
        return EXIT_UNKNOWN

    try:
        hits = find_covering(a.db, date, a.source_type, a.platform)
    except Exception as e:
        emit({'ok': False, 'phase': a.phase, 'date': date, 'verdict': 'unknown', 'must_stop': True,
              'reason': 'db_unreadable: %s' % str(e)[:200], 'hit_count': None, 'hits': []})
        return EXIT_UNKNOWN

    hit = len(hits) > 0
    emit({
        'ok': not hit,
        'phase': a.phase,
        'date': date,
        'verdict': 'covered' if hit else 'clear',
        'must_stop': hit,
        'hit_count': len(hits),
        'hits': hits,
        'rule': "source_type='%s' AND platform='%s' AND date_from<=%s AND date_to>=%s" % (
            a.source_type, a.platform, date, date),
        'note': '命中=该业务日期已被 pos 综合营业统计批次区间覆盖；必须停止，不导出、不导入、不推送',
    })
    return EXIT_HIT if hit else EXIT_ALLOW


if __name__ == '__main__':
    sys.exit(main())
