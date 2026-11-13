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
  assert.equal(buildSubject(scanOverdue([], { now: NOW })), 'Opentodo 待办提醒 · 2026-11-07｜没有到期或超期待办')
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

const dueData = {
  revision: 43,
  items: [
    item('old-due', '2026-09-23T00:00:00Z', { content: '旧任务', dueAt: '2026-11-09' }),
    item('today', '2026-11-01T00:00:00Z', { content: '今天任务', dueAt: '2026-11-07' }),
    item('over', '2026-11-01T00:00:00Z', { content: '逾期任务', dueAt: '2026-11-05' }),
    item('noage', null, { content: '无账龄逾期', dueAt: '2026-11-06', updatedAt: null }),
  ],
}
const dueScan = scanOverdue(dueData.items, { now: NOW })

test('buildSubject:同时带 30 天账龄与 dueAt 三档数字', () => {
  assert.equal(
    buildSubject(dueScan),
    'Opentodo 待办提醒 · 2026-11-07｜已到期 3 条（今天 1 / 逾期 2）｜1 条超 30 天（1 条超 40 天）',
  )
})

test('renderEmailMarkdown:输出 dueAt 三档数字与清单(含 dueAt/距今天数)', () => {
  const body = renderEmailMarkdown({ data: dueData, scan: dueScan })
  assert.match(body, /## dueAt 到期判定/)
  assert.match(body, /未来 7 天内到期：\*\*1\*\* 条/)
  assert.match(body, /今天到期：\*\*1\*\* 条/)
  assert.match(body, /已逾期：\*\*2\*\* 条/)
  assert.match(body, /\*\*2026-11-09（\+2 天）\*\* · 收件箱 · 旧任务/)
  assert.match(body, /\*\*2026-11-07（今天）\*\* · 收件箱 · 今天任务/)
  assert.match(body, /\*\*2026-11-05（2 天前）\*\* · 收件箱 · 逾期任务/)
  assert.match(body, /无账龄逾期/)
})

test('overdue-mail CLI:只有 dueAt 到期、账龄不足 30 天也会发送', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentodo-mail-due-'))
  const todoFile = path.join(dir, 'todos.json')
  const mailer = path.join(dir, 'mailer.py')
  const out = path.join(dir, 'sent.txt')
  fs.writeFileSync(
    todoFile,
    JSON.stringify({
      revision: 8,
      items: [
        item('today', '2026-11-01T00:00:00Z', { content: '今天任务', dueAt: '2026-11-07' }),
        item('over', '2026-11-01T00:00:00Z', { content: '逾期任务', dueAt: '2026-11-06' }),
      ],
    }),
  )
  fs.writeFileSync(
    mailer,
    [
      'import os',
      'def send(subject, body_md, to=None):',
      "    with open(os.environ['MAIL_OUT'], 'w', encoding='utf-8') as f:",
      "        f.write(subject + '\\n---\\n' + body_md)",
      "    return True, 'mock ok'",
      '',
    ].join('\n'),
  )

  const r = spawnSync(
    process.execPath,
    ['scripts/overdue-mail.mjs', '--file', todoFile, '--now', '2026-11-07T00:00:00Z', '--mailer', mailer],
    { cwd: path.resolve('.'), encoding: 'utf8', env: { ...process.env, MAIL_OUT: out } },
  )
  assert.equal(r.status, 0, r.stderr)
  const sent = fs.readFileSync(out, 'utf8')
  assert.match(sent, /已到期 2 条（今天 1 \/ 逾期 1）/)
  assert.match(sent, /已逾期：\*\*1\*\* 条/)
  assert.match(sent, /今天任务/)
})

test('overdue-scan CLI:JSON 输出包含 dueAt 字段与三档分组', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentodo-scan-'))
  const todoFile = path.join(dir, 'todos.json')
  fs.writeFileSync(
    todoFile,
    JSON.stringify({
      revision: 7,
      items: [
        item('old-due', '2026-09-23T00:00:00Z', { content: '旧任务', dueAt: '2026-11-09' }),
        item('old-nodue', '2026-09-01T00:00:00Z', { content: '无到期日' }),
        item('moto', '2026-10-11T00:00:00Z', { content: '摩托车年检｜下一步：2026-11-07' }),
      ],
    }),
  )

  const r = spawnSync(
    process.execPath,
    ['scripts/overdue-scan.mjs', '--file', todoFile, '--now', '2026-11-07T00:00:00Z', '--json'],
    { cwd: path.resolve('.'), encoding: 'utf8' },
  )
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)

  assert.equal(out.overdue.length, 2)
  for (const entry of out.overdue) assert.ok(Object.hasOwn(entry, 'dueAt'))
  assert.equal(out.overdue.find((x) => x.id === 'old-due').dueAt, '2026-11-09')
  assert.equal(out.overdue.find((x) => x.id === 'old-nodue').dueAt, null)

  assert.equal(out.due.total, 2)
  assert.equal(out.due.soon[0].dueAt, '2026-11-09')
  assert.equal(out.due.soon[0].dueInDays, 2)
  assert.equal(out.due.today[0].dueAt, '2026-11-07')
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

