'use strict';
const PLAN = require('./plan');
function shift(date, amount) {
  if (!PLAN.isPlainDate(date)) throw new Error('review_date_invalid');
  const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + amount);
  return d.toISOString().slice(0, 10);
}
function dateRange(from, to) {
  if (!PLAN.isPlainDate(from) || !PLAN.isPlainDate(to) || from > to) throw new Error('review_range_invalid');
  const days = [];
  for (let d = from; d <= to; d = shift(d, 1)) { days.push(d); if (days.length > 62) throw new Error('review_range_too_large'); }
  return days;
}
function reviewPlan(now = new Date()) {
  const today = PLAN.resolveNow(now).date;
  const yesterday = shift(today, -1);
  // Seven complete days including yesterday; its fresh first export can be reused.
  const days = new Set(dateRange(shift(today, -7), yesterday));
  let previousMonth = null;
  if (today.endsWith('-01')) {
    previousMonth = { from: yesterday.slice(0, 7) + '-01', to: yesterday };
    for (const d of dateRange(previousMonth.from, previousMonth.to)) days.add(d);
  }
  return { today, yesterday, previous_month: previousMonth, dates: [...days].sort() };
}
module.exports = { shift, dateRange, reviewPlan };
