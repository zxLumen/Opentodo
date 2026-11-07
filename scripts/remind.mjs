#!/usr/bin/env node
// Opentodo 每日提醒:只读线上 todos.json,把 pending 且账龄 ≥N 天(默认 7)
// 或当天到期的条目汇总成一条 Bark 推送(group=opentodo)。
// 同一 id 每天只推一次;状态写在 ~/.local/state/opentodo-remind/last.json。
// 不修改 todos.json,不引入任何第三方依赖。
//
// 用法:
//   node scripts/remind.mjs --dry-run
//   node scripts/remind.mjs
//   node scripts/remind.mjs --days 30 --dry-run
//
// 可选环境变量:BARK_KEY(逗号分隔,跳过 bark.db 提取)、BARK_BASE、OPENTODO_CONTAINER。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_DAYS = 7
const CONTAINER = process.env.OPENTODO_CONTAINER || 'docker-opentodo-1'
const BARK_CONTAINER = process.env.BARK_CONTAINER || 'bark-server'
const BARK_DB = process.env.BARK_DB || '/data/bark.db'
const BARK_BASE = (process.env.BARK_BASE || 'https://bark.zxlumen.cn').replace(/\/$/, '')
const STATE_DIR = path.join(os.homedir(), '.local', 'state', 'opentodo-remind')
const STATE_FILE = path.join(STATE_DIR, 'last.json')

function usage() {
  console.log(`用法: node scripts/remind.mjs [--dry-run] [--days 7] [--now <ISO>] [--file <todos.json>]

  --dry-run   只输出待提醒清单,不推送、不写状态
  --days N    账龄阈值,默认 ${DEFAULT_DAYS} 天
  --now ISO   用指定时间计算账龄(调试用)
  --file PATH 读本地 JSON 而不是 docker 容器(调试用)`)
}

function parseArgs(argv) {
  const args = { dryRun: false, days: DEFAULT_DAYS, now: null, file: null }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--dry-run') args.dryRun = true
    else if (a === '--days') args.days = Number(argv[++i])
    else if (a === '--now') args.now = argv[++i]
    else if (a === '--file') args.file = argv[++i]
    else if (a === '--help' || a === '-h') {
      usage()
      process.exit(0)
    } else {
      console.error(`未知参数: ${a}`)
      usage()
      process.exit(2)
    }
  }
  if (!Number.isFinite(args.days) || args.days < 0) {
    console.error('--days 需要一个非负数字')
    process.exit(2)
  }
  return args
}

