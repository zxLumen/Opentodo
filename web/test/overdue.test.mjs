import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ageDays,
  dueDateKey,
  dueInDays,
  dueTier,
  isOverduePending,
  resolveDueAt,
  scanOverdue,
  DUE_SOON_DAYS,
  OVERDUE_DAYS,
} from '../overdue.js'

const NOW = new Date('2026-11-07T00:00:00Z')

function item(id, createdAt, extra = {}) {
  return {
    id,
    content: id,
    status: 'pending',
    priority: 'medium',
    project: null,
    list: '收件箱',
    archivedAt: null,
    order: 1,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    ...extra,
  }
}

test('ageDays 按整天向下取整', () => {
  assert.equal(ageDays(item('a', '2026-10-05T03:46:34.233Z'), NOW), 32)
  assert.equal(ageDays(item('b', '2026-11-07T00:00:00.000Z'), NOW), 0)
  assert.equal(ageDays(item('c', null, { updatedAt: null }), NOW), null)
})

test('缺 createdAt 时回退 updatedAt', () => {
  assert.equal(ageDays({ updatedAt: '2026-10-01T00:00:00Z' }, NOW), 37)
})

test('超过 30 天才算到期,正好 30 天不算', () => {
  assert.equal(OVERDUE_DAYS, 30)
  assert.equal(isOverduePending(item('a', '2026-10-08T00:00:00Z'), NOW), false)
  assert.equal(isOverduePending(item('b', '2026-10-07T00:00:00Z'), NOW), true)
})

test('非 pending / 已归档不算到期', () => {
  assert.equal(isOverduePending(item('a', '2026-09-01T00:00:00Z', { status: 'in_progress' }), NOW), false)
  assert.equal(
    isOverduePending(item('b', '2026-09-01T00:00:00Z', { archivedAt: '2026-10-01T00:00:00Z' }), NOW),
    false,
  )
})

test('scanOverdue:账龄分布、超期数量、按天数降序', () => {
  const items = [
    item('d44', '2026-09-23T12:49:16Z'),
    item('d37', '2026-09-30T13:21:33Z'),
    item('d32a', '2026-10-05T03:46:34Z'),
    item('d32b', '2026-10-05T06:50:11Z'),
    item('d26', '2026-10-11T10:55:41Z'),
    item('d15', '2026-10-22T09:47:46Z'),
    item('d10', '2026-10-27T07:19:04Z'),
    item('done', '2026-09-01T00:00:00Z', { status: 'completed' }),
    item('arch', '2026-09-01T00:00:00Z', { archivedAt: '2026-10-01T00:00:00Z' }),
  ]
  const scan = scanOverdue(items, { now: NOW })
  assert.equal(scan.totalPending, 7)
  assert.equal(scan.count, 4)
  assert.deepEqual(
    scan.buckets.map((b) => [b.label, b.count]),
    [
      ['0–7 天', 0],
      ['8–30 天', 3],
      ['31–40 天', 3],
      ['>40 天', 1],
    ],
  )
  assert.deepEqual(
    scan.overdue.map((x) => x.item.id),
    ['d44', 'd37', 'd32a', 'd32b'],
  )
})

// --- dueAt 三档判定 ---

test('resolveDueAt:dueAt 优先,兼容 dueDate/due/deadline', () => {
  assert.equal(
    dueDateKey(resolveDueAt(item('a', null, { dueAt: '2026-11-09', dueDate: '2026-11-10' }))),
    '2026-11-09',
  )
  assert.equal(dueDateKey(resolveDueAt(item('b', null, { dueDate: '2026-11-10' }))), '2026-11-10')
  assert.equal(dueDateKey(resolveDueAt(item('c', null, { due: '2026-11-11' }))), '2026-11-11')
  assert.equal(dueDateKey(resolveDueAt(item('d', null, { deadline: '2026-11-12' }))), '2026-11-12')
})

test('resolveDueAt:无 dueAt 时解析 content 的「下一步」', () => {
  const motorcycle = item('moto', '2026-10-11T11:04:06Z', {
    content: '摩托车年检｜下一步：2026-11-12 核对行驶证到期日并预约',
  })
  assert.equal(dueDateKey(resolveDueAt(motorcycle)), '2026-11-12')
  assert.equal(dueInDays(motorcycle, new Date(2026, 10, 13, 9, 0)), -1)

  assert.equal(resolveDueAt(item('bad', null, { content: '下一步：2026-02-30' })), null)
  assert.equal(resolveDueAt(item('none', null, { content: '没有日期' })), null)
})

