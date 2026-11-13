// 到期扫描的输出格式:给 CLI 的 Markdown 清单 + 给邮件日报的纯文本 Markdown。
// mailer.py 的 md_to_html 不渲染表格,所以邮件正文用列表,不用表格。

import fs from 'node:fs'
import { DUE_SOON_DAYS } from './overdue.js'

/** 读取 todos.json;兼容 GET /api/state 的 { data, owner } 包装。 */
export function readTodoData(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  return raw && raw.data && Array.isArray(raw.data.items) ? raw.data : raw
}

function pad(value) {
  return String(value).padStart(2, '0')
}

/** 本地日期 YYYY-MM-DD(日报按本地时区)。 */
export function stamp(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function mdCell(value) {
  return String(value ?? '—').replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function bucketRows(scan) {
  return scan.buckets.map((b) => `| ${b.label} | ${b.count} |`)
}

function dueRows(entries) {
  const rows = [
    '| 到期日 | 距今天数 | 项目 | 分组 | 内容 | ID |',
    '| --- | ---: | --- | --- | --- | --- |',
  ]
  for (const { item, dueAt, dueInDays } of entries) {
    const delta = dueInDays > 0 ? `+${dueInDays}` : String(dueInDays)
    rows.push(
      `| ${dueAt} | ${delta} | ${mdCell(item.list ?? '收件箱')} | ${mdCell(item.project ?? '—')} | ${mdCell(item.content)} | \`${item.id}\` |`,
    )
  }
  return rows
}

function dueSection(title, entries) {
  return [`### ${title}（${entries.length} 条）`, '', ...(entries.length ? dueRows(entries) : ['无。']), '']
}

function dueDelta(days) {
  if (days === 0) return '今天'
  if (days < 0) return `逾期 ${-days} 天`
  return `还有 ${days} 天`
}

function expiredList(entries) {
  return entries.map(({ item, dueAt, dueInDays }) => {
    const project = item.project ? ` / ${item.project}` : ''
    return `- **${dueAt}**（${dueDelta(dueInDays)}）· ${item.list ?? '收件箱'}${project} · ${item.content}（\`${item.id}\`）`
  })
}

/** 邮件里的到期分组:mailer 的 md_to_html 不渲染表格,用列表。 */
function dueEmailSection(title, entries) {
  const lines = [`### ${title}（${entries.length} 条）`, '']
  if (!entries.length) {
    lines.push('无。')
  } else {
    for (const { item, dueAt, dueInDays } of entries) {
      const delta =
        dueInDays > 0 ? `+${dueInDays} 天` : dueInDays === 0 ? '今天' : `${Math.abs(dueInDays)} 天前`
      const project = item.project ? ` / ${item.project}` : ''
      lines.push(
        `- **${dueAt}（${delta}）** · ${item.list ?? '收件箱'}${project} · ${item.content}（\`${item.id}\`）`,
      )
    }
  }
  lines.push('')
  return lines
}

/** 扫描清单 Markdown(带表格,用于文档/终端)。 */
export function renderMarkdown({ file, data, scan }) {
  const lines = [
    `# Opentodo 到期扫描 · ${stamp(scan.now)}`,
    '',
    `- 数据文件: \`${file}\``,
    `- revision: ${data.revision ?? '—'}`,
    `- pending: ${scan.totalPending}`,
    `- 已到期: ${scan.expiredCount}`,
    `- 超 ${scan.days} 天: ${scan.count}`,
    '',
    '## 账龄分布',
    '',
    '| 账龄 | 条数 |',
    '| --- | ---: |',
    ...bucketRows(scan),
    `| **合计** | **${scan.buckets.reduce((n, b) => n + b.count, 0)}** |`,
    '',
    `## 超 ${scan.days} 天清单(按天数降序)`,
    '',
  ]
  if (!scan.overdue.length) {
    lines.push('无。')
  } else {
    lines.push('| # | 天数 | 项目 | 分组 | 内容 | ID |', '| ---: | ---: | --- | --- | --- | --- |')
    scan.overdue.forEach(({ item, ageDays }, i) => {
      lines.push(
        `| ${i + 1} | ${ageDays} | ${mdCell(item.list ?? '收件箱')} | ${mdCell(item.project ?? '—')} | ${mdCell(item.content)} | \`${item.id}\` |`,
      )
    })
  }
  lines.push('', '## dueAt 到期判定', '', `- 已到期：${scan.due.counts.expired} 条`, `- 未来 ${DUE_SOON_DAYS} 天内到期：${scan.due.counts.soon} 条`, `- 今天到期：${scan.due.counts.today} 条`, `- 已逾期：${scan.due.counts.overdue} 条`, '')
  lines.push(...dueSection('已到期（今天到期 + 已逾期）', scan.due.expired))
  lines.push(...dueSection(`未来 ${DUE_SOON_DAYS} 天内到期`, scan.due.soon))
  lines.push(...dueSection('今天到期', scan.due.today))
  lines.push(...dueSection('已逾期', scan.due.overdue))
  lines.push('> 只读扫描,未修改任何待办。', '')
  return lines.join('\n')
}

/** 邮件日报 Markdown:标题 + 摘要 + 账龄分布 + 完整超期清单。 */
export function renderEmailMarkdown({ data, scan }) {
  const lines = [
    `# Opentodo 待办日报 · ${stamp(scan.now)}`,
    '',
    `- pending：**${scan.totalPending}** 条`,
    `- 已到期：**${scan.expiredCount}** 条`,
    `- 超 ${scan.days} 天：**${scan.count}** 条`,
    `- revision：${data.revision ?? '—'}`,
    '- 面板：https://todo.zxlumen.cn',
    '',
    '## 账龄分布',
    '',
    ...scan.buckets.map((b) => `- ${b.label}：${b.count} 条`),
    '',
    `## 已到期 ${scan.expiredCount} 条（今天到期 + 已逾期）`,
    '',
    ...(scan.expired.length ? expiredList(scan.expired) : ['今天没有已到期的待办。']),
    '',
    '## dueAt 到期判定',
    '',
    `- 未来 ${DUE_SOON_DAYS} 天内到期：**${scan.due.counts.soon}** 条`,
    `- 今天到期：**${scan.due.counts.today}** 条`,
    `- 已逾期：**${scan.due.counts.overdue}** 条`,
    '',
    ...dueEmailSection(`未来 ${DUE_SOON_DAYS} 天内到期`, scan.due.soon),
    ...dueEmailSection('今天到期', scan.due.today),
    ...dueEmailSection('已逾期', scan.due.overdue),
    `## 超 ${scan.days} 天清单（${scan.count} 条，按天数降序）`,
    '',
  ]
  if (!scan.overdue.length) {
    lines.push('今天没有超期的待办。')
  } else {
    for (const { item, ageDays } of scan.overdue) {
      const project = item.project ? ` / ${item.project}` : ''
      lines.push(
        `- **${ageDays} 天** · ${item.list ?? '收件箱'}${project} · ${item.content}（\`${item.id}\`）`,
      )
    }
  }
  lines.push('', '> 只读扫描，未修改任何待办。', '')
  return lines.join('\n')
}

/** 邮件标题:账龄与 dueAt 三档都给数字,0 条时也给出明确状态。 */
export function buildSubject(scan) {
  const head = `Opentodo 待办提醒 · ${stamp(scan.now)}`
  const parts = []
  if (scan.expiredCount) {
    const { today, overdue } = scan.due.counts
    parts.push(`已到期 ${scan.expiredCount} 条（今天 ${today} / 逾期 ${overdue}）`)
  }
  if (scan.count) {
    const urgent = scan.overdue.filter((x) => x.ageDays > 40).length
    const tail = urgent ? `（${urgent} 条超 40 天）` : ''
    parts.push(`${scan.count} 条超 ${scan.days} 天${tail}`)
  }
  if (!parts.length) return `${head}｜没有到期或超期待办`
  return `${head}｜${parts.join('｜')}`
}
