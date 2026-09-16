<template>
  <section class="body-map">
    <header class="bm-head">
      <div class="bm-head-copy">
        <div class="bm-title-row">
          <span :class="['bm-real-bird', animalAssetClass]" aria-hidden="true"></span>
          <div>
            <span class="bm-kicker">真实禽体建模参照</span>
            <h4>{{ title }}</h4>
          </div>
        </div>
        <p>以真实禽体确认品种与整只出成；点击悬浮部位标签可定位到下方表格行。<b>蓝色 = 身体资源池，橙色 = 副产品资源池</b>；灰色 = 该部位还没配置。</p>
      </div>
      <div class="bm-legend">
        <span class="bm-dot body"></span>身体（互抢鸟，需求相加）
        <span class="bm-dot byproduct"></span>副产品（随鸟附带，取最大）
      </div>
    </header>

    <div class="bm-body">
      <div :class="['bm-real-stage', animalAssetClass]" role="img" :aria-label="title">
        <div class="bm-stage-glow"></div>
        <button v-for="label in labels" :key="label.key" :class="['bm-callout', zoneState(label.key), { empty: label.empty }]" :style="{ left: `${label.left}%`, top: `${label.top}%` }" @click="pick(label.key)">
          <span class="bm-callout-name">{{ label.name }}</span><span>{{ label.text }}</span>
        </button>
        <span class="bm-stage-caption">真实 {{ props.animal || '禽类' }} 侧视参照 · 点击标签维护出成</span>
      </div>

      <aside class="bm-side">
        <h5>{{ isGoose ? '整只份量自检' : '拆解配置自检' }}</h5>
        <div v-for="(c, i) in selfCheck" :key="i" :class="['bm-check', c.severity]">
          <div class="bm-check-label"><span class="bm-check-icon">{{ c.icon }}</span>{{ c.label }}</div>
          <div class="bm-check-value">
            <b>{{ c.value }}</b>
            <span v-if="c.detail" class="bm-check-detail">{{ c.detail }}</span>
          </div>
        </div>
        <p v-if="isGoose" class="bm-side-note">
          校验口径：一只鹅的<b>上半身=上庄 2 块</b>、<b>下半身=下庄 2 块</b>，两块合计应等于 100%；<br />
          <b>腿含在下庄之内</b>，所以腿的合计应低于下庄（正常约 30~70%）。<br />
          核算时按 <b>身体 / 腿 / 翅 / 头颈</b> 四个资源池分别算需求只数，<b>取最大者</b>为总只数。
        </p>
        <p v-else class="bm-side-note">
          鸡/鸭只有 <b>整只 / 半只 / 切片肉 / 腿</b> 四类部位（没有上下庄、头颈、翅）。<br />
          核算时按 <b>身体 / 腿</b> 两个资源池分别算需求只数，<b>取最大者</b>为总只数；<br />
          翅与头颈随整只/半只走，不单独卖 → 不建部位也不影响精度。<br />
          鸡翅 <b>单独采购</b> 的，不需要在此建档；对应菜品请在「维护禽类菜范围」里标为「不算」。
        </p>
      </aside>
    </div>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  rows: { type: Array, default: () => [] },
  animal: { type: String, default: '' },
})
const emit = defineEmits(['pick'])

const activeZone = ref('')

const title = computed(() => `${props.animal || '禽'} · 整只部位示意图`)
const animalAssetClass = computed(() => ({ '鹅': 'goose', '鸭': 'duck', '鸡': 'chicken' }[String(props.animal || '').trim()] || 'goose'))

/** 部位名 → 图示区域。优先用库里存的 zone_code（用户可改，改名也不受影响），缺失时才按名称兜底推断 */
const ZONE_SET = new Set(['whole', 'half', 'upper', 'lower', 'leg', 'wing', 'head_neck', 'belly', 'meat', 'other'])
function zoneOf(name, zoneCode) {
  const raw = String(zoneCode || '').trim()
  if (raw && ZONE_SET.has(raw)) return raw
  const n = String(name || '')
  if (/头|颈/.test(n)) return 'head'
  if (/翅|战斧/.test(n)) return 'wing'
  if (/上庄/.test(n)) return 'upper'
  if (/下庄/.test(n)) return 'lower'
  if (/腩/.test(n)) return 'belly'
  if (/腿|肶/.test(n)) return 'leg'
  if (/整只|一只|半只|整鹅|半鹅/.test(n)) return 'whole'
  if (/肉|小料|双拼|三宝|片|单份|三拼|拼量/.test(n)) return 'meat'
  return 'other'
}

