import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dueItems, pendingCount, renderTodayPage, SOURCES, STATIONS, OFFICES } from '../today.js'
import { normalizeItem } from '../../mcp/lib/store.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB = path.resolve(HERE, '..')

function item(id, extra = {}) {
  return {
    id,
    content: id,
    status: 'pending',
    priority: 'medium',
    project: null,
    list: '收件箱',
    archivedAt: null,
    order: 1,
    createdAt: '2025-12-01T00:00:00.000Z',
    updatedAt: '2025-12-01T00:00:00.000Z',
    completedAt: null,
    ...extra,
  }
}

function fixture() {
  const pending = [
    item('due1', {
      content: '摩托车年检｜下一步：2026-01-01 核对行驶证并预约',
      note: '备注要保留',
      createdAt: '2025-12-01T00:00:00.000Z',
    }),
    item('due2', { content: '每个交管局都去一下｜下一步：2026-01-01 就近办理' }),
    item('p3'),
    item('p4'),
    item('p5'),
    item('p6'),
    item('p7'),
    item('p8'),
    item('p9'),
  ]
  return {
    version: 3,
    revision: 50,
    updatedAt: '2026-01-01T00:00:00.000Z',
    items: pending.concat([
      item('done1', { status: 'completed', completedAt: null, note: '历史完成项备注必须保留' }),
      item('doing1', { status: 'in_progress' }),
    ]),
    lists: ['收件箱'],
    tombstones: [],
    listTombstones: [],
    listRenames: [],
    listsUpdatedAt: '2026-01-01T00:00:00.000Z',
  }
}

test('dueItems:解析「下一步」日期,按到期日排序并算出已拖天数', () => {
  const now = new Date('2026-11-14T00:13:00.000Z')
  const data = {
    items: [
      item('a', {
        content: '摩托车年检｜下一步：2026-11-14 核对行驶证',
        createdAt: '2026-10-11T11:04:06.865Z',
      }),
      item('b', {
        content: '每个交管局都去一下｜下一步：2026-11-14 就近办理',
        createdAt: '2026-10-11T11:04:06.875Z',
      }),
      item('c', { content: '未来任务｜下一步：2026-11-20' }),
      item('d', { content: '没有日期' }),
      item('e', { content: '已完成｜下一步：2026-11-14', status: 'completed' }),
    ],
  }
  const list = dueItems(data, now)
  assert.deepEqual(list.map((x) => x.id), ['a', 'b'])
  assert.equal(list[0].dueAt, '2026-11-14')
  assert.equal(list[0].overdueDays, 0)
  assert.equal(list[0].ageDays, 33)
  assert.equal(list[0].title, '摩托车年检')
})

test('dueItems:逾期的到期日显示正数天数', () => {
  const now = new Date('2026-11-14T04:00:00.000Z')
  const list = dueItems({ items: [item('x', { content: '旧事｜下一步：2026-11-12' })] }, now)
  assert.equal(list[0].overdueDays, 2)
})

test('renderTodayPage:顶部两条、pending 9→7、官方来源/地图/电话/材料齐全', () => {
  const now = new Date('2026-11-14T00:13:00.000Z')
  const data = fixture()
  data.items[0].content = '摩托车年检｜下一步：2026-11-14 核对行驶证'
  data.items[0].createdAt = '2026-10-11T11:04:06.865Z'
  data.items[1].content = '每个交管局都去一下｜下一步：2026-11-14 就近办理'
  data.items[1].createdAt = '2026-10-11T11:04:06.875Z'
  const html = renderTodayPage({ data, now })

  assert.match(html, /pending <b>9<\/b> → <b>7<\/b>/)
  assert.match(html, /已拖 33 天/)
  assert.equal(pendingCount(data), 9)
  assert.equal(STATIONS.length >= 3, true)
  assert.equal(OFFICES.length >= 2, true)
  for (const s of STATIONS) {
    assert.match(html, new RegExp(s.name))
    assert.match(html, new RegExp(`href="tel:${s.phone.replace(/[^\d+]/g, '')}"`))
  }
  for (const s of OFFICES) assert.match(html, new RegExp(s.name))
  assert.match(html, /uri\.amap\.com/)
  assert.match(html, /map\.baidu\.com/)
  assert.match(html, /交强险/)
  assert.match(html, /行驶证/)
  assert.match(html, /身份证/)
  assert.match(html, /未查到/)
  assert.match(html, /抓取 2026-11-14 08:13/)
  for (const s of Object.values(SOURCES)) assert.ok(html.includes(s.url), s.url)
  assert.doesNotMatch(html, /<script[^>]+src=/)
  assert.doesNotMatch(html, /<link[^>]+rel="stylesheet"/)
  assert.doesNotMatch(html, /<img\b/)
})

