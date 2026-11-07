import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { buildSubject, renderEmailMarkdown, renderMarkdown } from '../overdue-report.js'
import { scanOverdue } from '../overdue.js'

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

const data = {
  revision: 42,
  items: [
    item('old', '2026-09-23T00:00:00Z', { content: '旧任务', list: 'blog', project: '内容' }),
    item('mid', '2026-10-05T00:00:00Z', { content: '中间任务', list: 'ESP' }),
    item('new', '2026-10-20T00:00:00Z', { content: '新任务' }),
  ],
}
const scan = scanOverdue(data.items, { now: NOW })

test('buildSubject:有超期时带数量与超 40 天提示', () => {
  assert.equal(buildSubject(scan), 'Opentodo 待办提醒 · 2026-11-07｜2 条超 30 天（1 条超 40 天）')
  assert.equal(buildSubject(scanOverdue([], { now: NOW })), 'Opentodo 待办提醒 · 2026-11-07｜没有超期待办')
})

test('renderEmailMarkdown:包含完整清单、账龄分布和面板链接,不用表格', () => {
  const body = renderEmailMarkdown({ data, scan })
  assert.match(body, /待办日报 · 2026-11-07/)
  assert.match(body, /pending：\*\*3\*\* 条/)
  assert.match(body, /\*\*45 天\*\* · blog \/ 内容 · 旧任务/)
  assert.match(body, /\*\*33 天\*\* · ESP · 中间任务/)
  assert.match(body, /31–40 天：1 条/)
  assert.match(body, /https:\/\/todo\.zxlumen\.cn/)
  assert.doesNotMatch(body, /\| ---/)
})

test('renderMarkdown:扫描清单仍是表格', () => {
  const body = renderMarkdown({ file: '/tmp/x.json', data, scan })
  assert.match(body, /\| 45 \| blog \| 内容 \| 旧任务 \| `old` \|/)
  assert.match(body, /只读扫描,未修改任何待办/)
})

test('overdue-mail CLI:通过 mailer 发送(用假 mailer 验证,不真发邮件)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentodo-mail-'))
  const todoFile = path.join(dir, 'todos.json')
  const mailer = path.join(dir, 'mailer.py')
  const out = path.join(dir, 'sent.txt')
  fs.writeFileSync(todoFile, JSON.stringify(data))
  fs.writeFileSync(
    mailer,
    [
      'import os',
      'def send(subject, body_md, to=None):',
      "    with open(os.environ['MAIL_OUT'], 'w', encoding='utf-8') as f:",
      "        f.write(subject + '\\n---\\n' + body_md + '\\n---\\n' + str(to))",
      "    return True, 'mock ok'",
      '',
    ].join('\n'),
  )

  const r = spawnSync(
    process.execPath,
    [
      'scripts/overdue-mail.mjs',
      '--file',
      todoFile,
      '--now',
      '2026-11-07T00:00:00Z',
      '--mailer',
      mailer,
      '--to',
      'test@example.com',
    ],
    {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      env: { ...process.env, MAIL_OUT: out },
    },
  )
  assert.equal(r.status, 0, r.stderr)
  const sent = fs.readFileSync(out, 'utf8')
  assert.match(sent, /Opentodo 待办提醒 · 2026-11-07｜2 条超 30 天/)
  assert.match(sent, /旧任务/)
  assert.match(sent, /test@example\.com/)
})

test('overdue-mail CLI:没有超期时默认不发', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentodo-mail-empty-'))
  const todoFile = path.join(dir, 'todos.json')
  const mailer = path.join(dir, 'mailer.py')
  fs.writeFileSync(todoFile, JSON.stringify({ revision: 1, items: [item('fresh', '2026-11-01T00:00:00Z')] }))
  fs.writeFileSync(mailer, 'def send(*a, **k):\n    raise AssertionError("不应发送")\n')

  const r = spawnSync(
    process.execPath,
    ['scripts/overdue-mail.mjs', '--file', todoFile, '--now', '2026-11-07T00:00:00Z', '--mailer', mailer],
    { cwd: path.resolve('.'), encoding: 'utf8' },
  )
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /跳过发送/)
})
