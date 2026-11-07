// 待办「账龄」扫描:纯函数,Web UI 与每日扫描脚本共用。
// 账龄以 createdAt 为准(条目进入系统的天数);旧数据缺 createdAt 时回退 updatedAt。
// 只读:本模块不修改任何条目。

export const OVERDUE_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

/** 解析 ISO 时间;非法/空值返回 null。 */
export function toDate(value) {
  if (!value) return null
  const t = new Date(value)
  return Number.isNaN(t.getTime()) ? null : t
}

/** 条目账龄(整天,向下取整);无法解析时间返回 null。 */
export function ageDays(item, now = new Date()) {
  const created = toDate(item?.createdAt) ?? toDate(item?.updatedAt)
  if (!created) return null
  return Math.floor((now.getTime() - created.getTime()) / DAY_MS)
}

/** 是否为「pending 且超过 days 天」的到期条目。归档/非 pending 一律不算。 */
export function isOverduePending(item, now = new Date(), days = OVERDUE_DAYS) {
  if (!item || item.status !== 'pending' || item.archivedAt != null) return false
  const age = ageDays(item, now)
  return age != null && age > days
}

/** 账龄分布桶:0–7 / 8–30 / 31–40 / >40。 */
export const AGE_BUCKETS = [
  { key: '0-7', label: '0–7 天', min: 0, max: 7 },
  { key: '8-30', label: '8–30 天', min: 8, max: 30 },
  { key: '31-40', label: '31–40 天', min: 31, max: 40 },
  { key: '41+', label: '>40 天', min: 41, max: Number.POSITIVE_INFINITY },
]

export function bucketOf(days) {
  if (days == null) return null
  return AGE_BUCKETS.find((b) => days >= b.min && days <= b.max) ?? null
}

/**
 * 扫描整份待办。
 * @returns {{
 *   now: Date,
 *   days: number,
 *   totalPending: number,
 *   buckets: Array<{key:string,label:string,min:number,max:number,count:number}>,
 *   overdue: Array<{item:any,ageDays:number}>,
 *   count: number,
 * }}
 */
export function scanOverdue(items, { now = new Date(), days = OVERDUE_DAYS } = {}) {
  const list = Array.isArray(items) ? items : []
  const pending = list.filter((it) => it && it.status === 'pending' && it.archivedAt == null)
  const aged = pending
    .map((item) => ({ item, ageDays: ageDays(item, now) }))
    .filter((x) => x.ageDays != null)

  const buckets = AGE_BUCKETS.map((b) => ({
    ...b,
    count: aged.filter((x) => x.ageDays >= b.min && x.ageDays <= b.max).length,
  }))

  const overdue = aged
    .filter((x) => x.ageDays > days)
    .sort((a, b) => b.ageDays - a.ageDays || String(a.item.id).localeCompare(String(b.item.id)))

  return {
    now,
    days,
    totalPending: pending.length,
    buckets,
    overdue,
    count: overdue.length,
  }
}