// --- 已到期单列(主题/正文) ---

test('buildSubject:只有已到期且无 30 天项时单列「已到期 N 条」', () => {
  const s = scanOverdue(
    [
      item('today', '2026-11-01T00:00:00Z', { dueAt: '2026-11-07' }),
      item('yesterday', '2026-11-01T00:00:00Z', { dueAt: '2026-11-06' }),
    ],
    { now: NOW },
  )
  assert.equal(
    buildSubject(s),
    'Opentodo 待办提醒 · 2026-11-07｜已到期 2 条（今天 1 / 逾期 1）',
  )
})

test('renderEmailMarkdown:已到期单列今天与昨天,未来/无日期不进清单', () => {
  const d = {
    revision: 9,
    items: [
      item('today', '2026-11-01T00:00:00Z', { content: '今天任务', dueAt: '2026-11-07' }),
      item('yesterday', '2026-11-01T00:00:00Z', { content: '昨天任务', dueAt: '2026-11-06' }),
      item('future', '2026-11-01T00:00:00Z', { content: '未来任务', dueAt: '2026-11-30' }),
      item('nodate', '2026-11-01T00:00:00Z', { content: '无日期任务' }),
    ],
  }
  const s = scanOverdue(d.items, { now: NOW })
  const body = renderEmailMarkdown({ data: d, scan: s })
  assert.match(body, /## 已到期 2 条（今天到期 \+ 已逾期）/)
  assert.match(body, /\*\*2026-11-07\*\*（今天）.*今天任务/)
  assert.match(body, /\*\*2026-11-06\*\*（逾期 1 天）.*昨天任务/)
  assert.doesNotMatch(body, /未来任务/)
  assert.doesNotMatch(body, /无日期任务/)
})

test('renderEmailMarkdown:无日期且无账龄时明确没有已到期', () => {
  const d = { revision: 10, items: [item('nodate', '2026-11-01T00:00:00Z', { content: '没有日期' })] }
  const s = scanOverdue(d.items, { now: NOW })
  const body = renderEmailMarkdown({ data: d, scan: s })
  assert.match(body, /## 已到期 0 条/)
  assert.match(body, /今天没有已到期的待办/)
  assert.equal(buildSubject(s), 'Opentodo 待办提醒 · 2026-11-07｜没有到期或超期待办')
})

test('overdue-mail CLI:仅 content 里的已到期(无 30 天)也会发送', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentodo-mail-expired-'))
  const todoFile = path.join(dir, 'todos.json')
  const mailer = path.join(dir, 'mailer.py')
  const out = path.join(dir, 'sent.txt')
  fs.writeFileSync(
    todoFile,
    JSON.stringify({
      revision: 11,
      items: [
        item('today', '2026-11-01T00:00:00Z', { content: '今天任务｜下一步：2026-11-07' }),
        item('yesterday', '2026-11-01T00:00:00Z', { content: '昨天任务｜下一步 2026-11-06' }),
      ],
    }),
  )
  fs.writeFileSync(
    mailer,
    [
      'import os',
      'def send(subject, body_md, to=None):',
      "    with open(os.environ['MAIL_OUT'], 'w', encoding='utf-8') as f:",
      "        f.write(subject + '\\n---\\n' + body_md)",
      "    return True, 'mock ok'",
      '',
    ].join('\n'),
  )

  const r = spawnSync(
    process.execPath,
    ['scripts/overdue-mail.mjs', '--file', todoFile, '--now', '2026-11-07T00:00:00Z', '--mailer', mailer],
    { cwd: path.resolve('.'), encoding: 'utf8', env: { ...process.env, MAIL_OUT: out } },
  )
  assert.equal(r.status, 0, r.stderr)
  const sent = fs.readFileSync(out, 'utf8')
  assert.match(sent, /已到期 2 条（今天 1 \/ 逾期 1）/)
  assert.match(sent, /## 已到期 2 条/)
  assert.match(sent, /昨天任务/)
})
