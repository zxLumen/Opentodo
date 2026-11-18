// /api/sync 合并保护:同设备 + 同 body sha256 在窗口内直接回上次响应。
// 用临时数据文件 + 真实 server 进程验证,不碰生产 todos.json。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB = path.resolve(HERE, '..')
const COOKIE = { cookie: 'zx_todo_owner=test-owner' }
const DEDUPE_MS = 800

function item(id, content, updatedAt) {
  return {
    id,
    content,
    status: 'pending',
    priority: 'medium',
    project: null,
    list: '收件箱',
    archivedAt: null,
    order: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt,
    completedAt: null,
  }
}

function fixture() {
  return {
    version: 3,
    revision: 50,
    updatedAt: '2026-01-01T00:00:00.000Z',
    items: [item('a1', '原内容', '2026-01-01T00:00:00.000Z')],
    lists: ['收件箱'],
    tombstones: [],
    listTombstones: [],
    listRenames: [],
    listsUpdatedAt: '2026-01-01T00:00:00.000Z',
  }
}

async function freePort() {
  const net = await import('node:net')
  return await new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port
      s.close(() => resolve(port))
    })
  })
}

async function waitHealth(base) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${base}/api/health`)
      if (r.ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('server 未启动')
}

async function withServer(file, fn, env = {}) {
  const port = await freePort()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentodo-sync-'))
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: WEB,
    env: {
      ...process.env,
      PORT: String(port),
      OPENTODO_FILE: file,
      OPENTODO_DATA_DIR: dataDir,
      OPENTODO_OWNER_TOKEN: 'test-owner',
      OPENTODO_SYNC_DEDUPE_MS: String(DEDUPE_MS),
      OPENTODO_SYNC_RPS_WARN: '2',
      OPENTODO_SYNC_RPS_WINDOW_MS: '1000',
      ...env,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  proc.stderr.on('data', (b) => {
    stderr += b.toString('utf8')
  })
  const base = `http://127.0.0.1:${port}`
  try {
    await waitHealth(base)
    return await fn(base, () => stderr)
  } finally {
    proc.kill('SIGTERM')
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

function sync(base, state, deviceId = 'dev-a') {
  return fetch(`${base}/api/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...COOKIE },
    body: JSON.stringify({ deviceId, state }),
  })
}

function fileHash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

test('/api/sync:同设备同 body 窗口内去重,不写盘', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentodo-sync-file-'))
  const file = path.join(dir, 'todos.json')
  fs.writeFileSync(file, JSON.stringify(fixture(), null, 2))
  const hash0 = fileHash(file)

  await withServer(file, async (base) => {
    const state = fixture()

    const first = await sync(base, state)
    assert.equal(first.status, 200)
    assert.equal(first.headers.get('x-opentodo-dedup'), '0')
    const firstBody = await first.json()
    assert.equal(firstBody.revision, 50)
    assert.equal(firstBody.changed, false)

    const second = await sync(base, state)
    assert.equal(second.status, 200)
    assert.equal(second.headers.get('x-opentodo-dedup'), '1')
    const secondBody = await second.json()
    assert.equal(secondBody.revision, 50)
    assert.equal(secondBody.changed, false)
    assert.deepEqual(secondBody.data.items, firstBody.data.items)

    // 命中路径不读不写:文件字节完全不变
    assert.equal(fileHash(file), hash0)

    const health = await (await fetch(`${base}/api/health`)).json()
    assert.equal(health.sync_total, 2)
    assert.equal(health.sync_dedup, 1)
    assert.equal(health.sync_writes, 0)
  })
})

test('/api/sync:不同内容仍合并,revision +1 且内容正确', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentodo-sync-file-'))
  const file = path.join(dir, 'todos.json')
  fs.writeFileSync(file, JSON.stringify(fixture(), null, 2))

  await withServer(file, async (base) => {
    // 先用旧内容建立缓存
    assert.equal((await sync(base, fixture())).status, 200)

    const changedState = fixture()
    changedState.items = [item('a1', '新内容', '2026-01-02T00:00:00.000Z')]
    const res = await sync(base, changedState)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('x-opentodo-dedup'), '0')
    const body = await res.json()
    assert.equal(body.changed, true)
    assert.equal(body.revision, 51)
    assert.equal(body.data.items.find((it) => it.id === 'a1').content, '新内容')

    // 已落盘,读回来也是新内容
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(onDisk.revision, 51)
    assert.equal(onDisk.items.find((it) => it.id === 'a1').content, '新内容')

    // 同样的新内容再来一次 → 去重且 changed=false
    const again = await sync(base, changedState)
    assert.equal(again.status, 200)
    assert.equal(again.headers.get('x-opentodo-dedup'), '1')
    const againBody = await again.json()
    assert.equal(againBody.changed, false)
    assert.equal(againBody.revision, 51)
  })
})

test('/api/sync:超出窗口后重新合并,但仍不写盘', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentodo-sync-file-'))
  const file = path.join(dir, 'todos.json')
  fs.writeFileSync(file, JSON.stringify(fixture(), null, 2))

  await withServer(file, async (base) => {
    const state = fixture()
    assert.equal((await sync(base, state)).headers.get('x-opentodo-dedup'), '0')
    assert.equal((await sync(base, state)).headers.get('x-opentodo-dedup'), '1')
    await new Promise((r) => setTimeout(r, DEDUPE_MS + 250))
    const res = await sync(base, state)
    assert.equal(res.headers.get('x-opentodo-dedup'), '0')
    const body = await res.json()
    assert.equal(body.changed, false)
    assert.equal(body.revision, 50)
  })
})

test('/api/sync:单设备 >2rps 持续窗口只 warn,不返回 429', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentodo-sync-file-'))
  const file = path.join(dir, 'todos.json')
  fs.writeFileSync(file, JSON.stringify(fixture(), null, 2))

  await withServer(file, async (base, getStderr) => {
    const state = fixture()
    const statuses = []
    for (let i = 0; i < 9; i++) {
      const r = await sync(base, state)
      statuses.push(r.status)
      await r.arrayBuffer()
      await new Promise((r2) => setTimeout(r2, 130))
    }
    assert.deepEqual([...new Set(statuses)], [200])
    // warn 是异步写 stderr,给它一个 tick
    await new Promise((r) => setTimeout(r, 150))
    assert.match(getStderr(), /\[sync_rps_warn\] device=dev-a rps=\d+\.\d+ .*action=log_only/)
    const health = await (await fetch(`${base}/api/health`)).json()
    assert.ok(health.sync_rps_warn >= 1)
  })
})
