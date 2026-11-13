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

/** 扫描清单 Markdown(带表格,用于文档/终端)。 */
export function renderMarkdown({ file, data, scan }) {
  const lines = [
    `# Opentodo 到期扫描 · ${stamp(scan.now)}`,
    '',
    `- 数据文件: \`${file}\``,
    `- revision: ${data.revision ?? '—'}`,
    `- pending: ${scan.totalPending}`,
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
  lines.push('', '## dueAt 到期判定', '', `- 未来 ${DUE_SOON_DAYS} 天内到期：${scan.due.counts.soon} 条`, `- 今天到期：${scan.due.counts.today} 条`, `- 已逾期：${scan.due.counts.overdue} 条`, '')
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
    `- 超 ${scan.days} 天：**${scan.count}** 条`,
    `- revision：${data.revision ?? '—'}`,
    '- 面板：https://todo.zxlumen.cn',
    '',
    '## 账龄分布',
    '',
    ...scan.buckets.map((b) => `- ${b.label}：${b.count} 条`),
    '',
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

/** 邮件标题:0 条时也给出明确状态。 */
export function buildSubject(scan) {
  const head = `Opentodo 待办提醒 · ${stamp(scan.now)}`
  if (!scan.count) return `${head}｜没有超期待办`
  const urgent = scan.overdue.filter((x) => x.ageDays > 40).length
  const tail = urgent ? `（${urgent} 条超 40 天）` : ''
  return `${head}｜${scan.count} 条超 ${scan.days} 天${tail}`
}
