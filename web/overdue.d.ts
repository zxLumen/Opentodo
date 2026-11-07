import type { TodoItem } from './src/types'

export const OVERDUE_DAYS: number

export interface AgedItem {
  item: TodoItem
  ageDays: number
}

export interface AgeBucket {
  key: string
  label: string
  min: number
  max: number
  count: number
}

export interface OverdueScan {
  now: Date
  days: number
  totalPending: number
  buckets: AgeBucket[]
  overdue: AgedItem[]
  count: number
}

export function toDate(value: string | null | undefined): Date | null
export function ageDays(item: Pick<TodoItem, 'createdAt' | 'updatedAt'>, now?: Date): number | null
export function isOverduePending(item: TodoItem, now?: Date, days?: number): boolean
export const AGE_BUCKETS: Omit<AgeBucket, 'count'>[]
export function bucketOf(days: number | null): Omit<AgeBucket, 'count'> | null
export function scanOverdue(
  items: TodoItem[],
  options?: { now?: Date; days?: number },
): OverdueScan
