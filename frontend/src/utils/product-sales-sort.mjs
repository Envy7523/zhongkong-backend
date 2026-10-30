// Sort the complete result before pagination. Missing income stays after real zero/negative values.
export function sortProductSales(products, sort = 'amount', groupBuy = false) {
  const field = sort === 'quantity' ? 'quantity' : sort === 'income'
    ? (groupBuy ? 'merchant_income' : 'actual_income') : 'sales_amount'
  const value = row => row[field] === null || row[field] === undefined || row[field] === ''
    || !Number.isFinite(Number(row[field])) ? null : Number(row[field])
  return [...products].sort((a, b) => {
    const av = value(a), bv = value(b)
    if (av === null) return bv === null ? 0 : 1
    if (bv === null) return -1
    return bv - av
  })
}