// 库里存的是 head_neck，图上是 head；统一映射一次
function toDrawZone(zone) {
  return zone === 'head_neck' ? 'head' : zone
}

const rowsOf = zone => props.rows.filter(r => toDrawZone(zoneOf(r.part_name, r.zone_code)) === zone)
const hasZone = zone => rowsOf(zone).length > 0

// 鹅与鸡/鸭的拆解结构不同：鹅有上下庄/头颈/翅/腩，鸡鸭只有 整只/半只/切片肉/腿
const isGoose = computed(() => String(props.animal || '').trim() === '鹅')

/** 区域状态：已配置（身体/副产品）→ 亮色；选中 → 描边加粗 */
function zoneState(zone) {
  const rows = rowsOf(zone)
  const kinds = rows.map(r => r.part_kind)
  return {
    active: activeZone.value === zone,
    empty: rows.length === 0,
    body: kinds.includes('身体'),
    byproduct: kinds.length > 0 && kinds.every(k => k === '副产品'),
  }
}

function fmtShare(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n <= 1) return '一整只'
  return `1/${Math.round(n * 100) / 100}`
}

const labels = computed(() => {
  const defs = isGoose.value
    ? [
      { zone: 'head', name: '头颈', left: 69, top: 10 },
      { zone: 'wing', name: '翅', left: 19, top: 46 },
      { zone: 'upper', name: '上庄', left: 62, top: 41 },
      { zone: 'lower', name: '下庄', left: 62, top: 59 },
      { zone: 'belly', name: '鹅腩', left: 67, top: 69 },
      { zone: 'leg', name: '鹅腿', left: 42, top: 82 },
      { zone: 'meat', name: '切片肉', left: 61, top: 88 },
    ]
    : [
      { zone: 'whole', name: '整只', left: 59, top: 16 },
      { zone: 'half', name: '半只', left: 69, top: 41 },
      { zone: 'meat', name: '切片肉', left: 57, top: 62 },
      { zone: 'leg', name: '腿', left: 42, top: 83 },
    ]
  return defs.map(d => {
    const rows = rowsOf(d.zone)
    if (!rows.length) return { key: d.zone, ...d, text: '未配置', empty: true }
    const shown = rows.slice(0, 2)
    const text = shown.map(r => `${r.part_name} ${r.parts_per_bird || 0}份(${fmtShare(r.parts_per_bird)})`).join(' ｜ ')
      + (rows.length > shown.length ? ` 等${rows.length}个` : '')
    return { key: d.zone, ...d, text, empty: false }
  })
})

/** 一只禽该部位的总份量占比 = 块数 × (1 ÷ 一只出份数) */
function totalShare(zone, pieces) {
  const rows = rowsOf(zone)
  if (!rows.length) return null
  const per = rows.map(r => Number(r.parts_per_bird) || 0).filter(v => v > 0)
  if (!per.length) return null
  // 多行时取合计（一般每个区域只有一行）
  return per.reduce((sum, v) => sum + pieces / v, 0)
}

