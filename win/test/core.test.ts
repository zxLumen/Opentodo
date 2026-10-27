import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// @ts-ignore - plain ESM shared with the web app
import { runOp } from '../../web/ops.js'
// @ts-ignore - plain ESM shared with the web app
import { read } from '../../mcp/lib/store.js'
import { fastIntent } from '../src/ui/intent'
import type { TodoItem } from '../src/ui/types'

function sandbox(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `opentodo-${name}-`))
  process.env.OPENTODO_FILE = path.join(dir, 'todos.json')
  return process.env.OPENTODO_FILE
}

test('add + read keeps the v3 contract', () => {
  sandbox('add')
  runOp('add', { content: '写周报', project: '工作', list: '收件箱' })
  runOp('add', { content: '买牛奶', list: '收件箱' })
  const data = read()
  assert.equal(data.version, 3)
  assert.equal(data.items.length, 2)
  assert.equal(data.items[0].content, '写周报')
  assert.equal(data.items[0].project, '工作')
  assert.equal(data.items[0].order, 1)
  assert.equal(data.items[1].order, 1)
  assert.equal(data.revision, 2)
  assert.deepEqual(data.lists, ['收件箱'])
})

test('toggle / archive / restore', () => {
  sandbox('archive')
  const added = runOp('add', { content: '完成任务', list: '收件箱' })
  const id = added.items[0].id
  const done = runOp('toggle', { id })
  assert.equal(done.items[0].status, 'completed')
  assert.ok(done.items[0].completedAt)
  const archived = runOp('archiveCompleted', { list: '收件箱' })
  assert.ok(archived.items[0].archivedAt)
  const restored = runOp('restoreArchived', { list: '收件箱' })
  assert.equal(restored.items[0].archivedAt, null)
})

test('projects: add, rename (migration), delete (tombstones)', () => {
  sandbox('projects')
  runOp('addList', { name: '工作' })
  runOp('add', { content: '需求评审', list: '工作' })
  const renamed = runOp('renameList', { oldName: '工作', newName: '公司' })
  assert.deepEqual(renamed.lists, ['收件箱', '公司'])
  assert.equal(renamed.items[0].list, '公司')
  assert.ok(renamed.listRenames.some((r: { from: string; to: string }) => r.from === '工作' && r.to === '公司'))
  const afterDelete = runOp('deleteList', { name: '公司' })
  assert.ok(afterDelete.listTombstones.some((t: { name: string }) => t.name === '公司'))
  assert.equal(afterDelete.items.length, 0)
})

test('remove writes a tombstone', () => {
  sandbox('remove')
  const added = runOp('add', { content: '待删除', list: '收件箱' })
  const id = added.items[0].id
  const removed = runOp('remove', { id })
  assert.equal(removed.items.length, 0)
  assert.ok(removed.tombstones.some((t: { id: string }) => t.id === id))
})

test('reorder + move across projects/lists', () => {
  sandbox('move')
  const a = runOp('add', { content: 'a', list: '收件箱' }).items[0]
  const second = runOp('add', { content: 'b', list: '收件箱' })
  const b = second.items.find((i: TodoItem) => i.content === 'b')!
  const reordered = runOp('reorder', { orderedIds: [b.id, a.id] })
  const byOrder = reordered.items
    .slice()
    .sort((x: TodoItem, y: TodoItem) => x.order - y.order)
    .map((i: TodoItem) => i.id)
  assert.deepEqual(byOrder, [b.id, a.id])
  runOp('addList', { name: '工作' })
  const moved = runOp('move', { id: b.id, toProject: '工作', beforeId: null })
  assert.equal(moved.items.find((i: TodoItem) => i.id === b.id)?.project, '工作')
})

test('fast intent handles unambiguous commands and falls back otherwise', () => {
  sandbox('intent')
  const added = runOp('add', { content: '写周报', list: '收件箱' })
  const items = added.items as TodoItem[]
  const add = fastIntent('加一条 买牛奶', items, '收件箱')
  assert.equal(add?.ops[0].op, 'add')
  assert.equal(add?.ops[0].args.content, '买牛奶')
  const done = fastIntent('完成 写周报', items, '收件箱')
  assert.equal(done?.ops[0].op, 'toggle')
  const remove = fastIntent('删除 写周报', items, '收件箱')
  assert.equal(remove?.ops[0].op, 'remove')
  assert.match(fastIntent('列出待办', items, '收件箱')?.reply ?? '', /未完成待办/)
  assert.equal(fastIntent('帮我规划一个复杂的项目', items, '收件箱'), null)
  assert.equal(fastIntent('完成 不存在的条目', items, '收件箱'), null)
})