function readData(file) {
  let raw
  if (file) {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } else {
    raw = execFileSync('docker', ['exec', CONTAINER, 'cat', '/data/todos.json'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
  }
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw
  // 兼容 GET /api/state 的 { data, owner } 包装
  return data && data.data && Array.isArray(data.data.items) ? data.data : data
}

function toDate(value) {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

// 按本地日历日计算账龄:「Sep 23 → Nov 7」算 45 天,和人对天数的直觉一致。
function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function ageDays(item, now) {
  const created = toDate(item.createdAt) ?? toDate(item.updatedAt)
  if (!created) return null
  return Math.round((startOfDay(now) - startOfDay(created)) / DAY_MS)
}

function dueToday(item, now) {
  const raw = item.dueAt ?? item.dueDate ?? item.due ?? item.deadline
  const due = toDate(raw)
  return due != null && startOfDay(due) === startOfDay(now)
}

function localDate(now) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

function pickCandidates(data, now, days) {
  const items = Array.isArray(data?.items) ? data.items : []
  return items
    .filter((item) => item && item.status === 'pending' && item.archivedAt == null)
    .map((item) => ({ item, age: ageDays(item, now) }))
    .filter(({ item, age }) => (age != null && age >= days) || dueToday(item, now))
    .sort((a, b) => (b.age ?? -1) - (a.age ?? -1) || String(a.item.id).localeCompare(String(b.item.id)))
}

function formatLine({ item, age }) {
  const project = item.list || item.project || '收件箱'
  const content = String(item.content ?? '').replace(/\s+/g, ' ').trim()
  return `${age == null ? '—' : age} ${project} ${content}`
}

function readSentIds(now) {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    if (state && state.date === localDate(now) && Array.isArray(state.ids)) return new Set(state.ids)
  } catch {
    // 首次运行或状态文件损坏:当作今天还没推过。
  }
  return new Set()
}

function writeSentIds(now, ids) {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  const tmp = `${STATE_FILE}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify({ date: localDate(now), ids: [...ids] }, null, 2)}\n`)
  fs.renameSync(tmp, STATE_FILE)
}

function extractBarkKeys() {
  if (process.env.BARK_KEY) {
    return [...new Set(process.env.BARK_KEY.split(',').map((k) => k.trim()).filter(Boolean))]
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentodo-bark-'))
  const db = path.join(dir, 'bark.db')
  try {
    execFileSync('docker', ['cp', `${BARK_CONTAINER}:${BARK_DB}`, db], { stdio: 'pipe' })
    const text = execFileSync('strings', ['-n', '12', db], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
    // bbolt 的 device bucket 里是「22 位 key + 64 位 sha256」连续存放。
    const keys = new Set()
    const re = /([A-Za-z0-9]{22})([0-9a-f]{64})(?=([A-Za-z0-9]{22})|$)/g
    for (const run of text.split(/\r?\n/)) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(run))) {
        keys.add(m[1])
        re.lastIndex = m.index + m[1].length + m[2].length
      }
    }
    return [...keys]
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

async function pushBark(keys, title, body) {
  const results = []
  for (const key of keys) {
    // 本机 bark-server 的设备推送路由是 POST /:device_key;
    // 部分文档写成 /push/:device_key,在这里会 400(failed to get device token)。
    const url = `${BARK_BASE}/${encodeURIComponent(key)}`
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body, group: 'opentodo' }),
      })
      let payload = null
      try {
        payload = await res.json()
      } catch {
        // 非 JSON 响应也照常记录 HTTP 状态。
      }
      results.push({ key, status: res.status, code: payload?.code ?? null, message: payload?.message ?? '' })
    } catch (error) {
      results.push({ key, status: 0, code: null, message: error.message })
    }
  }
  return results
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const now = args.now ? toDate(args.now) : new Date()
  if (!now) {
    console.error(`--now 不是合法时间: ${args.now}`)
    process.exit(2)
  }

  const data = readData(args.file)
  const candidates = pickCandidates(data, now, args.days)

  // --dry-run 只预览筛选结果,不受当天去重影响,方便随时核对清单。
  if (args.dryRun) {
    if (!candidates.length) {
      console.log('0 条')
      return
    }
    for (const entry of candidates) console.log(formatLine(entry))
    return
  }

  const sent = readSentIds(now)
  const fresh = candidates.filter(({ item }) => !sent.has(item.id))
  if (!fresh.length) {
    console.log(`今日待提醒: 0 条（已去重）`)
    return
  }

  const lines = fresh.map(formatLine)
  const title = `Opentodo 提醒 · ${fresh.length} 条`
  const body = lines.join('\n')
  const keys = extractBarkKeys()
  if (!keys.length) {
    console.error('没有从 bark.db 提取到 device key;可用 BARK_KEY 环境变量指定。')
    process.exit(1)
  }

  const results = await pushBark(keys, title, body)
  let ok = false
  for (const r of results) {
    const code = r.code ?? r.status
    console.log(`推送 ${fresh.length} 条 → ${r.key.slice(0, 6)}…: code=${code}${r.message ? ` ${r.message}` : ''}`)
    if (r.code === 200 || r.status === 200) ok = true
  }

  if (!ok) {
    console.error('全部推送失败,未写入去重状态,下次会重试。')
    process.exit(1)
  }

  writeSentIds(now, [...sent, ...fresh.map(({ item }) => item.id)])
  console.log(`已记录 ${fresh.length} 条到今天(${localDate(now)})的去重状态。`)
}

main().catch((error) => {
  console.error(`remind 失败: ${error.message}`)
  process.exit(1)
})