test('dueInDays 按本地日历日计算,不受时分秒影响', () => {
  const now = new Date(2026, 10, 7, 23, 59)
  assert.equal(dueInDays(item('d0', null, { dueAt: '2026-11-07' }), now), 0)
  assert.equal(dueInDays(item('d1', null, { dueAt: '2026-11-08' }), now), 1)
  assert.equal(dueInDays(item('d7', null, { dueAt: '2026-11-14' }), now), 7)
  assert.equal(dueInDays(item('d8', null, { dueAt: '2026-11-15' }), now), 8)
  assert.equal(dueInDays(item('dm1', null, { dueAt: '2026-11-06' }), now), -1)
})

test('dueTier:1–7 天为 due-soon,0 天今天,负数逾期,8 天及无到期日不算', () => {
  const now = new Date(2026, 10, 7, 12, 0)
  assert.equal(DUE_SOON_DAYS, 7)
  assert.equal(dueTier(item('a', null, { dueAt: '2026-11-08' }), now), 'due-soon')
  assert.equal(dueTier(item('b', null, { dueAt: '2026-11-14' }), now), 'due-soon')
  assert.equal(dueTier(item('c', null, { dueAt: '2026-11-07' }), now), 'due-today')
  assert.equal(dueTier(item('d', null, { dueAt: '2026-11-06' }), now), 'due-overdue')
  assert.equal(dueTier(item('e', null, { dueAt: '2026-11-15' }), now), null)
  assert.equal(dueTier(item('f', null, { content: '无到期日' }), now), null)
})

test('scanOverdue:due 三档分组、排序与计数,只含 pending 未归档', () => {
  const now = new Date(2026, 10, 7, 12, 0)
  const items = [
    item('soon7', null, { dueAt: '2026-11-14' }),
    item('soon1', null, { dueAt: '2026-11-08' }),
    item('today', null, { dueAt: '2026-11-07' }),
    item('over1', null, { dueAt: '2026-11-06' }),
    item('over9', null, { dueAt: '2026-10-29' }),
    item('later8', null, { dueAt: '2026-11-15' }),
    item('nodue', null, { content: '没有日期' }),
    item('done', null, { dueAt: '2026-11-07', status: 'completed' }),
    item('arch', null, { dueAt: '2026-11-07', archivedAt: '2026-11-01T00:00:00Z' }),
  ]
  const scan = scanOverdue(items, { now })
  assert.equal(scan.totalPending, 7)
  assert.deepEqual(scan.due.counts, { soon: 2, today: 1, overdue: 2 })
  assert.equal(scan.due.total, 5)
  assert.deepEqual(
    scan.due.soon.map((x) => x.item.id),
    ['soon1', 'soon7'],
  )
  assert.deepEqual(
    scan.due.today.map((x) => x.item.id),
    ['today'],
  )
  assert.deepEqual(
    scan.due.overdue.map((x) => x.item.id),
    ['over9', 'over1'],
  )
  assert.equal(scan.due.soon[0].dueAt, '2026-11-08')
  assert.equal(scan.due.soon[0].dueInDays, 1)
  assert.equal(scan.due.overdue[0].dueInDays, -9)
})

test('scanOverdue:保留 30 天账龄桶,age overdue 同时带 dueAt', () => {
  const now = new Date(2026, 10, 7, 12, 0)
  const items = [
    item('old45', '2026-09-23T00:00:00Z', { dueAt: '2026-11-10' }),
    item('mid10', '2026-10-28T00:00:00Z'),
  ]
  const scan = scanOverdue(items, { now })
  assert.equal(scan.count, 1)
  assert.deepEqual(
    scan.buckets.map((b) => [b.label, b.count]),
    [
      ['0–7 天', 0],
      ['8–30 天', 1],
      ['31–40 天', 0],
      ['>40 天', 1],
    ],
  )
  assert.equal(scan.overdue[0].item.id, 'old45')
  assert.equal(scan.overdue[0].ageDays, 45)
  assert.equal(scan.overdue[0].dueAt, '2026-11-10')
  assert.equal(scan.due.counts.soon, 1)
})

test('resolveDueAt:非法 dueAt 回退 content,都非法时 dueAt 输出 null', () => {
  assert.equal(resolveDueAt(null), null)
  assert.equal(
    dueDateKey(resolveDueAt(item('a', null, { dueAt: 'not-a-date', content: '下一步:2026-11-20' }))),
    '2026-11-20',
  )
  const scan = scanOverdue(
    [item('b', '2026-09-01T00:00:00Z', { dueAt: 'not-a-date', content: '下一步：2026-02-30' })],
    { now: new Date(2026, 10, 7, 12, 0) },
  )
  assert.equal(scan.due.total, 0)
  assert.equal(scan.overdue[0].dueAt, null)
})
