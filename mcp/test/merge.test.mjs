import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeData, contentSignature } from '../lib/store.js'
import { mergeData, mergeChanged } from '../lib/merge.js'

const T1 = '2026-10-20T10:00:00.000Z'
const T2 = '2026-10-21T10:00:00.000Z'
const T3 = '2026-10-22T10:00:00.000Z'

function item(over = {}) {
  return {
    id: 'a1',
    content: '买牛奶',
    status: 'pending',
    priority: 'medium',
    project: null,
    list: '收件箱',
    archivedAt: null,
    order: 1,
    createdAt: T1,
    updatedAt: T1,
    completedAt: null,
    ...over,
  }
}

function state(over = {}) {
  return normalizeData({
    version: 3,
    revision: 1,
    updatedAt: T1,
    items: [],
    lists: ['收件箱'],
    ...over,
  })
}

test('两边各加条目 → 并集', () => {
  const a = state({ items: [item({ id: 'a', content: 'A' })] })
  const b = state({ items: [item({ id: 'b', content: 'B' })], lists: ['收件箱', '工作'] })
  const m = mergeData(a, b)
  assert.deepEqual(m.items.map((i) => i.id).sort(), ['a', 'b'])
  assert.deepEqual(m.lists, ['收件箱', '工作'])
})

test('同一条目 updatedAt 更新的赢', () => {
  const a = state({ items: [item({ content: '旧', updatedAt: T1 })] })
  const b = state({ items: [item({ content: '新', updatedAt: T2 })] })
  assert.equal(mergeData(a, b).items[0].content, '新')
  assert.equal(mergeData(b, a).items[0].content, '新')
})

test('删除永远赢:墓碑压过更晚的编辑', () => {
  const a = state({
    items: [],
    tombstones: [{ id: 'a1', deletedAt: T1 }],
  })
  const b = state({ items: [item({ updatedAt: T3 })] })
  const m = mergeData(a, b)
  assert.equal(m.items.length, 0)
  assert.equal(m.tombstones.length, 1)
  assert.equal(mergeChanged(b, m), true)
})

test('墓碑会传播给仍持有旧条目的客户端', () => {
  const a = state({ tombstones: [{ id: 'a1', deletedAt: T2 }] })
  const b = state({ items: [item({ updatedAt: T1 })] })
  const m = mergeData(b, a)
  assert.equal(m.items.length, 0)
  // 再合并一次结果稳定(不会复活)
  assert.equal(contentSignature(mergeData(m, b)), contentSignature(m))
})

test('项目改名:旧名墓碑 + 改名记录把并发条目迁到新名', () => {
  const a = state({
    items: [item({ list: '工作', updatedAt: T1 })],
    lists: ['收件箱', '新工作'],
    listRenames: [{ from: '工作', to: '新工作', at: T2 }],
    listTombstones: [{ name: '工作', deletedAt: T2 }],
    listsUpdatedAt: T2,
  })
  const b = state({
    items: [item({ list: '工作', updatedAt: T3, content: '并发改' })],
    lists: ['收件箱', '工作'],
    listsUpdatedAt: T1,
  })
  const m = mergeData(a, b)
  assert.equal(m.items[0].list, '新工作')
  assert.deepEqual(m.lists, ['收件箱', '新工作'])
})

test('删除项目:并发新增的条目也被墓碑/项目删除挡住', () => {
  const a = state({
    items: [],
    lists: ['收件箱'],
    listTombstones: [{ name: '临时', deletedAt: T2 }],
    tombstones: [{ id: 'x1', deletedAt: T2 }],
    listsUpdatedAt: T2,
  })
  const b = state({
    items: [item({ id: 'x1', list: '临时', updatedAt: T3 })],
    lists: ['收件箱', '临时'],
  })
  const m = mergeData(a, b)
  assert.equal(m.items.length, 0)
  assert.deepEqual(m.lists, ['收件箱'])
})

test('删除后又明确重建同名项目 → 新项目保留', () => {
  const a = state({
    items: [],
    lists: ['收件箱'],
    listTombstones: [{ name: '项目X', deletedAt: T1 }],
    listsUpdatedAt: T1,
  })
  const b = state({
    items: [item({ id: 'n1', list: '项目X', updatedAt: T3 })],
    lists: ['收件箱', '项目X'],
    listsUpdatedAt: T3,
  })
  const m = mergeData(a, b)
  assert.deepEqual(m.lists, ['收件箱', '项目X'])
  assert.equal(m.items.length, 1)
})

test('组内 order 合并后重新编号 1..n', () => {
  const a = state({
    items: [
      item({ id: 'a', order: 5, project: 'p' }),
      item({ id: 'b', order: 9, project: 'p' }),
    ],
  })
  const b = state({ items: [item({ id: 'c', order: 7, project: 'p' })] })
  const m = mergeData(a, b)
  const orders = m.items.filter((i) => i.project === 'p').map((i) => i.order).sort()
  assert.deepEqual(orders, [1, 2, 3])
})

test('合并是幂等的', () => {
  const a = state({ items: [item()] })
  const b = state({ items: [item({ id: 'b', content: 'B' })], tombstones: [{ id: 'z', deletedAt: T2 }] })
  const once = mergeData(a, b)
  const twice = mergeData(once, b)
  assert.equal(contentSignature(once), contentSignature(twice))
  assert.equal(mergeChanged(once, twice), false)
})

test('空状态补齐收件箱', () => {
  assert.deepEqual(mergeData({}, {}).lists, ['收件箱'])
})

test('项目改名后又改回原名不会形成环', () => {
  const a = state({
    items: [item({ id: 'r1', list: 'A', updatedAt: T1 })],
    lists: ['收件箱', 'A'],
    listRenames: [
      { from: 'A', to: 'B', at: T1 },
      { from: 'B', to: 'A', at: T2 },
    ],
    listTombstones: [{ name: 'B', deletedAt: T2 }],
    listsUpdatedAt: T2,
  })
  const m = mergeData(a, state({}))
  assert.equal(m.items[0].list, 'A')
  assert.ok(m.lists.includes('A'))
  assert.ok(!m.lists.includes('B'))
})
