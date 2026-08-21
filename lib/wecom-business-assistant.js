/**
 * 企业微信经营问答（第一版）
 *
 * 不依赖外部 AI：先用确定性规则识别经营查询条件，再调用项目已有
 * businessAnalytics 模块。这样既能立即用于测试，也为后续接入 AI 意图
 * 识别保留统一的 answer(content) 入口。
 */

function normalText(value) {
  return String(value || '').trim().replace(/[，,。！？!?]/g, ' ').replace(/\s+/g, ' ');
}

function isoDate(year, month, day) {
  const d = new Date(year, month - 1, day);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function monthRange(year, month) {
  const lastDay = new Date(year, month, 0).getDate();
  return { from: isoDate(year, month, 1), to: isoDate(year, month, lastDay), label: `${year}年${month}月` };
}

function dayRange(date, label) {
  const value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return { from: value, to: value, label };
}

function weekRange(now, offset, label) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekday = start.getDay() || 7;
  start.setDate(start.getDate() - weekday + 1 + offset * 7);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return {
    from: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`,
    to: `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`,
    label,
  };
}

function dateFromMatch(match, currentYear) {
  if (!match) return null;
  const year = Number(match[1] || currentYear);
  return isoDate(year, Number(match[2]), Number(match[3]));
}

function parseTime(text, now = new Date()) {
  const currentYear = now.getFullYear();
  const range = text.match(/(?:(\d{4})[年./-])?(\d{1,2})月?(\d{1,2})[日号]?(?:\s*(?:至|到|~|—|\-|—)\s*)(?:(\d{4})[年./-])?(\d{1,2})月?(\d{1,2})[日号]?/);
  if (range) {
    const from = dateFromMatch([null, range[1], range[2], range[3]], currentYear);
    const to = dateFromMatch([null, range[4], range[5], range[6]], currentYear);
    if (from && to) return { from, to, label: `${from} 至 ${to}` };
  }

  const fullMonth = text.match(/(\d{4})年\s*(\d{1,2})月(?!\s*\d)/);
  if (fullMonth) return monthRange(Number(fullMonth[1]), Number(fullMonth[2]));
  const currentMonth = text.match(/(?<!\d)(\d{1,2})月(?!\s*\d)/);
  if (currentMonth) return monthRange(currentYear, Number(currentMonth[1]));

  const fullDate = text.match(/(?:(\d{4})[年./-])?(\d{1,2})月?(\d{1,2})[日号]?/);
  if (fullDate) {
    const date = dateFromMatch(fullDate, currentYear);
    return { from: date, to: date, label: date };
  }

  if (/今天|今日/.test(text)) return dayRange(now, '今天');
  if (/昨天/.test(text)) { const d = new Date(now); d.setDate(d.getDate() - 1); return dayRange(d, '昨天'); }
  if (/前天/.test(text)) { const d = new Date(now); d.setDate(d.getDate() - 2); return dayRange(d, '前天'); }
  if (/本周|这周/.test(text)) return weekRange(now, 0, '本周（周一至周日）');
  if (/上周/.test(text)) return weekRange(now, -1, '上周（周一至周日）');
  if (/本月|这个月/.test(text)) return monthRange(now.getFullYear(), now.getMonth() + 1);
  if (/上月|上个月/.test(text)) {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return monthRange(d.getFullYear(), d.getMonth() + 1);
  }
  return null;
}

const PLATFORM_RULES = [
  { words: ['美团外卖'], scope: 'delivery', platform: '美团外卖', label: '美团外卖' },
  { words: ['淘宝闪购', '淘宝外卖'], scope: 'delivery', platform: '淘宝闪购', label: '淘宝闪购' },
  { words: ['京东外卖'], scope: 'delivery', platform: '京东外卖', label: '京东外卖' },
  { words: ['美团免费试', '免费试'], scope: 'group_buy', platform: '免费试', label: '美团免费试' },
  { words: ['抖音团购', '抖音'], scope: 'group_buy', platform: '抖音团购', label: '抖音团购' },
  { words: ['美团团购', '大众点评团购'], scope: 'group_buy', platform: '美团团购', label: '美团团购' },
];

// 聚合查询必须按业务规定补齐平台，即使某个平台当期没有记录也展示为 0。
// 这样企业微信中的“外卖”口径与数据分析页面保持一致，不会把“无记录”误说成“未识别”。
const SCOPE_PLATFORMS = {
  delivery: [
    { channel: 'meituan_delivery', label: '美团外卖' },
    { channel: 'taobao_flash', label: '淘宝闪购' },
    { channel: 'jd_delivery', label: '京东外卖' },
  ],
  group_buy: [
    { channel: 'meituan_group', label: '美团团购' },
    { channel: 'douyin_group', label: '抖音团购' },
    { channel: 'free_trial', label: '美团免费试' },
  ],
};

function parseScope(text) {
  const platform = PLATFORM_RULES.find(rule => rule.words.some(word => text.includes(word)));
  if (platform) return { ...platform };
  if (/团购/.test(text)) return { scope: 'group_buy', platform: '', label: '团购' };
  if (/外卖/.test(text)) return { scope: 'delivery', platform: '', label: '外卖' };
  return { scope: 'overview', platform: '', label: '总数据' };
}

function comparableStoreName(name) {
  return String(name || '')
    .replace(/鹅太公烧鹅|鹅太公|烧鹅/g, '')
    .replace(/[（）()\s·]/g, '')
    .toLowerCase();
}

function findStore(db, text) {
  const compactInput = comparableStoreName(text);
  const stores = db.queryAll('SELECT id,store_name FROM stores ORDER BY store_name');
  const matches = stores.filter(store => {
    const compactName = comparableStoreName(store.store_name);
    return compactName.length >= 3 && (compactInput.includes(compactName) || compactName.includes(compactInput));
  });
  if (matches.length === 1) return { store: matches[0], candidates: [] };

  // 对“布吉菁华园”这类简称，使用括号内或去品牌后的地名再次匹配。
  const shortMatches = stores.filter(store => {
    const shortName = comparableStoreName(store.store_name);
    return shortName.length >= 3 && compactInput.includes(shortName);
  });
  return { store: null, candidates: shortMatches.slice(0, 4) };
}

function parseMetrics(text) {
  const metrics = [];
  if (/营业额|营业总额|交易额/.test(text)) metrics.push('gross');
  if (/实收|营业收入|收入/.test(text)) metrics.push('actual');
  if (/订单量|订单数|订单/.test(text)) metrics.push('orders');
  if (/优惠金额|优惠|折扣/.test(text)) metrics.push('discount');
  if (/客单价/.test(text)) metrics.push('perOrder');
  return [...new Set(metrics.length ? metrics : ['gross', 'actual', 'orders', 'discount'])];
}

function currency(value) {
  return `¥${Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function makeHelpReply() {
  return '我是鹅太公经营助手。当前可以查询营业额、实收、订单量、优惠金额和客单价。\n\n例如：\n• 查询昨天全门店营业额\n• 查询布吉菁华园 2026年7月实收\n• 美团外卖本周订单量\n• 抖音团购 7月1日到7月7日经营数据';
}

function aiSettings(rawConfig = {}) {
  if (rawConfig.aiMode === 'local-simulation') {
    return { enabled: Boolean(rawConfig.aiEnabled), mode: 'local', model: '本地模拟解读', profileName: '本地模拟解读' };
  }
  const baseUrl = String(rawConfig.aiBaseUrl || '').trim().replace(/\/$/, '');
  const model = String(rawConfig.aiModel || '').trim();
  const apiKey = String(rawConfig.aiApiKey || '').trim();
  return {
    enabled: Boolean(rawConfig.aiEnabled && baseUrl && model && apiKey),
    mode: 'api',
    baseUrl,
    model,
    apiKey,
    profileName: String(rawConfig.aiProfileName || model),
  };
}

function buildLocalInsight(facts = {}) {
  const gross = Number(facts.gross || 0);
  const actual = Number(facts.actual || 0);
  const discount = Number(facts.discount || 0);
  const orders = Number(facts.orders || 0);
  const lines = [];
  if (gross > 0) lines.push(`实收率为 ${(actual / gross * 100).toFixed(1)}%，优惠金额占营业额 ${(discount / gross * 100).toFixed(1)}%。`);
  if (orders > 0) lines.push(`按实收计算，当前客单价约为 ${currency(actual / orders)}。`);
  if (discount / Math.max(gross, 1) >= 0.2) lines.push('优惠占比较高，建议结合渠道和门店明细检查优惠投放的转化效果。');
  else lines.push('可继续追问渠道或门店维度，定位经营表现的主要来源。');
  return lines.map((line, index) => `${index + 1}. ${line}`).join('\n');
}

function buildScopeBreakdown(scope, scopedOverview, totalOverview) {
  const platforms = SCOPE_PLATFORMS[scope.scope];
  if (!platforms || scope.platform) return { lines: [], facts: {} };
  const amountByChannel = new Map((scopedOverview.channel_breakdown || []).map(row => [row.channel, Number(row.amount || 0)]));
  const scopeActual = Number(scopedOverview.totals?.confirmed || 0);
  const totalActual = Number(totalOverview.totals?.confirmed || 0);
  const scopeName = scope.scope === 'delivery' ? '外卖' : '团购';
  const platformAmounts = platforms.map(platform => ({ ...platform, actual: amountByChannel.get(platform.channel) || 0 }));
  const lines = [
    `${scopeName}平台（共 ${platforms.length} 个）：`,
    ...platformAmounts.map(platform => `${platform.label}实收：${currency(platform.actual)}`),
    `${scopeName}实收合计：${currency(scopeActual)}`,
    `门店总实收：${currency(totalActual)}`,
    `${scopeName}实收占比：${totalActual ? `${(scopeActual / totalActual * 100).toFixed(1)}%` : '0.0%'}`,
  ];
  return {
    lines,
    facts: {
      scopeName,
      scopeActual,
      totalActual,
      scopeRatio: totalActual ? scopeActual / totalActual : 0,
      platforms: platformAmounts,
    },
  };
}

async function requestAiExplanation(settings, question, factReply) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${settings.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        temperature: 0.2,
        max_tokens: 420,
        messages: [
          {
            role: 'system',
            content: '你是餐饮经营分析助手。只能基于已给出的事实数据做简短中文解读，不能编造数字、门店、时间或原因。不要重复整段数据；输出 2-4 条简洁观察或建议。若已核验数据包含平台明细、总实收和实收占比，必须承认这些数据已经具备，不得声称缺少总营收或渠道数据。',
          },
          {
            role: 'user',
            content: `用户问题：${question}\n\n已核验的数据：\n${factReply}`,
          },
        ],
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message || `模型接口返回 ${response.status}`);
    const content = payload?.choices?.[0]?.message?.content;
    if (!content || typeof content !== 'string') throw new Error('模型未返回可用文本');
    return content.trim().slice(0, 1800);
  } finally {
    clearTimeout(timeout);
  }
}

function createBusinessAssistant({ db, businessAnalytics, getAiConfig = () => ({}) }) {
  function answerWithRules(content) {
    const text = normalText(content);
    if (!text || /^(帮助|使用说明|你能做什么|你好|hi|hello)$/i.test(text)) {
      return { reply: makeHelpReply(), interpreted: { type: 'help' } };
    }

    const time = parseTime(text);
    if (!time) {
      return {
        reply: '请补充查询时间，我才能准确回答。\n例如："查询昨天全门店营业额"、"布吉菁华园 2026年7月实收"。',
        interpreted: { type: 'need_time' },
      };
    }

    const scope = parseScope(text);
    const storeResult = findStore(db, text);
    if (storeResult.candidates.length > 1) {
      return {
        reply: `我找到了多个可能的门店：${storeResult.candidates.map(item => item.store_name).join('、')}。请补充更完整的门店名称。`,
        interpreted: { type: 'need_store', candidates: storeResult.candidates.map(item => item.store_name) },
      };
    }

    const params = { date_from: time.from, date_to: time.to };
    if (scope.scope !== 'overview') params.channel_group = scope.scope;
    if (scope.platform) params.platform = scope.platform;
    if (storeResult.store) params.store_id = storeResult.store.id;

    const overview = businessAnalytics.getOverview(db, params);
    // 分渠道查询仍需基于同一门店、同一时间计算门店总实收，才能得到正确占比。
    const totalParams = { date_from: time.from, date_to: time.to };
    if (storeResult.store) totalParams.store_id = storeResult.store.id;
    const totalOverview = scope.scope === 'overview' ? overview : businessAnalytics.getOverview(db, totalParams);
    const totals = overview.totals || {};
    const hasRecords = (overview.channel_breakdown || []).length > 0;
    const scopeLabel = [scope.label, storeResult.store?.store_name, time.label].filter(Boolean).join(' · ');
    if (!hasRecords) {
      return {
        reply: `📊 经营数据查询\n范围：${scopeLabel}\n\n该范围暂无已导入的营业数据。请确认时间、门店或平台，并先完成数据导入。`,
        interpreted: { type: 'query', scope: scope.label, store: storeResult.store?.store_name || '全门店', period: time, no_data: true },
      };
    }

    const actual = Number(totals.confirmed || 0);
    const discount = Number(totals.discount_amount || 0);
    const values = {
      gross: actual + discount,
      actual,
      orders: Number(totals.order_count || 0),
      discount,
      perOrder: Number(totals.order_count || 0) ? actual / Number(totals.order_count) : 0,
    };
    const metricLines = parseMetrics(text).map(metric => ({
      gross: `营业额：${currency(values.gross)}`,
      actual: `实收：${currency(values.actual)}`,
      orders: `订单量：${values.orders.toLocaleString('zh-CN')} 单`,
      discount: `优惠金额：${currency(values.discount)}`,
      perOrder: `客单价：${currency(values.perOrder)}`,
    }[metric]));
    const scopeBreakdown = buildScopeBreakdown(scope, overview, totalOverview);
    return {
      reply: `📊 经营数据查询\n范围：${scopeLabel}\n\n${metricLines.join('\n')}${scopeBreakdown.lines.length ? `\n\n${scopeBreakdown.lines.join('\n')}` : ''}\n\n数据来自当前项目已导入的营业数据。`,
      interpreted: { type: 'query', scope: scope.label, store: storeResult.store?.store_name || '全门店', period: time, metrics: parseMetrics(text), facts: { ...values, ...scopeBreakdown.facts } },
    };
  }

  async function answer(content) {
    const ruleResult = answerWithRules(content);
    const settings = aiSettings(getAiConfig());
    if (!settings.enabled || ruleResult.interpreted?.type !== 'query' || ruleResult.interpreted?.no_data) {
      return { ...ruleResult, ai_mode: 'default' };
    }
    if (settings.mode === 'local') {
      return {
        ...ruleResult,
        reply: `${ruleResult.reply}\n\n🤖 本地模拟解读\n${buildLocalInsight(ruleResult.interpreted.facts)}`,
        ai_mode: 'local-simulation',
        ai_model: settings.model,
      };
    }
    try {
      const explanation = await requestAiExplanation(settings, normalText(content), ruleResult.reply);
      return {
        ...ruleResult,
        reply: `${ruleResult.reply}\n\n🤖 AI 解读（${settings.profileName}）\n${explanation}`,
        ai_mode: 'enabled',
        ai_model: settings.model,
      };
    } catch (error) {
      return {
        ...ruleResult,
        reply: `${ruleResult.reply}\n\n🤖 AI 解读暂不可用，已按默认规则返回数据。`,
        ai_mode: 'fallback',
        ai_error: error.message,
      };
    }
  }

  return { answer, help: makeHelpReply };
}

module.exports = { createBusinessAssistant, parseTime, parseScope, parseMetrics };
