import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { read, nowIso } from '../../mcp/lib/store.js'
import { runOp } from '../ops.js'

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentodo-ops-'))
  return path.join(dir, 'todos.json')
}

test('remove 写条目墓碑', () => {
  const file = tempFile()
  const added = runOp('add', { content: '任务', list: '收件箱' }, file)
  const id = added.items[0].id
  const after = runOp('remove', { id }, file)
  assert.equal(after.items.length, 0)
  assert.deepEqual(after.tombstones.map((t) => t.id), [id])
})

test('deleteList 写项目墓碑 + 条目墓碑', () => {
  const file = tempFile()
  runOp('add', { content: 'A', list: '临时' }, file)
  runOp('add', { content: 'B', list: '临时' }, file)
  const after = runOp('deleteList', { name: '临时' }, file)
  assert.ok(!after.lists.includes('临时'))
  assert.equal(after.items.filter((i) => i.list === '临时').length, 0)
  assert.ok(after.listTombstones.some((t) => t.name === '临时'))
  assert.equal(after.tombstones.length, 2)
})

test('renameList 写改名记录并把条目移到新名', () => {
  const file = tempFile()
  runOp('add', { content: 'A', list: '旧名' }, file)
  const after = runOp('renameList', { oldName: '旧名', newName: '新名' }, file)
  assert.ok(after.lists.includes('新名'))
  assert.ok(!after.lists.includes('旧名'))
  assert.equal(after.items[0].list, '新名')
  assert.ok(after.listRenames.some((r) => r.from === '旧名' && r.to === '新名'))
})

test('addList 重新加回同名项目会移除墓碑', () => {
  const file = tempFile()
  runOp('addList', { name: '项目X' }, file)
  runOp('deleteList', { name: '项目X' }, file)
  const after = runOp('addList', { name: '项目X' }, file)
  assert.ok(after.lists.includes('项目X'))
  assert.ok(!after.listTombstones.some((t) => t.name === '项目X'))
})

test('清空归档写墓碑而不是静默消失', () => {
  const file = tempFile()
  const added = runOp('add', { content: 'A', list: '收件箱' }, file)
  const id = added.items[0].id
  runOp('setStatus', { id, status: 'completed' }, file)
  runOp('setArchived', { id, archived: true }, file)
  const after = runOp('purgeArchived', { list: '收件箱' }, file)
  assert.equal(after.items.length, 0)
  assert.ok(after.tombstones.some((t) => t.id === id))
  assert.ok(nowIso())
})

test('sync 相关：删除后旧客户端再 push 也不会复活', async () => {
  const { mergeData } = await import('../../mcp/lib/merge.js')
  const file = tempFile()
  const added = runOp('add', { content: 'A', list: '收件箱' }, file)
  const id = added.items[0].id
  const afterDelete = runOp('remove', { id }, file)
  const stale = added
  const merged = mergeData(afterDelete, stale)
  assert.equal(merged.items.length, 0)
  assert.ok(merged.tombstones.some((t) => t.id === id))
})

test('数据文件仍是合法的 v3 JSON', () => {
  const file = tempFile()
  runOp('add', { content: '任务', list: '收件箱' }, file)
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(raw.version, 3)
  assert.ok(Array.isArray(raw.tombstones))
  assert.ok('listsUpdatedAt' in raw)
  const normalized = read(file)
  assert.equal(normalized.version, 3)
})
