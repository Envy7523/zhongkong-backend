/**
 * 菜品识别 / 匹配的唯一实现（堂食、团购、外卖三处菜品关联共用，规则只维护这一处）。
 *
 * 为什么要有这个模块：原先「堂食菜品绑定」用 server.js 里的 buildDishMenuIndex / resolveDishMenuSmart，
 * 而「团购/外卖菜品绑定」用另一套平台规则（名称归一化、规格词、系列匹配、复用其他平台绑定）。
 * 两套并存导致同一个商品在三处页面识别结果不同、界面提示也不同。现在统一为：
 *
 *   ① 平台名预处理（platformProductName）：只剥离平台特有的营销标签与赠品信息，不清除菜品主体
 *   ② 共享核心（resolveDishMenuSmart）：手工绑定 → 菜品编码=skuid（名称互校）→ 名称+规格唯一 → 名称唯一
 *   ③ 都没命中时给相似度候选（suggestDishCandidates）：只提示、绝不自动绑定
 *   ④ 平台专有兜底（uniqueContainedMenuId / uniqueDishAndSpecMenuId / uniqueShortCoreMenuId / 跨平台复用）
 *      —— 保留原有能力，作为核心规则之后的兜底层
 *
 * 不依赖 server.js，也不依赖业务模块，纯函数 + 一个 db 参数，方便两条链路复用与单测。
 */

const RECOMMEND_REASON_LABELS = {
  skuid: '菜品编码匹配',
  name_spec: '名称+规格匹配',
  name: '名称唯一匹配',
  manual: '手工绑定',
  platform: '平台名称匹配',
  series: '菜品系列匹配',
  dish_spec: '菜名+规格词匹配',
  reuse: '复用其他平台绑定',
  short_core: '简称唯一匹配',
};

/** 规格归一化：与 server.js / dish_sales_mappings 唯一键口径保持一致 */
function normalizeDishSpec(value) {
  const text = String(value || '').trim();
  return (text === '' || text === '--') ? '' : text;
}

/** 菜名归一化：去掉【】（）[] 与空白 —— 解决「【太公推介】金牌烧鸭拼叉烧单人餐」这类前后缀匹配不上的问题 */
function dishMenuKey(value) {
  return String(value || '').replace(/[【】\[\]（）()\s]/g, '').trim();
}

/** 绑定时名称不是唯一标识：上庄、下庄、半只等规格售价不同，必须完整展示为 SKU */
function withDishMenuSku(menu = {}) {
  const name = String(menu.name || '').trim();
  const spec = normalizeDishSpec(menu.spec);
  const method = String(menu.method || '').trim();
  const unit = String(menu.spec_unit || '').trim();
  const weight = String(menu.spec_weight || '').trim();
  const parts = [];
  [spec, method && method !== '/' ? method : '', weight || unit].filter(Boolean).forEach(part => {
    if (!parts.includes(part)) parts.push(part);
  });
  const dineInPrice = Number(menu.dine_in_price || menu.price) || 0;
  const memberPrice = Number(menu.member_price) || 0;
  const takeoutPrice = Number(menu.takeout_price) || 0;
  const priceSummary = [
    dineInPrice ? `堂食 ¥${dineInPrice.toFixed(2)}` : '',
    memberPrice ? `会员 ¥${memberPrice.toFixed(2)}` : '',
    takeoutPrice ? `外卖 ¥${takeoutPrice.toFixed(2)}` : '',
  ].filter(Boolean).join(' / ');
  return {
    ...menu,
    sku_label: `${name}${parts.length ? ` · ${parts.join(' · ')}` : ''}`,
    sku_variant: parts.join(' · ') || '标准规格',
    sku_price_summary: priceSummary || '价格未设置',
  };
}

/**
 * 构建识别索引：一次性载入在售菜品（排除员工餐），可额外补入已下架但被手工绑定的菜品。
 * @param {object} db
 * @param {Array<number>} extraIds 额外补入的菜品 id（手工绑定可能指向已下架菜品）
 */
