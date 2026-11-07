import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ageDays, isOverduePending, scanOverdue, OVERDUE_DAYS } from '../overdue.js'

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
