#!/usr/bin/env node
// 每日待办邮件日报(只读扫描 + 复用 one-person-company/mailer.py 发送)。
// 默认没有超期条目时不发,避免每天收空邮件;--always 可强制发。
//
// 用法:
//   node scripts/overdue-mail.mjs --dry-run
//   node scripts/overdue-mail.mjs --file /var/lib/.../todos.json
//   node scripts/overdue-mail.mjs --to me@example.com --always
//
// 环境变量:
//   OPENTODO_FILE     默认 todos.json 路径
//   OPENTODO_MAILER   默认 /home/ubuntu/Projects/one-person-company/mailer.py
//   OPENTODO_PYTHON   默认 python3

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { OVERDUE_DAYS, scanOverdue } from '../overdue.js'
import { buildSubject, readTodoData, renderEmailMarkdown } from '../overdue-report.js'

const DEFAULT_MAILER = '/home/ubuntu/Projects/one-person-company/mailer.py'

function parseArgs(argv) {
  const args = {
    file: '',
    now: '',
    days: OVERDUE_DAYS,
    to: '',
    mailer: process.env.OPENTODO_MAILER || DEFAULT_MAILER,
    python: process.env.OPENTODO_PYTHON || 'python3',
    subject: '',
    dryRun: false,
    always: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--file') args.file = argv[++i] ?? ''
    else if (a === '--now') args.now = argv[++i] ?? ''
    else if (a === '--days') args.days = Number(argv[++i] ?? OVERDUE_DAYS)
    else if (a === '--to') args.to = argv[++i] ?? ''
    else if (a === '--mailer') args.mailer = argv[++i] ?? DEFAULT_MAILER
    else if (a === '--python') args.python = argv[++i] ?? 'python3'
    else if (a === '--subject') args.subject = argv[++i] ?? ''
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--always') args.always = true
    else if (a === '--help' || a === '-h') {
      console.log(
        '用法: node scripts/overdue-mail.mjs [--file <todos.json>] [--now <ISO>] [--days 30] [--to <mail>] [--mailer <mailer.py>] [--subject <s>] [--dry-run] [--always]',
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

/** 通过 mailer.py 的 send(subject, body_md, to=...) 发送;返回 { ok, message }。 */
function sendViaMailer({ python, mailer, subject, body, to }) {
  const py = [
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(path.dirname(mailer))})`,
    'import mailer',
    'body = sys.stdin.read()',
    `ok, msg = mailer.send(${JSON.stringify(subject)}, body, to=${to ? JSON.stringify(to) : 'None'})`,
    'print(("OK " if ok else "FAIL ") + str(msg))',
    'sys.exit(0 if ok else 1)',
  ].join('\n')

  const r = spawnSync(python, ['-c', py], {
    input: body,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  })
  if (r.error) return { ok: false, message: r.error.message }
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
  return { ok: r.status === 0, message: out || `python 退出码 ${r.status}` }
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
const subject = args.subject || buildSubject(scan)
const body = renderEmailMarkdown({ data, scan })

if (!scan.count && !args.always) {
  console.error(`没有超 ${scan.days} 天的待办,跳过发送(加 --always 可强制发)。`)
  process.exit(0)
}

if (args.dryRun) {
  console.log(`To: ${args.to || 'mailer 默认收件人'}`)
  console.log(`Subject: ${subject}`)
  console.log('')
  process.stdout.write(body)
  process.exit(0)
}

if (!fs.existsSync(args.mailer)) {
  console.error(`找不到 mailer: ${args.mailer}(可用 OPENTODO_MAILER 覆盖)`)
  process.exit(1)
}

const result = sendViaMailer({
  python: args.python,
  mailer: args.mailer,
  subject,
  body,
  to: args.to || undefined,
})
if (!result.ok) {
  console.error(`发送失败: ${result.message}`)
  process.exit(1)
}
console.error(`已发送: ${subject}${args.to ? ` → ${args.to}` : ''}（${result.message}）`)