function buildDishMenuIndex(db, extraIds = []) {
  const menus = db.queryAll(`SELECT id,name,category,method,spec,spec_unit,spec_weight,cost,skuid
    FROM menu_items WHERE status='在售' AND INSTR(name,'员工餐')=0`).map(withDishMenuSku);
  const menuById = new Map(menus.map(menu => [Number(menu.id), menu]));
  const missing = [...new Set(extraIds.map(Number).filter(Boolean))].filter(id => !menuById.has(id));
  if (missing.length) {
    db.queryAll(`SELECT id,name,category,method,spec,spec_unit,spec_weight,cost,skuid FROM menu_items
      WHERE id IN (${missing.map(() => '?').join(',')})`, missing)
      .map(withDishMenuSku).forEach(menu => menuById.set(Number(menu.id), menu));
  }
  const menuBySkuid = new Map(menus.filter(menu => String(menu.skuid || '').trim()).map(menu => [String(menu.skuid).trim(), menu]));
  const menusByName = new Map();
  const menusByNameSpec = new Map();
  menus.forEach(menu => {
    const nameKey = dishMenuKey(menu.name);
    menusByName.set(nameKey, [...(menusByName.get(nameKey) || []), menu]);
    const specKey = `${nameKey}|${normalizeDishSpec(menu.spec)}`;
    menusByNameSpec.set(specKey, [...(menusByNameSpec.get(specKey) || []), menu]);
  });
  return { menus, menuById, menuBySkuid, menusByName, menusByNameSpec };
}

/** 按优先级识别单个销售分组；reason: manual | skuid | name_spec | name | ''(未命中) */
function resolveDishMenuSmart(index, group) {
  const onlyOne = list => (list && list.length === 1 ? list[0] : null);
  const manual = group.menu_item_id ? index.menuById.get(Number(group.menu_item_id)) : null;
  if (manual) return { menu: manual, reason: 'manual' };
  const nameKey = dishMenuKey(group.product_name);
  if (!nameKey) return { menu: null, reason: '' };
  const coded = index.menuBySkuid.get(String(group.product_code || '').trim());
  // 编码与名称互相校验，避免把「金牌烧鸭饭」错归到另一道菜
  if (coded && dishMenuKey(coded.name) === nameKey) return { menu: coded, reason: 'skuid' };
  const bySpec = onlyOne(index.menusByNameSpec.get(`${nameKey}|${normalizeDishSpec(group.spec)}`));
  if (bySpec) return { menu: bySpec, reason: 'name_spec' };
  const byName = onlyOne(index.menusByName.get(nameKey));
  if (byName) return { menu: byName, reason: 'name' };
  return { menu: null, reason: '' };
}

