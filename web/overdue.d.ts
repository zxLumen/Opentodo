import type { TodoItem } from './src/types'

export const OVERDUE_DAYS: number
export const DUE_SOON_DAYS: number

/** 兼容旧数据的到期日字段。 */
export type DueItem = TodoItem & {
  dueAt?: string | null
  dueDate?: string | null
  due?: string | null
  deadline?: string | null
}

export interface AgedItem {
  item: DueItem
  ageDays: number
  dueAt: string | null
}

export interface DueListItem {
  item: DueItem
  dueAt: string
  dueInDays: number
}

export type DueTier = 'due-soon' | 'due-today' | 'due-overdue'

export interface AgeBucket {
  key: string
  label: string
  min: number
  max: number
  count: number
}

export interface DueScan {
  soon: DueListItem[]
  today: DueListItem[]
  overdue: DueListItem[]
  expired: DueListItem[]
  counts: { soon: number; today: number; overdue: number; expired: number }
  total: number
}

export interface OverdueScan {
  now: Date
  days: number
  totalPending: number
  buckets: AgeBucket[]
  overdue: AgedItem[]
  count: number
  expired: DueListItem[]
  expiredCount: number
  due: DueScan
}

export function toDate(value: string | null | undefined): Date | null
export function ageDays(item: Pick<TodoItem, 'createdAt' | 'updatedAt'>, now?: Date): number | null
export function isOverduePending(item: TodoItem, now?: Date, days?: number): boolean
export function resolveDueAt(item: DueItem): Date | null
export function dueInDays(item: DueItem, now?: Date): number | null
export function dueDateKey(d: Date): string
export const DUE_TIERS: Array<{ key: DueTier; label: string }>
export function dueTier(item: DueItem, now?: Date): DueTier | null
export function isExpiredDue(item: DueItem, now?: Date): boolean
export const AGE_BUCKETS: Omit<AgeBucket, 'count'>[]
export function bucketOf(days: number | null): Omit<AgeBucket, 'count'> | null
export function scanOverdue(
  items: TodoItem[],
  options?: { now?: Date; days?: number },
): OverdueScan
