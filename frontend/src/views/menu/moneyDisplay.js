// Presentation only: saved standards and calculation precision are unchanged.
export function moneyNumber(value) {
  if (value == null || value === '' || !Number.isFinite(Number(value))) return null
  return Number(Number(value).toFixed(4))
}
export function moneyText(value, fallback = '—') {
  const n = moneyNumber(value)
  return n == null ? fallback : String(n)
}
export function moneyAmount(value, fallback = '—') {
  const n = moneyNumber(value)
  return n == null ? fallback : '¥' + n
}