/** 最长公共连续子串长度（菜名很短，O(n·m) 足够快） */
function longestCommonSubstring(a, b) {
  if (!a || !b) return 0;
  let best = 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

/**
 * 菜名相似度（0~1），四项加权，对中文菜名稳定且可解释：
 *  ① Jaccard（字符集交并比）—— 基础相似度
 *  ② containment = 交集 ÷ 短名长度 —— 销售名常带套餐描述（含时蔬+靓汤），Jaccard 会被长名稀释
 *  ③ 最长公共连续子串占比 —— **顺序信息**，区分「烧鹅饭 ⊂ 招牌烧鹅饭」（连续命中）与「烧肉拼烧鹅饭」（字符凑巧）
 *  ④ 长度比 —— **防短名噪声**：否则「【太公三宝饭】含时蔬+海咸鸭蛋+例汤」会把「咸鸭蛋」当成候选
 *  整体包含时再加一点权重（最强信号）
 * 实测：「烧鹅饭」→ 招牌烧鹅饭 0.86 / 烧肉拼烧鹅饭 0.70；
 *       「太公三宝饭 x2」→ 太公烧鹅三宝饭 0.77；
 *       「太公白米饭」（0.55）与「咸鸭蛋」噪声（0.54）均被 0.6 阈值挡掉
 */
function similarityFromKeys(keyA, keyB) {
  if (!keyA || !keyB) return 0;
  const setA = new Set(keyA);
  const setB = new Set(keyB);
  let inter = 0;
  setA.forEach(ch => { if (setB.has(ch)) inter += 1; });
  const jaccard = inter / (setA.size + setB.size - inter);
  const containment = inter / Math.min(setA.size, setB.size);
  const lcsRatio = longestCommonSubstring(keyA, keyB) / Math.min(keyA.length, keyB.length);
  const lengthRatio = Math.min(keyA.length, keyB.length) / Math.max(keyA.length, keyB.length);
  let score = 0.45 * jaccard + 0.25 * containment + 0.15 * lcsRatio + 0.15 * lengthRatio;
  if (keyA.includes(keyB) || keyB.includes(keyA)) score = Math.min(1, score + 0.1);
  return score;
}
function dishNameSimilarity(a, b) {
  return similarityFromKeys(dishMenuKey(a), dishMenuKey(b));
}

/**
 * 「疑似候选」专用的名称清洗：把平台名里的配菜/赠品/营销尾巴削掉，再算相似度。
 * 为什么可以比自动绑定链路更激进：候选**只提示、永不自动绑定**，错了也只是多给一个选项；
 * 而自动绑定链路（productBindingNameKey / deliveryBindingNameKey）必须保守。
 * 外卖名典型形态：「【太公烧鹅饭】含时蔬+海咸鸭蛋」→「太公烧鹅饭」。
 */
function candidateName(value) {
  return String(value || '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[+＋][^\s+＋]*/g, '')
    .replace(/[【】\[\]]/g, '')
    .replace(/(?:新客专享|外卖专享|限时特惠|热销推荐|超值|爆款|人气|新品|推荐|必点|专享|福利|斩料节|鲜烧鲜卖|招牌)/g, '')
    .replace(/(?:含|配|送|赠)(?:时蔬|海咸鸭蛋|咸鸭蛋|例汤|靓汤|柠檬茶|小菜|饮品|青菜|蔬菜)/g, '')
    .replace(/(?:时蔬|海咸鸭蛋|咸鸭蛋|例汤|靓汤|柠檬茶|小菜|单人餐|双人餐|两人餐|套餐)/g, '')
    .trim();
}

/**
 * 疑似候选：精确规则没命中时，按名称相似度给出候选。
 * ⚠️ **只提示、绝不自动绑定** —— 项目方针：别名/套餐只做推荐不做自动绑，避免把套餐成本算错；
 * 用户在界面上点一下才采用（走正常的绑定接口）。
 * @param {Function} [normalize] 可选的名称清洗（平台链路传 candidateName），清洗后两侧一起参与评分
 */
function suggestDishCandidates(index, group, limit = 3, threshold = 0.6, normalize = null) {
  const norm = normalize || (v => v);
  const saleKey = dishMenuKey(norm(group.product_name));
  if (!saleKey) return [];
  const scored = [];
  for (const menu of index.menus) {
    // 员工餐菜品（「（员工）xxx」）不作为候选 —— 用户要绑的是正常售卖菜品
    if (String(menu.name || '').includes('员工')) continue;
    const menuKey = dishMenuKey(norm(menu.name));
    if (!menuKey) continue;
    // 未清洗时保留原有防噪声门槛：否则「【太公三宝饭】含时蔬+海咸鸭蛋+例汤」会把「咸鸭蛋」当候选。
    // 清洗过之后两侧都是菜名主体，短名正是我们要找的（「烧鹅饭」），因此不再按长度砍。
    if (!normalize && menuKey.length < saleKey.length * 0.4) continue;
    const score = similarityFromKeys(saleKey, menuKey);
    if (score >= threshold) scored.push({ menu, score });
  }
  // 同分时名称更短的排前面：收银名多为简称（「烧鹅饭」），短档案名更可能是它的对应菜
  scored.sort((x, y) => (y.score - x.score) || (String(x.menu.name).length - String(y.menu.name).length));
  return scored.slice(0, limit).map(({ menu, score }) => ({
    menu_item_id: menu.id,
    menu_name: menu.name,
    sku_label: menu.sku_label,
    category: menu.category || '',
    cost: Number(menu.cost) || 0,
    score: Math.round(score * 1000) / 1000,
  }));
}

// ==================== 平台名预处理（团购 / 外卖）====================
// 只做“剥离”，不猜测：拿不准的一律留给人工校正。

/** 绑定名称标准化：忽略平台的展示符号、常见营销标签与空格，但保留菜品主体和规格 */
function productBindingNameKey(value) {
  return String(value || '').toLowerCase()
    // 【太公三宝饭】是菜品主名，不能和【招牌】这类营销标签一样整体删除。
    .replace(/[【\[](?:新客专享|外卖专享|限时特惠|热销推荐|招牌|人气|爆款|新品)[】\]]/g, '')
    .replace(/[【】\[\]]/g, '')
    .replace(/(?:新客专享|外卖专享|限时特惠|热销推荐|招牌|人气|爆款|新品)/g, '')
    .replace(/[\s·•_—\-－，,。.!！:：/\\]/g, '')
    .trim();
}

/**
 * 外卖名称经常把赠品、是否配饭写在主菜名后面。这里仅剥离明确不会改变
 * 主菜身份的信息；不能识别或可能对应多规格的名称仍交由人工处理。
 */
function deliveryBindingNameKey(value) {
  let text = String(value || '').trim();
  const noRice = /不含(?:米饭|白饭)/.test(text);
  // “XXX + 例汤/靓汤”中的汤为赠品，不应影响主菜绑定。
  text = text
    .replace(/[+＋]\s*(?:例汤|靓汤)(?=\s*(?:[（(].*[）)])?\s*$)/g, '')
    .replace(/[（(]\s*(?:含)?(?:例汤|靓汤)\s*[）)]/g, '')
    .replace(/不含(?:米饭|白饭)/g, '')
    .trim();
  // 平台的“烧肉/例（不含米饭）”和本地的“烧肉例牌”是同一售卖形态。
  if (noRice) text = text.replace(/(?:[/／\s])?例(?=\s*(?:[（(].*[）)])?\s*$)/, '例牌');
  return productBindingNameKey(text);
}

/**
 * 平台商品名预处理 → 交给共享核心识别的「商品名」。
 * 与 xxxBindingNameKey 的区别：这里保留可读性（大小写、符号已去），
 * 但保留菜名主体，供 resolveDishMenuSmart / suggestDishCandidates 使用。
 */
function platformProductName(scopeGroup, value) {
  const raw = String(value || '').trim();
  return scopeGroup === 'delivery' ? deliveryBindingNameKey(raw) : productBindingNameKey(raw);
}

/** 这三类在本地存在多规格/组合配置，单品自动绑定会绕开规格选择，必须保留人工处理。 */
function isProtectedDeliveryMultiSpecProduct(value) {
  const text = String(value || '');
  return /太公烧鹅|烧鸭|咸鸡|咸香鸡|咸香靓鸡/.test(text);
}

/** 组合套餐、双拼和“濑粉/面”这类仍需选择内容或规格，不能因为名称里包含一个菜名就自动绑定。 */
function isDeliveryCompositeProduct(value) {
  const text = String(value || '')
    .replace(/[+＋]\s*(?:例汤|靓汤)(?=\s*(?:[（(].*[）)])?\s*$)/g, '');
  return /(?:套餐|双拼|三拼|自选|二选一|濑粉\s*[/／]|干捞面|[+＋])/.test(text);
}

const PRODUCT_BINDING_SPECS = ['上庄', '下庄', '半只', '一只', '整只', '大份', '小份', '大盒', '小盒', '单人', '双人'];
function productBindingSpecKey(value) {
  const text = productBindingNameKey(value);
  return PRODUCT_BINDING_SPECS.find(spec => text.includes(spec)) || '';
}
function productBindingDishCoreKey(value) {
  return productBindingNameKey(value)
    .replace(/(?:上庄|下庄|半只|一只|整只|大份|小份|大盒|小盒|单人|双人)/g, '')
    .replace(/(?:金牌|现烤|招牌|太公|至尊|经典|超值|烧味)/g, '')
    .replace(/(?:约)?\d+(?:g|克|斤|两|ml|毫升)/g, '')
    .replace(/(?:不含|含)(?:米饭|白饭|靓汤|饮品|柠檬茶)/g, '')
    .trim();
}
/** 平台常在本地菜品主名之前/之后加三拼、超值、套餐等描述。主名长度至少 4，且在平台名称内唯一时安全。 */
function uniqueContainedMenuId(menus, platformNameKey) {
  const candidates = (menus || []).filter(menu => {
    const menuKey = productBindingNameKey(menu.name);
    return menuKey.length >= 4 && platformNameKey.includes(menuKey);
  });
  const longest = Math.max(0, ...candidates.map(menu => productBindingNameKey(menu.name).length));
  const ids = [...new Set(candidates.filter(menu => productBindingNameKey(menu.name).length === longest).map(menu => Number(menu.id)).filter(Boolean))];
  return ids.length === 1 ? ids[0] : 0;
}
function uniqueDishAndSpecMenuId(menus, productName) {
  const productSpec = productBindingSpecKey(productName);
  const productCore = productBindingDishCoreKey(productName);
  if (!productSpec || productCore.length < 2) return 0;
  const ids = [...new Set((menus || []).filter(menu => productBindingSpecKey(menu.spec || '') === productSpec && productBindingDishCoreKey(menu.name) === productCore)
    .map(menu => Number(menu.id)).filter(Boolean))];
  return ids.length === 1 ? ids[0] : 0;
}
// 对“米饭”这类平台简写，允许从本地“白米饭 / 太公白米饭”中联想；只有唯一时自动绑定。
function shortCoreMenuCandidates(menus, productName) {
  const core = productBindingDishCoreKey(productName);
  if (!['米饭', '白饭'].includes(core)) return [];
  return (menus || []).filter(menu => productBindingDishCoreKey(menu.name).includes('米饭'));
}
function uniqueShortCoreMenuId(menus, productName) {
  const ids = [...new Set(shortCoreMenuCandidates(menus, productName).map(menu => Number(menu.id)).filter(Boolean))];
  return ids.length === 1 ? ids[0] : 0;
}
function productBindingSignature(binding) {
  if (binding.type === 'spec') return `spec:${binding.items.map(item => `${item.menu_item_id}@${Number(item.platform_price)}`).sort().join('|')}`;
  return `single:${binding.menu_item_id}`;
}

/**
 * 统一入口：给一条「平台/收银商品」算推荐结果，三处页面共用。
 * 顺序 = 共享核心（精确优先） → 平台专有兜底 → 相似度候选（只提示）。
 * @returns {{ menu:object|null, reason:string, candidates:Array }}
 */
function recommendMenuItem(index, group, { platform = false } = {}) {
  const name = String(group.product_name || '');
  const platformKey = platform ? platformProductName(group.scope_group, name) : '';
  // 平台链路用清洗过的名称算候选（外卖名常带「含时蔬+海咸鸭蛋」这类尾巴）
  const candidates = () => platform
    ? suggestDishCandidates(index, { ...group, product_name: platformKey || name }, 3, 0.6, candidateName)
    : suggestDishCandidates(index, group);

  // ⓪ 外卖的「多规格保护 / 组合套餐」不给自动推荐（原有策略：单品自动绑定会绕开规格选择），
  //    但仍然给相似度候选 —— 候选只是提示，用户在界面上点一下才会绑，不会误绑。
  if (platform && group.scope_group === 'delivery'
    && (isProtectedDeliveryMultiSpecProduct(name) || isDeliveryCompositeProduct(name))) {
    return { menu: null, reason: '', candidates: candidates(), protected: true };
  }

  // ① 共享核心：手工绑定 / 编码 / 名称+规格 / 名称唯一
  const direct = resolveDishMenuSmart(index, group);
  if (direct.menu) return { menu: direct.menu, reason: direct.reason, candidates: [] };
  const lookupName = platform && group.product_name ? platformProductName(group.scope_group, group.product_name) : group.product_name;
  if (lookupName && lookupName !== group.product_name) {
    const viaPlatform = resolveDishMenuSmart(index, { ...group, product_name: lookupName });
    if (viaPlatform.menu) return { menu: viaPlatform.menu, reason: 'platform', candidates: [] };
  }
  if (!platform) return { menu: null, reason: '', candidates: suggestDishCandidates(index, group) };

  // ② 平台专有兜底（原有能力，只是挪到核心规则之后）
  const menus = index.menus;
  const key = group.scope_group === 'delivery' ? deliveryBindingNameKey(name) : productBindingNameKey(name);
  const specId = uniqueDishAndSpecMenuId(menus, name);
  if (specId) return { menu: index.menuById.get(Number(specId)) || null, reason: 'dish_spec', candidates: [] };
  const containedId = uniqueContainedMenuId(menus, key);
  if (containedId) return { menu: index.menuById.get(Number(containedId)) || null, reason: 'series', candidates: [] };
  const shortId = uniqueShortCoreMenuId(menus, name);
  if (shortId) return { menu: index.menuById.get(Number(shortId)) || null, reason: 'short_core', candidates: [] };
  // ③ 相似度候选（只提示）
  return { menu: null, reason: '', candidates: candidates() };
}

module.exports = {
  RECOMMEND_REASON_LABELS,
  normalizeDishSpec,
  dishMenuKey,
  withDishMenuSku,
  buildDishMenuIndex,
  resolveDishMenuSmart,
  suggestDishCandidates,
  candidateName,
  similarityFromKeys,
  dishNameSimilarity,
  longestCommonSubstring,
  productBindingNameKey,
  deliveryBindingNameKey,
  platformProductName,
  isProtectedDeliveryMultiSpecProduct,
  isDeliveryCompositeProduct,
  PRODUCT_BINDING_SPECS,
  productBindingSpecKey,
  productBindingDishCoreKey,
  uniqueContainedMenuId,
  uniqueDishAndSpecMenuId,
  shortCoreMenuCandidates,
  uniqueShortCoreMenuId,
  productBindingSignature,
  recommendMenuItem,
};
