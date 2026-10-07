export function money(value) {
  const n = Number(value || 0)
  const [whole, fraction] = Math.abs(n).toFixed(2).split('.')
  return (n < 0 ? '-' : '') + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + fraction
}
export function localDate(value = new Date()) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}
export function periodRange(kind, day) {
  const date = new Date(day + 'T00:00:00')
  if (kind === 'week') date.setDate(date.getDate() - (date.getDay() + 6) % 7)
  if (kind === 'month') date.setDate(1)
  return { from: localDate(date), to: day }
}
