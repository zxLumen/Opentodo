#!/usr/bin/env node
// 每日到期扫描(只读):读 todos.json,输出 pending 账龄分布 + 超 30 天提醒清单。
// 不写 todos.json;只有显式 --out 时才写输出文件。
//
// 用法:
//   node scripts/overdue-scan.mjs
//   node scripts/overdue-scan.mjs --file /path/to/todos.json
//   node scripts/overdue-scan.mjs --now 2026-11-07T00:00:00Z --json
//   node scripts/overdue-scan.mjs --out ../docs/OVERDUE-2026-11-07.md
//
// 默认按 createdAt 计算账龄;条目缺 createdAt 时回退 updatedAt。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OVERDUE_DAYS, scanOverdue } from '../overdue.js'
import { readTodoData, renderMarkdown } from '../overdue-report.js'

function parseArgs(argv) {
  const args = { file: '', now: '', out: '', json: false, days: OVERDUE_DAYS }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--file') args.file = argv[++i] ?? ''
    else if (a === '--now') args.now = argv[++i] ?? ''
    else if (a === '--out') args.out = argv[++i] ?? ''
    else if (a === '--days') args.days = Number(argv[++i] ?? OVERDUE_DAYS)
    else if (a === '--json') args.json = true
    else if (a === '--help' || a === '-h') {
      console.log(
        '用法: node scripts/overdue-scan.mjs [--file <todos.json>] [--now <ISO>] [--days 30] [--json] [--out <md>]',
      )
      process.exit(0)
    } else {
      console.error(`未知参数: ${a}`)
      process.exit(2)
    }
  }
  return args
}

function defaultFile() {
  return process.env.OPENTODO_FILE || path.join(os.homedir(), '.config', 'opentodo', 'todos.json')
}

const args = parseArgs(process.argv.slice(2))
const file = args.file || defaultFile()
const now = args.now ? new Date(args.now) : new Date()
if (Number.isNaN(now.getTime())) {
  console.error(`--now 不是合法时间: ${args.now}`)
  process.exit(2)
}
if (!Number.isFinite(args.days) || args.days < 0) {
  console.error(`--days 必须是非负数字: ${args.days}`)
  process.exit(2)
}

let data
try {
  data = readTodoData(file)
} catch (err) {
  console.error(`读取失败 ${file}: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

const scan = scanOverdue(data.items ?? [], { now, days: args.days })

const entry = ({ item, dueAt, dueInDays, ageDays }) => ({
  id: item.id,
  content: item.content,
  list: item.list,
  project: item.project ?? null,
  createdAt: item.createdAt ?? null,
  updatedAt: item.updatedAt ?? null,
  dueAt: dueAt ?? null,
  ...(dueInDays != null ? { dueInDays } : {}),
  ...(ageDays != null ? { ageDays } : {}),
})

const output = args.json
  ? JSON.stringify(
      {
        file,
        revision: data.revision ?? null,
        now: now.toISOString(),
        days: scan.days,
        totalPending: scan.totalPending,
        buckets: scan.buckets,
        count: scan.count,
        overdue: scan.overdue.map(entry),
        due: {
          soon: scan.due.soon.map(entry),
          today: scan.due.today.map(entry),
          overdue: scan.due.overdue.map(entry),
          counts: scan.due.counts,
          total: scan.due.total,
        },
      },
      null,
      2,
    )
  : renderMarkdown({ file, data, scan })

if (args.out) {
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true })
  fs.writeFileSync(args.out, output)
  console.error(`已写入 ${args.out}`)
} else {
  process.stdout.write(output)
}
