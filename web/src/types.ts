// 与 shared/schema.md / Models.swift 一一对应的数据契约(schema v2)。
// 这份类型必须和桌面 App、插件、MCP 保持一致 —— 它们读写的是同一份 todos.json。

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'
export type Priority = 'high' | 'medium' | 'low'

export interface TodoItem {
  id: string
  content: string
  status: TodoStatus
  priority: Priority
  /** 项目内的分类/分组名,可为 null(展示为「未分组」) */
  project: string | null
  /** 所属项目(独立 todolist),不允许为 null;旧数据 null 归入收件箱 */
  list: string | null
  /** 非空即归档 */
  archivedAt: string | null
  /** 组内排序,越小越靠前 */
  order: number
  createdAt?: string | null
  updatedAt?: string | null
  completedAt?: string | null
}

export interface TodoFile {
  version: number
  revision: number
  updatedAt?: string | null
  items: TodoItem[]
  lists: string[]
}

/** 默认项目名 */
export const INBOX = '收件箱'
/** 未分组条目的展示名 */
export const UNGROUPED = '未分组'
/** 待办段里被取消条目的灰分组名 */
export const CANCELLED_GROUP = '已取消'

export const statusLabel: Record<TodoStatus, string> = {
  pending: '待办',
  in_progress: '进行中',
  completed: '已完成',
  cancelled: '已取消',
}
