function documentValidity(body = {}, previous = {}) {
  const rawLong = body.id_card_long_term ?? previous.id_card_long_term ?? 0;
  if (![true, false, 0, 1, '0', '1'].includes(rawLong)) throw new Error('身份证长期有效设置无效');
  const longTerm = [true, 1, '1'].includes(rawLong);
  const expiry = longTerm ? '' : String(body.id_card_expiry ?? previous.id_card_expiry ?? '').trim();
  if (expiry && (!/^\d{4}-\d{2}-\d{2}$/.test(expiry) || Number.isNaN(Date.parse(expiry+'T00:00:00Z')) || new Date(expiry+'T00:00:00Z').toISOString().slice(0,10)!==expiry)) throw new Error('请填写有效的身份证到期日期');
  return { id_card_expiry: expiry, id_card_long_term: longTerm ? 1 : 0 };
}
module.exports = { documentValidity };
