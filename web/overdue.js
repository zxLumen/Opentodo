// 待办「账龄」扫描:纯函数,Web UI 与每日扫描脚本共用。
// 账龄以 createdAt 为准(条目进入系统的天数);旧数据缺 createdAt 时回退 updatedAt。
// 另按 dueAt 做三档到期判定:未来 7 天内到期 / 今天到期 / 已逾期。
// 旧数据没有 dueAt 字段时,回退解析 content 里的「下一步：YYYY-MM-DD」。
// 只读:本模块不修改任何条目。

export const OVERDUE_DAYS = 30
export const DUE_SOON_DAYS = 7
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

/** 纯日期字符串按本地日历日解析,避免 YYYY-MM-DD 被当成 UTC 零点后偏移一天。 */
function toDueDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'number' && Number.isFinite(value)) {
    const t = new Date(value)
    return Number.isNaN(t.getTime()) ? null : t
  }
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (dateOnly) {
    const year = Number(dateOnly[1])
    const month = Number(dateOnly[2])
    const day = Number(dateOnly[3])
    const t = new Date(year, month - 1, day)
    if (t.getFullYear() !== year || t.getMonth() !== month - 1 || t.getDate() !== day) return null
    return t
  }

  const t = new Date(text)
  return Number.isNaN(t.getTime()) ? null : t
}

function dueFromContent(content) {
  if (typeof content !== 'string') return null
  const m = /下一步\s*[：:]\s*(\d{4}-\d{2}-\d{2})/.exec(content)
  return m ? toDueDate(m[1]) : null
}

/**
 * 条目到期日:优先 dueAt,兼容 dueDate/due/deadline;
 * 都没有时解析 content 的「下一步：YYYY-MM-DD」。无法解析返回 null。
 */
export function resolveDueAt(item) {
  if (!item) return null
  for (const key of ['dueAt', 'dueDate', 'due', 'deadline']) {
    const due = toDueDate(item[key])
    if (due) return due
  }
  return dueFromContent(item.content)
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** 本地日历日的距今天数:未来为正、今天 0、逾期为负。无法解析返回 null。 */
export function dueInDays(item, now = new Date()) {
  const due = resolveDueAt(item)
  if (!due || Number.isNaN(now.getTime())) return null
  return Math.round((startOfDay(due) - startOfDay(now)) / DAY_MS)
}

/** 本地日期 YYYY-MM-DD(账龄与 dueAt 都按本地日历日)。 */
export function dueDateKey(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 到期三档:未来 7 天内 / 今天 / 已逾期;7 天以外与无到期日返回 null。 */
export const DUE_TIERS = [
  { key: 'due-soon', label: `未来 ${DUE_SOON_DAYS} 天内到期` },
  { key: 'due-today', label: '今天到期' },
  { key: 'due-overdue', label: '已逾期' },
]

export function dueTier(item, now = new Date()) {
  const days = dueInDays(item, now)
  if (days == null) return null
  if (days < 0) return 'due-overdue'
  if (days === 0) return 'due-today'
  if (days <= DUE_SOON_DAYS) return 'due-soon'
  return null
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
 *   overdue: Array<{item:any,ageDays:number,dueAt:string|null}>,
 *   count: number,
 *   due: {
 *     soon: Array<{item:any,dueAt:string,dueInDays:number}>,
 *     today: Array<{item:any,dueAt:string,dueInDays:number}>,
 *     overdue: Array<{item:any,dueAt:string,dueInDays:number}>,
 *     counts: {soon:number,today:number,overdue:number},
 *     total: number,
 *   },
 * }}
 */
export function scanOverdue(items, { now = new Date(), days = OVERDUE_DAYS } = {}) {
  const list = Array.isArray(items) ? items : []
  const pending = list.filter((it) => it && it.status === 'pending' && it.archivedAt == null)
  const enriched = pending.map((item) => {
    const due = resolveDueAt(item)
    return {
      item,
      ageDays: ageDays(item, now),
      dueAt: due ? dueDateKey(due) : null,
      dueInDays: due ? dueInDays(item, now) : null,
    }
  })
  const aged = enriched.filter((x) => x.ageDays != null)

  const buckets = AGE_BUCKETS.map((b) => ({
    ...b,
    count: aged.filter((x) => x.ageDays >= b.min && x.ageDays <= b.max).length,
  }))

  const overdue = aged
    .filter((x) => x.ageDays > days)
    .sort((a, b) => b.ageDays - a.ageDays || String(a.item.id).localeCompare(String(b.item.id)))
    .map(({ item, ageDays, dueAt }) => ({ item, ageDays, dueAt }))

  const dueList = enriched.filter((x) => x.dueInDays != null)
  const byDue = (a, b) =>
    a.dueInDays - b.dueInDays || String(a.item.id).localeCompare(String(b.item.id))
  const dueEntry = ({ item, dueAt, dueInDays }) => ({ item, dueAt, dueInDays })
  const soon = dueList
    .filter((x) => x.dueInDays >= 1 && x.dueInDays <= DUE_SOON_DAYS)
    .sort(byDue)
    .map(dueEntry)
  const today = dueList.filter((x) => x.dueInDays === 0).sort(byDue).map(dueEntry)
  const dueOverdue = dueList.filter((x) => x.dueInDays < 0).sort(byDue).map(dueEntry)

  return {
    now,
    days,
    totalPending: pending.length,
    buckets,
    overdue,
    count: overdue.length,
    due: {
      soon,
      today,
      overdue: dueOverdue,
      counts: { soon: soon.length, today: today.length, overdue: dueOverdue.length },
      total: soon.length + today.length + dueOverdue.length,
    },
  }
}
