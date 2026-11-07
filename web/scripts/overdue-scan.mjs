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

function readData(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  // 兼容 GET /api/state 的 { data, owner } 包装
  return raw && raw.data && Array.isArray(raw.data.items) ? raw.data : raw
}

function pad(value) {
  return String(value).padStart(2, '0')
}

function stamp(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function renderMarkdown({ file, data, scan }) {
  const lines = [
    `# Opentodo 到期扫描 · ${stamp(scan.now)}`,
    '',
    `- 数据文件: \`${file}\``,
    `- revision: ${data.revision ?? '—'}`,
    `- pending: ${scan.totalPending}`,
    `- 超 ${scan.days} 天: ${scan.count}`,
    '',
    '## 账龄分布',
    '',
    '| 账龄 | 条数 |',
    '| --- | ---: |',
    ...scan.buckets.map((b) => `| ${b.label} | ${b.count} |`),
    `| **合计** | **${scan.buckets.reduce((n, b) => n + b.count, 0)}** |`,
    '',
    `## 超 ${scan.days} 天清单(按天数降序)`,
    '',
  ]
  if (!scan.overdue.length) {
    lines.push('无。')
  } else {
    lines.push('| # | 天数 | 项目 | 分组 | 内容 | ID |', '| ---: | ---: | --- | --- | --- | --- |')
    scan.overdue.forEach(({ item, ageDays }, i) => {
      const content = String(item.content ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
      lines.push(
        `| ${i + 1} | ${ageDays} | ${item.list ?? '收件箱'} | ${item.project ?? '—'} | ${content} | \`${item.id}\` |`,
      )
    })
  }
  lines.push('', '> 只读扫描,未修改任何待办。', '')
  return lines.join('\n')
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
  data = readData(file)
} catch (err) {
  console.error(`读取失败 ${file}: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

const scan = scanOverdue(data.items ?? [], { now, days: args.days })

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
        overdue: scan.overdue.map(({ item, ageDays }) => ({
          id: item.id,
          content: item.content,
          list: item.list,
          project: item.project ?? null,
          createdAt: item.createdAt ?? null,
          updatedAt: item.updatedAt ?? null,
          ageDays,
        })),
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
