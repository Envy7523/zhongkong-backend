export function monthlyBoardNotices(warnings = [], estimated = false) {
  const platforms = new Map(), notes = new Set()
  for (const warning of warnings) {
    const text = String(warning || '').trim()
    const match = text.match(/^(.+?)(?:已于|已登记账号).*?缺少真实数据[：:]\s*([^；;]+)/)
    const dates = match?.[2].match(/\d{4}-\d{2}-\d{2}/g)
    if (match && dates?.length) {
      if (!platforms.has(match[1])) platforms.set(match[1], new Set())
      dates.forEach(date => platforms.get(match[1]).add(date))
    } else if (text) notes.add(text)
  }
  if (estimated) notes.add('扫码手续费按现有数据测算；会员本金手续费按0.38%测算，赠金不收费。')
  return {missing:[...platforms].map(([platform, dates])=>({platform,dates:[...dates].sort()})),notes:[...notes]}
}