test('renderTodayPage:转义待办内容,避免 XSS', () => {
  const html = renderTodayPage({
    data: { revision: 1, items: [item('x', { content: '<script>alert(1)</script>｜下一步：2026-01-01' })] },
    now: new Date('2026-11-14T00:00:00.000Z'),
  })
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
})

test('normalizeItem:保留 note,历史 completed 的 completedAt=null 不被补写', () => {
  const it = normalizeItem({ id: 'x', status: 'completed', completedAt: null, note: '别丢', content: '任务' })
  assert.equal(it.note, '别丢')
  assert.equal(it.completedAt, null)
})

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port
      s.close(() => resolve(port))
    })
  })
}

async function waitHealth(base) {
  for (let i = 0; i < 60; i++) {
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

async function withServer(file, fn) {
  const port = await freePort()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentodo-today-'))
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: WEB,
    env: {
      ...process.env,
      PORT: String(port),
      OPENTODO_FILE: file,
      OPENTODO_DATA_DIR: dataDir,
      OPENTODO_OWNER_TOKEN: 'test-owner',
    },
    stdio: 'ignore',
  })
  const base = `http://127.0.0.1:${port}`
  try {
    await waitHealth(base)
    return await fn(base)
  } finally {
    proc.kill('SIGTERM')
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

const COOKIE = { cookie: 'zx_todo_owner=test-owner' }

async function op(base, body) {
  const r = await fetch(`${base}/api/op`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...COOKIE },
    body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json() }
}

test('GET /today + setStatus 全流程:pending 9→7、revision +2、其他条目 0 变动', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentodo-today-file-'))
  const file = path.join(dir, 'todos.json')
  const before = fixture()
  fs.writeFileSync(file, JSON.stringify(before, null, 2))

  await withServer(file, async (base) => {
    const page = await fetch(`${base}/today`, { headers: COOKIE })
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type'), /text\/html/)
    const html = await page.text()
    assert.match(html, /pending <b>9<\/b> → <b>7<\/b>/)
    assert.match(html, /摩托车年检/)

    // 过期 revision → 409,且不落盘
    const stale = await op(base, { op: 'setStatus', id: 'due1', status: 'completed', baseRevision: 49 })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.revision, 50)
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).revision, 50)

    // 正确 revision → 第一条
    const first = await op(base, { op: 'setStatus', id: 'due1', status: 'completed', baseRevision: 50 })
    assert.equal(first.status, 200)
    assert.equal(first.body.data.revision, 51)

    // 第二条用最新 revision
    const second = await op(base, { op: 'setStatus', id: 'due2', status: 'completed', baseRevision: 51 })
    assert.equal(second.status, 200)
    assert.equal(second.body.data.revision, 52)

    // 再来一次过期 revision → 409(revision 已 52)
    const stale2 = await op(base, { op: 'setStatus', id: 'p3', status: 'completed', baseRevision: 50 })
    assert.equal(stale2.status, 409)
  })

  const after = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(after.revision, 52)
  assert.equal(pendingCount(after), 7)
  const a = new Map(before.items.map((x) => [x.id, x]))
  const b = new Map(after.items.map((x) => [x.id, x]))
  const changed = [...a.keys()].filter((id) => JSON.stringify(a.get(id)) !== JSON.stringify(b.get(id)))
  assert.deepEqual(changed.sort(), ['due1', 'due2'])
  assert.equal(b.get('due1').status, 'completed')
  assert.equal(b.get('due2').status, 'completed')
  assert.equal(b.get('done1').note, '历史完成项备注必须保留')
  assert.equal(b.get('done1').completedAt, null)
  assert.equal(b.get('due1').note, '备注要保留')

  fs.rmSync(dir, { recursive: true, force: true })
})