const selfCheck = computed(() => {
  const items = []
  const rows = props.rows || []

  // ===== ❌ 错误：物理上不可能，必须先改 =====
  const invalid = rows.filter(r => !(Number(r.parts_per_bird) > 0))
  if (invalid.length) {
    items.push({
      severity: 'error', icon: '❌',
      label: `「${invalid.map(r => r.part_name || '(未命名)').join('、')}」的出成数量为 0 或空`,
      value: '必须大于 0',
      detail: '该部位会被跳过计算，导致只数偏低',
    })
  }
  // 份量型：一只出 < 1 份 ⇒ 一份超过一整只禽
  const overOne = rows.filter(r => (r.yield_mode || 'fraction') === 'fraction'
    && Number(r.parts_per_bird) > 0 && Number(r.parts_per_bird) < 1)
  if (overOne.length) {
    items.push({
      severity: 'error', icon: '❌',
      label: `「${overOne.map(r => r.part_name).join('、')}」单份超过一整只`,
      value: '一只出份数 < 1',
      detail: '份量型口径下「一只出几份」= 1 ÷ 一份占整只比例，不可能小于 1',
    })
  }

  // ===== ⚠️ 风险：鹅专属（上下庄守恒 + 腿含在下庄之内）=====
  const upper = isGoose.value ? totalShare('upper', 2) : null
  const lower = isGoose.value ? totalShare('lower', 2) : null
  if (upper !== null && lower !== null) {
    const sum = upper + lower
    const ok = Math.abs(sum - 1) < 0.03
    items.push({
      severity: ok ? 'info' : 'warn', icon: ok ? '✅' : '⚠️',
      label: '上庄 2 块 + 下庄 2 块 = 一整只身体',
      value: `${Math.round(sum * 100)}%`,
      detail: ok
        ? '上下半身合计刚好一只'
        : sum > 1
          ? '超过一只，可能把「数块数」当成了份量口径'
          : '不足一只，可能有部位没登记，或份量填大了',
    })
  }
  if (isGoose.value) {
    const leg = totalShare('leg', 2)
    if (leg !== null && lower !== null && lower > 0) {
      const ratio = leg / lower
      const ok = ratio > 0.15 && ratio < 0.8
      items.push({
        severity: ok ? 'info' : 'warn', icon: ok ? '✅' : '⚠️',
        label: '腿 2 条占下庄的比例',
        value: `${Math.round(ratio * 100)}%`,
        detail: ok
          ? `正常（下庄合计 ${Math.round(lower * 100)}%）`
          : ratio >= 0.8
            ? '腿几乎等于整个下庄，检查是否该填「一只出 8」（一条腿约占下庄一半）'
            : '腿份量偏小，检查「一只出几份」是否填大了',
      })
    }
  }

  // ===== 鸡 / 鸭专属校验 =====
  if (!isGoose.value) {
    const wholeRows = rowsOf('whole')
    const halfRows = rowsOf('half')
    // ① 半只份数应恰为整只份数的 2 倍（一只 1 → 半只 2）
    if (wholeRows.length && halfRows.length) {
      const w = Number(wholeRows[0].parts_per_bird) || 0
      const h = Number(halfRows[0].parts_per_bird) || 0
      const ok = w > 0 && Math.abs(h - w * 2) < 0.01
      items.push({
        severity: ok ? 'info' : 'warn', icon: ok ? '✅' : '⚠️',
        label: '半只份数 = 整只份数 × 2',
        value: `整只 ${w} / 半只 ${h}`,
        detail: ok
          ? '一只禽沿脊一开二，正好两个半只'
          : `按「一只出 ${w} 份」推，半只应填 ${w * 2}（一份占 1/${w * 2} 只）`,
      })
    }
    // ② 切片肉三者份数应递增：每份用肉递减 → 一只能出的份数递增
    const meatRows = rowsOf('meat')
    if (meatRows.length >= 2) {
      const named = ['单份', '双拼量', '三拼量']
        .map(n => meatRows.find(r => String(r.part_name).includes(n.replace('量', ''))))
        .filter(Boolean)
        .map(r => ({ name: r.part_name, per: Number(r.parts_per_bird) || 0 }))
      const bad = []
      for (let i = 1; i < named.length; i++) {
        if (named[i].per > 0 && named[i - 1].per > 0 && named[i].per <= named[i - 1].per) bad.push(`${named[i - 1].name}(${named[i - 1].per}) → ${named[i].name}(${named[i].per})`)
      }
      items.push({
        severity: bad.length ? 'warn' : 'info', icon: bad.length ? '⚠️' : '✅',
        label: '切片肉份数应递增（每份用肉越少、一只出越多）',
        value: named.map(x => `${x.name} ${x.per}`).join(' ｜ ') || '—',
        detail: bad.length
          ? `这几处没递增，可能填反了：${bad.join('；')}`
          : '顺序正常（参照鹅：鹅肉 11 < 双拼 23 < 三宝 29）',
      })
    }
    // ③ 腿占整只的比例（2 条腿 ÷ 一只出份数）
    const legShare = totalShare('leg', 2)
    if (legShare !== null) {
      const ok = legShare > 0.2 && legShare < 0.6
      items.push({
        severity: ok ? 'info' : 'warn', icon: ok ? '✅' : '⚠️',
        label: '腿 2 条占整只的比例',
        value: `${Math.round(legShare * 100)}%`,
        detail: ok
          ? '正常范围（肉鸡鸭腿通常占整只 20%~60%）'
          : legShare >= 0.6
            ? '腿占比偏高，检查「一只出几份」是否填小了（一份 = 一整条腿时，鸡腿约填 5、鹅腿填 8）'
            : '腿占比偏低，检查份数是否填大了',
      })
    }
    // ④ 提示
    items.push({
      severity: 'info', icon: 'ℹ️',
      label: '鸡/鸭没有上下庄、头颈、翅',
      value: '按 4 类部位配置',
      detail: '翅与头颈随整只/半只走，不单独卖；鸡翅若单独采购，对应菜品到「维护禽类菜范围」标为不算即可',
    })
  }
  // 同一区域多个部位（鹅的切片肉有 4 个口径，目前按相加处理）
  const meatRows = rowsOf('meat')
  if (isGoose.value && meatRows.length > 1) {
    items.push({
      severity: 'info', icon: 'ℹ️',
      label: `切片肉区有 ${meatRows.length} 个部位`,
      value: '按相加处理',
      detail: '若它们取自同一块切片肉（仅装盒不同），相加会偏高；三期会统一成「可切片鹅肉池」按克重折算',
    })
  }

  // ===== ℹ️ 提示 =====
  const hasByproduct = isGoose.value && rows.some(r => r.part_kind === '副产品')
  if (hasByproduct) {
    items.push({
      severity: 'info', icon: 'ℹ️',
      label: '副产品（翅 / 头颈）',
      value: '件数型口径',
      detail: '按一只禽物理产出几件填（翅 2 / 头颈 1）；它们不占身体份量，但会作为独立资源池参与取最大',
    })
  }
  const zoneNames = { whole: '整只', half: '半只', upper: '上庄', lower: '下庄', leg: '腿', meat: '切片肉' }
  const needZones = isGoose.value ? ['upper', 'lower', 'leg'] : ['whole', 'half', 'leg', 'meat']
  const missing = needZones.filter(z => !rowsOf(z).length)
  if (missing.length && rows.length) {
    items.push({
      severity: 'info', icon: 'ℹ️',
      label: `还没配置：${missing.map(z => zoneNames[z]).join('、')}`,
      value: '—',
      detail: isGoose.value
        ? '这些部位参与身体与限量资源约束，漏配会让只数偏低'
        : '整只 / 半只 / 腿 是鸡鸭核算的基础，漏配会让相应约束算不出来',
    })
  }
  if (!items.length) {
    items.push({ severity: 'info', icon: 'ℹ️', label: '还没有配置部位', value: '—', detail: '先填上庄、下庄的「一只出几份」' })
  }
  return items
})

function pick(zone) {
  const rows = rowsOf(zone)
  activeZone.value = zone
  emit('pick', rows)
}
</script>

<style scoped>
.body-map { margin-bottom: 16px; padding: 16px 18px; border: 1px solid #e3e9f2; border-radius: 14px; background: linear-gradient(180deg, #fbfdff, #f6f9fe); }
.bm-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; flex-wrap: wrap; }
.bm-title-row { display: flex; align-items: center; gap: 9px; margin-bottom: 2px; }
.bm-head-copy h4 { margin: 0 0 2px; color: #18345d; font-size: 14px; }
.bm-head-copy p { margin: 0; color: #7b8798; font-size: 12px; line-height: 1.7; }
.bm-head-copy b { color: #3c5a8a; }
.bm-kicker { display: block; color: #7b8ca6; font-size: 10px; font-weight: 750; letter-spacing: .08em; }
.bm-real-bird {
  display: inline-block; flex: 0 0 54px; width: 54px; height: 44px;
  border: 1px solid #dfe8f6; border-radius: 12px;
  background-color: #f8fbff;
  background-image: url('/images/poultry/poultry-models.png');
  background-repeat: no-repeat; background-size: 330% auto;
  box-shadow: 0 4px 12px rgba(33, 68, 125, .08);
}
.bm-real-bird.goose { background-position: 2% 50%; }
.bm-real-bird.duck { background-position: 50% 50%; }
.bm-real-bird.chicken { background-position: 98% 50%; }
.bm-legend { display: flex; align-items: center; gap: 14px; color: #6e7d92; font-size: 11px; white-space: nowrap; }
.bm-dot { display: inline-block; width: 9px; height: 9px; margin-right: 5px; border-radius: 50%; vertical-align: middle; }
.bm-dot.body { background: #4b83e8; }
.bm-dot.byproduct { background: #e0a23c; }
.bm-body { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(240px, .85fr); gap: 18px; align-items: start; }
@media (max-width: 1000px) { .bm-body { grid-template-columns: minmax(0, 1fr); } }
.bm-svg { width: 100%; height: auto; max-height: 460px; }
.bm-real-stage { position: relative; min-height: 368px; overflow: hidden; border: 1px solid #e1e9f4; border-radius: 16px; background-color: #f8fbff; background-image: url('/images/poultry/poultry-models.png'); background-repeat: no-repeat; background-size: 300% auto; box-shadow: inset 0 1px 0 rgba(255,255,255,.8), 0 10px 24px rgba(42,73,119,.05); }
.bm-real-stage.goose { background-position: 0% 54%; }
.bm-real-stage.duck { background-position: 50% 54%; }
.bm-real-stage.chicken { background-position: 100% 54%; }
.bm-stage-glow { position: absolute; inset: auto 8% 7% 9%; height: 22%; border-radius: 50%; background: radial-gradient(ellipse, rgba(61,119,210,.16), rgba(61,119,210,0) 68%); pointer-events: none; }
.bm-callout { position: absolute; z-index: 2; display: flex; flex-direction: column; gap: 2px; max-width: 142px; padding: 6px 8px; border: 1px solid #c9d5e6; border-radius: 9px; background: rgba(255,255,255,.9); box-shadow: 0 5px 14px rgba(37,68,111,.12); color: #5e7088; font-size: 10px; line-height: 1.35; text-align: left; transform: translate(-50%,-50%); cursor: pointer; backdrop-filter: blur(8px); transition: transform .16s ease, box-shadow .16s ease, border-color .16s ease; }
.bm-callout:hover,.bm-callout.active { z-index: 3; border-color: #397de1; box-shadow: 0 9px 19px rgba(45,103,190,.2); transform: translate(-50%,-50%) scale(1.035); }
.bm-callout-name { color: #2e4a6f; font-size: 11px; font-weight: 800; }
.bm-callout.body { border-color: #91b9f2; background: rgba(240,247,255,.94); }
.bm-callout.body .bm-callout-name { color: #2265bd; }
.bm-callout.byproduct { border-color: #f0bf68; background: rgba(255,249,237,.95); }
.bm-callout.byproduct .bm-callout-name { color: #ad7517; }
.bm-callout.empty { border-style: dashed; background: rgba(249,251,254,.88); color: #9aa8b9; }
.bm-callout.empty .bm-callout-name { color: #7d8d9f; }
.bm-stage-caption { position: absolute; right: 13px; bottom: 10px; color: #7d8fa8; font-size: 10px; letter-spacing: .02em; }
@media (max-width: 640px) { .bm-real-stage { min-height: 330px; background-size: 330% auto; }.bm-callout { max-width: 112px; padding: 5px 6px; font-size: 9px; }.bm-stage-caption { display: none; } }

/* 区域通用样式：未配置 = 灰虚线；身体 = 蓝；副产品 = 橙 */
.bm-zone rect,
.bm-zone ellipse,
.bm-zone path {
  fill: #eef2f8;
  stroke: #c6d2e3;
  stroke-width: 1.6;
  stroke-dasharray: 5 4;
  cursor: pointer;
  transition: fill .15s, stroke .15s;
}
.bm-zone:hover rect,
.bm-zone:hover ellipse,
.bm-zone:hover path { fill: #dfeaff; stroke: #7ba4ea; }
.bm-zone.body rect,
.bm-zone.body ellipse,
.bm-zone.body path { fill: #d9e7ff; stroke: #6d9bea; stroke-dasharray: none; }
.bm-zone.byproduct rect,
.bm-zone.byproduct ellipse,
.bm-zone.byproduct path { fill: #fdeed3; stroke: #dfa73f; stroke-dasharray: none; }
.bm-zone.body:hover rect,
.bm-zone.body:hover ellipse,
.bm-zone.body:hover path { fill: #c6dcff; }
.bm-zone.byproduct:hover rect,
.bm-zone.byproduct:hover ellipse,
.bm-zone.byproduct:hover path { fill: #fbe2b6; }
.bm-zone.active rect,
.bm-zone.active ellipse,
.bm-zone.active path { stroke: #1f5fd0; stroke-width: 2.6; }
/* 整只/半只：只描边不填充，避免盖住中间的部位 */
.bm-zone.whole rect { fill: none; stroke: #9db4d6; stroke-dasharray: 8 6; }
.bm-zone.whole:hover rect { fill: rgba(157, 180, 214, .12); }
/* 切片肉区：用绿色系与"整块部位"区分 */
.bm-zone.meat rect { fill: #e4f5ea; stroke: #6cbb8c; }
.bm-zone.meat:hover rect { fill: #d3eedd; }
.bm-label { fill: #2f4463; font-size: 11px; font-weight: 650; text-anchor: middle; pointer-events: none; }
.bm-label.empty { fill: #a8b2c1; font-weight: 500; }
/* 鸡/鸭图里"半只（左/右）"这类辅助小字 */
.bm-sub { fill: #93a2b8; font-size: 10px; text-anchor: middle; pointer-events: none; }

.bm-side { padding: 14px; border: 1px solid #e3e9f2; border-radius: 12px; background: #fff; }
.bm-side h5 { margin: 0 0 10px; color: #18345d; font-size: 13px; }
/* 自检三档：❌错误（物理不可能）/ ⚠️风险（可能填错）/ ℹ️提示（✅ 也归入提示档，绿色） */
.bm-check { padding: 9px 11px; border-radius: 9px; margin-bottom: 8px; }
.bm-check.info { border: 1px solid #cdeadd; background: #f4fcf8; }
.bm-check.warn { border: 1px solid #f3d9b0; background: #fffaf0; }
.bm-check.error { border: 1px solid #f2c4c1; background: #fff5f4; }
.bm-check-icon { margin-right: 5px; }
.bm-check-label { color: #6e7d92; font-size: 11px; line-height: 1.6; }
.bm-check-value { display: flex; align-items: baseline; gap: 8px; margin-top: 3px; flex-wrap: wrap; }
.bm-check-value b { color: #1f3f6e; font-size: 15px; font-variant-numeric: tabular-nums; }
.bm-check.warn .bm-check-value b { color: #b8760f; }
.bm-check.error .bm-check-value b { color: #c0392b; }
.bm-check-detail { color: #8b96a6; font-size: 11px; line-height: 1.6; }
.bm-check.warn .bm-check-detail { color: #a8761f; }
.bm-check.error .bm-check-detail { color: #b0574c; }
.bm-side-note { margin: 10px 0 0; color: #98a2b1; font-size: 11px; line-height: 1.85; }
.bm-side-note b { color: #6e7d92; }
</style>
