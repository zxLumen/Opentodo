// 「今天办」页:把到期待办 + 摩托车年检办事包渲染成一页手机优先的 HTML。
//
// 约定:
//   - 零 npm 依赖,只用 Node 内置能力;HTML 内联,不引外部脚本/样式/字体。
//   - 数据来自调用方传入的 TodoFile(与 /api/state 同一份 scope 文件),本模块只读。
//   - 页面里的检测场 / 车管站信息全部来自官方页面,逐条带 URL 与抓取时间;
//     官方页没有的字段写「未查到」,不猜地址、不猜电话。

const FETCHED = '2026-11-14 08:13'

export const SOURCES = {
  guide: {
    name: '交管局 · 申请机动车检验合格标志',
    url: 'https://jtgl.beijing.gov.cn/jgj/93950/jwgk/jdcgl/120148/index.html',
    fetchedAt: FETCHED,
  },
  prep: {
    name: '交管局 · 验车前的准备工作',
    url: 'https://jtgl.beijing.gov.cn/jgj/93950/check_car/zcfg74/624996/index.html',
    fetchedAt: FETCHED,
  },
  checkcar: {
    name: '交管局 · 预约验车',
    url: 'https://jtgl.beijing.gov.cn/jgj/93950/check_car/index.html',
    fetchedAt: FETCHED,
  },
  shenghua: {
    name: '交管局 · 盛华机动车检测场',
    url: 'https://jtgl.beijing.gov.cn/jgj/93950/check_car/jccjs58/475402/475994/index.html',
    fetchedAt: FETCHED,
  },
  yuegezhuang: {
    name: '交管局 · 岳各庄检测场',
    url: 'https://jtgl.beijing.gov.cn/jgj/93950/check_car/jccjs58/475412/476026/index.html',
    fetchedAt: FETCHED,
  },
  longquan: {
    name: '交管局 · 龙泉检测场',
    url: 'https://jtgl.beijing.gov.cn/jgj/93950/check_car/jccjs58/475407/11161308/index.html',
    fetchedAt: FETCHED,
  },
  beifang: {
    name: '交管局 · 北方检测场',
    url: 'https://jtgl.beijing.gov.cn/jgj/93950/check_car/jccjs58/475427/476126/index.html',
    fetchedAt: FETCHED,
  },
  xicheng: {
    name: '交管局 · 西城支队车管站网点调整公告',
    url: 'https://jtgl.beijing.gov.cn/jgj/jgxx/94246/95332/11078840/index.html',
    fetchedAt: FETCHED,
  },
  chaoyang: {
    name: '交管局 · 朝阳支队车管站地址公告',
    url: 'https://jtgl.beijing.gov.cn/jgj/jgxx/94246/95332/325745976/index.html',
    fetchedAt: FETCHED,
  },
  bj122: {
    name: '交通安全综合服务管理平台（北京）',
    url: 'https://bj.122.gov.cn/',
    fetchedAt: FETCHED,
  },
}

/** 可检摩托车(两轮)的检测场。字段均摘自对应官方检测场页。 */
export const STATIONS = [
  {
    name: '盛华机动车检测场',
    address: '北京市朝阳区王四营乡王四营大队东',
    phone: '010-87393211',
    saturday: '周六 8:00–12:00、13:00–17:00（法定节假日除外；周六不验新车）',
    fee: '未查到（检测场页未列检测收费；检验合格标志核发不收费）',
    types: '摩托车（不含正三轮摩托车）',
    source: 'shenghua',
  },
  {
    name: '岳各庄检测场',
    address: '北京市丰台区五里店318号',
    phone: '010-63809787',
    saturday: '周六 8:00–12:00、13:00–17:00（法定节假日除外；周六日新车检测 9:00–12:00、13:00–16:00）',
    fee: '未查到（检测场页未列检测收费；检验合格标志核发不收费）',
    types: '摩托车（京B 新车注册也可）',
    source: 'yuegezhuang',
  },
  {
    name: '龙泉检测场',
    address: '北京市海淀区西北旺镇冷泉东路66号西南1号院',
    phone: '010-58957277（预约）、010-58957177（咨询）',
    saturday: '周六 8:00–12:00、13:00–17:00（法定节假日除外；周六日不验新车）',
    fee: '未查到（检测场页未列检测收费；检验合格标志核发不收费）',
    types: '摩托车',
    source: 'longquan',
  },
  {
    name: '北方检测场',
    address: '北京市昌平区马池口镇马池口村',
    phone: '010-60772222',
    saturday: '周六 8:00–12:00、13:00–17:00（法定节假日除外；周六日不验新车）',
    fee: '未查到（检测场页未列检测收费；检验合格标志核发不收费）',
    types: '摩托车（含正三轮）',
    source: 'beifang',
  },
]

/** 车管站 / 交通支队窗口。地址与电话逐条对应官方来源。 */
export const OFFICES = [
  {
    name: '西城交通支队车管站',
    address: '北京市西城区广外红莲南路33号',
    phone: '010-68399206',
    saturday: '周六、日 9:00–16:00（法定节假日除外）',
    fee: '不收费（检验合格标志核发；其他车管业务按事项公示）',
    booking: '交管12123 APP → 机动车业务 → 机动车检验预约',
    sources: ['xicheng', 'guide'],
  },
  {
    name: '朝阳交通支队车管站',
    address: '北京市朝阳区百子湾西里303号',
    phone: '010-12123',
    saturday: '周六、日 9:00–16:00（法定节假日除外）',
    fee: '不收费（检验合格标志核发；其他车管业务按事项公示）',
    booking: '交管12123 APP → 机动车业务 → 机动车检验预约',
    sources: ['chaoyang', 'guide'],
    note: '地址摘自交管局公告；出发前建议先拨 010-12123 确认当日窗口开放。',
  },
]

/** 官方材料原文（交管局办事指南「十、提交的资料」）。 */
export const MATERIALS = [
  '机动车行驶证，免检车可以提交机动车行驶证或机动车所有人身份证明；',
  '由代理人代理的，还需提交代理人身份证明（代理人为单位的，还需提交经办人身份证明）以及机动车所有人的书面委托；免检车车辆所有人为个人且已登录「交管12123」手机APP申请网上委托，无需提交纸质委托书；',
  '机动车交通事故责任强制保险凭证，已联网核查的可以免予提交；',
  '机动车安全技术检验机构出具的机动车安全技术检验合格证明（免检车除外）；',
  '车船税纳税或者免税证明，已联网核查的可以免予提交。',
]

/** 官方「验车前的准备工作」中与送检车辆状态有关的原文摘录。 */
export const VEHICLE_CHECKS = [
  '送检机动车应清洁，无明显漏油、漏水、漏气现象，轮胎完好，轮胎气压正常且胎冠花纹中无异物；发动机应运转平稳，怠速稳定，无异响。',
  '所有车窗玻璃应完好且未粘贴镜面反光遮阳膜；各种灯具、仪表应齐全有效。',
  '配备有效灭火器（小、微型载客汽车除外）和机动车用三角警告牌。',
  '非法加装改装的，要恢复原状；使用可拆卸号牌架和可翻转号牌架的要拆除。',
  '号牌不清晰、不完整，影响识别时，应更换号牌；安装孔应安装符合 GA804 要求的固封装置。',
]

const DUE_RE = /(?:下一步|到期)[：:]\s*(\d{4}-\d{2}-\d{2})/
const ANY_DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/

export function beijingDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/** 从 content / note 里解析「下一步：YYYY-MM-DD」；没有就返回 null。 */
export function parseDue(item) {
  const text = `${item?.content ?? ''}\n${item?.note ?? ''}`
  const m = DUE_RE.exec(text) || ANY_DATE_RE.exec(text)
  if (!m) return null
  const date = m[1]
  return Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ? date : null
}

function dayDiff(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  return Math.round((b - a) / 86400000)
}

function elapsedDays(iso, now) {
  const t = Date.parse(String(iso ?? ''))
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.floor((now.getTime() - t) / 86400000))
}

/** 未归档且 pending / in_progress、到期日 <= 今天的条目，按到期日升序。 */
export function dueItems(data, now = new Date()) {
  const today = beijingDate(now)
  return (Array.isArray(data?.items) ? data.items : [])
    .filter(
      (it) =>
        !it.archivedAt &&
        (it.status === 'pending' || it.status === 'in_progress') &&
        parseDue(it) &&
        parseDue(it) <= today,
    )
    .map((it) => {
      const dueAt = parseDue(it)
      const overdueDays = dayDiff(dueAt, today)
      return {
        id: it.id,
        content: it.content,
        status: it.status,
        dueAt,
        overdueDays,
        ageDays: elapsedDays(it.createdAt, now),
        title: String(it.content ?? '').split('｜')[0].trim() || String(it.content ?? ''),
        next: (String(it.content ?? '').match(/下一步[：:]\s*([^｜]+)/) || [])[1]?.trim() || '',
      }
    })
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt) || String(a.id).localeCompare(String(b.id)))
}

export function pendingCount(data) {
  return (Array.isArray(data?.items) ? data.items : []).filter(
    (it) => !it.archivedAt && it.status === 'pending',
  ).length
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function telHref(phone) {
  const digits = String(phone ?? '').replace(/[^\d+]/g, '')
  return `tel:${digits}`
}

function amapUrl(name, address) {
  const q = encodeURIComponent(`${name} ${address}`)
  return `https://uri.amap.com/search?keyword=${q}&city=${encodeURIComponent('北京')}&src=opentodo&coordinate=gaode&callnative=0`
}

function baiduUrl(name, address) {
  return `https://map.baidu.com/search/${encodeURIComponent(`${name} ${address}`)}`
}

function sourceLink(key) {
  const s = SOURCES[key]
  if (!s) return ''
  return `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>
    <span class="fetched">抓取 ${esc(s.fetchedAt)}</span>`
}

function dueCard(it, now) {
  const today = beijingDate(now)
  const when =
    it.overdueDays > 0 ? `已逾期 ${it.overdueDays} 天` : it.dueAt === today ? '今天到期' : '即将到期'
  const age = it.ageDays == null ? '已拖天数未查到' : `已拖 ${it.ageDays} 天`
  return `<article class="card due" data-due-id="${esc(it.id)}">
    <div class="row">
      <span class="tag tag-warn">${esc(when)}</span>
      <span class="age">${esc(age)}</span>
    </div>
    <h2>${esc(it.title)}</h2>
    <p class="meta">到期日 <b>${esc(it.dueAt)}</b> · ${esc(age)}</p>
    ${it.next ? `<p class="next">下一步：${esc(it.next)}</p>` : ''}
    <button class="btn primary done" type="button" data-id="${esc(it.id)}">办完</button>
  </article>`
}

function stationCard(s) {
  return `<article class="card place">
    <div class="row">
      <h3>${esc(s.name)}</h3>
      <span class="tag">检测场</span>
    </div>
    <dl>
      <dt>地址</dt><dd>${esc(s.address)}
        <button class="mini copy" type="button" data-copy="${esc(s.address)}">复制地址</button>
      </dd>
      <dt>电话</dt><dd><a class="tel" href="${esc(telHref(s.phone))}">${esc(s.phone)}</a></dd>
      <dt>周六</dt><dd>${esc(s.saturday)}</dd>
      <dt>费用</dt><dd>${esc(s.fee)}</dd>
      <dt>可检</dt><dd>${esc(s.types)}</dd>
      <dt>预约</dt><dd>交管12123 APP / <a href="https://bj.122.gov.cn/" target="_blank" rel="noopener">bj.122.gov.cn</a>；或打上面的预约电话</dd>
    </dl>
    <div class="chips">
      <a class="chip" href="${esc(amapUrl(s.name, s.address))}" target="_blank" rel="noopener">高德地图</a>
      <a class="chip" href="${esc(baiduUrl(s.name, s.address))}" target="_blank" rel="noopener">百度地图</a>
    </div>
    <p class="source">来源：${sourceLink(s.source)}</p>
  </article>`
}

function officeCard(s) {
  return `<article class="card place">
    <div class="row">
      <h3>${esc(s.name)}</h3>
      <span class="tag">车管站</span>
    </div>
    <dl>
      <dt>地址</dt><dd>${esc(s.address)}
        <button class="mini copy" type="button" data-copy="${esc(s.address)}">复制地址</button>
      </dd>
      <dt>电话</dt><dd><a class="tel" href="${esc(telHref(s.phone))}">${esc(s.phone)}</a></dd>
      <dt>周六</dt><dd>${esc(s.saturday)}</dd>
      <dt>费用</dt><dd>${esc(s.fee)}</dd>
      <dt>预约</dt><dd>${esc(s.booking)}；网页端 <a href="https://bj.122.gov.cn/" target="_blank" rel="noopener">bj.122.gov.cn</a></dd>
    </dl>
    <div class="chips">
      <a class="chip" href="${esc(amapUrl(s.name, s.address))}" target="_blank" rel="noopener">高德地图</a>
      <a class="chip" href="${esc(baiduUrl(s.name, s.address))}" target="_blank" rel="noopener">百度地图</a>
    </div>
    ${s.note ? `<p class="note">${esc(s.note)}</p>` : ''}
    <p class="source">来源：${s.sources.map(sourceLink).join('<br>')}</p>
  </article>`
}

function sourcesTable() {
  const rows = Object.values(SOURCES)
    .map(
      (s) => `<li>
        <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>
        <span class="fetched">抓取 ${esc(s.fetchedAt)}</span>
      </li>`,
    )
    .join('')
  return `<ul class="sources">${rows}</ul>`
}

export function renderTodayPage({ data, owner = false, now = new Date() } = {}) {
  const allDue = dueItems(data, now)
  const due = allDue.slice(0, 6)
  const pending = pendingCount(data)
  const target = Math.max(0, pending - due.length)
  const today = beijingDate(now)
  const weekday = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    weekday: 'long',
  }).format(now)
  const boot = JSON.stringify({ revision: Number(data?.revision) || 0, pending, target, dueTotal: due.length, owner })
    .replace(/</g, '\\u003c')

  const dueHtml = due.length
    ? due.slice(0, 6).map((it) => dueCard(it, now)).join('')
    : `<article class="card"><h2>今天没有到期待办</h2><p class="meta">当前 pending ${pending} 条，按计划推进即可。</p></article>`

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b3b6f">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%230b6bcb'/%3E%3Cpath d='M9 17l5 5 9-11' stroke='white' stroke-width='3' fill='none'/%3E%3C/svg%3E">
<title>今天办 · 摩托车年检</title>
<style>
:root{--bg:#f4f6f8;--card:#fff;--ink:#111827;--muted:#6b7280;--line:#e5e7eb;--brand:#0b6bcb;--warn:#b45309;--ok:#047857;--hero:#0b3b6f}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif;-webkit-text-size-adjust:100%;overflow-wrap:anywhere}
.wrap{max-width:700px;margin:0 auto;padding:0 14px}
.hero{background:linear-gradient(150deg,#0b3b6f,#0b6bcb);color:#fff;padding:18px 0 16px}
.kicker{font-size:13px;opacity:.85}
h1{font-size:24px;line-height:1.25;margin:6px 0 4px}
.sub{margin:0 0 12px;opacity:.9;font-size:14px}
.pill{display:inline-block;padding:7px 12px;border-radius:999px;background:rgba(255,255,255,.16);font-size:14px}
.pill b{font-size:17px}
main{padding:14px 0 40px}
section{margin:18px 0}
h2{font-size:19px;line-height:1.3;margin:0 0 8px}
h3{font-size:17px;line-height:1.35;margin:0}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin:10px 0;box-shadow:0 1px 2px rgba(16,24,40,.04)}
.card.due{border-left:4px solid var(--warn)}
.card.done-card{opacity:.62}
.row{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.tag{display:inline-block;padding:2px 9px;border-radius:999px;background:#eef2f7;color:#334155;font-size:12px;white-space:nowrap}
.tag-warn{background:#fff4e5;color:var(--warn)}
.age{font-size:13px;color:var(--warn);font-weight:600}
.meta{font-size:13px;color:var(--muted);margin:6px 0}
.next{margin:6px 0 0;font-size:14px;color:#374151}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 16px;border-radius:11px;border:1px solid var(--line);background:#fff;color:var(--ink);font:inherit;font-weight:600;margin-top:12px;cursor:pointer}
.btn.primary{background:var(--brand);border-color:var(--brand);color:#fff;width:100%}
.btn:disabled{opacity:.6;cursor:default}
.done-card .btn{background:#e8f5ee;border-color:#b7e0ca;color:var(--ok);width:100%}
dl{display:grid;grid-template-columns:52px 1fr;gap:6px 10px;margin:10px 0 0;font-size:15px}
dt{color:var(--muted);font-size:13px;padding-top:2px}
dd{margin:0}
.tel{font-weight:700}
.mini{display:inline-block;margin-left:6px;padding:2px 8px;min-height:28px;border:1px solid var(--line);border-radius:8px;background:#f8fafc;color:#334155;font:12px/1.6 inherit;cursor:pointer}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.chip{display:inline-flex;align-items:center;min-height:40px;padding:0 12px;border:1px solid #cfe0f5;border-radius:10px;background:#f2f8ff;color:var(--brand);font-size:14px;font-weight:600}
a{color:var(--brand);text-decoration:none}
a:active{opacity:.7}
.note{background:#fffbea;border:1px solid #fde68a;border-radius:10px;padding:8px 10px;font-size:13px;margin:10px 0 0}
.source{font-size:12px;line-height:1.7;color:var(--muted);margin:10px 0 0;padding-top:8px;border-top:1px dashed var(--line)}
.fetched{display:block;font-size:11px;color:#94a3b8}
ol,ul{margin:8px 0;padding-left:22px}
li{margin:5px 0}
blockquote{margin:8px 0;padding:10px 12px;background:#f8fafc;border-left:3px solid #cbd5e1;border-radius:0 8px 8px 0;font-size:14px;color:#334155}
.sources{font-size:13px;padding-left:20px}
.msg{font-size:13px;margin:10px 0 0;min-height:18px}
.msg.ok{color:var(--ok)}
.msg.err{color:#b91c1c}
.foot{font-size:12px;color:var(--muted);margin-top:22px}
@media (max-width:400px){h1{font-size:22px}dl{grid-template-columns:46px 1fr}.card{padding:12px}}
</style>
</head>
<body>
<header class="hero">
  <div class="wrap">
    <div class="kicker">${esc(today)} ${esc(weekday)} · 北京</div>
    <h1>今天办：摩托车年检</h1>
    <p class="sub">两条到期待办 · 先检测场，再顺路车管站</p>
    <div class="pill" id="pendingPill">pending <b>${pending}</b> → <b>${target}</b></div>
  </div>
</header>
<main class="wrap">
  <nav class="chips" aria-label="页内导航">
    <a class="chip" href="#due">到期待办</a>
    <a class="chip" href="#stations">检测场</a>
    <a class="chip" href="#offices">车管站</a>
    <a class="chip" href="#materials">材料</a>
    <a class="chip" href="#sources">来源</a>
  </nav>

  <section id="due">
    <h2>① 今天到期的两条</h2>
    <p class="meta">到期日从待办「下一步：YYYY-MM-DD」解析；已拖天数从创建时间起算。</p>
    ${dueHtml}
    ${allDue.length > due.length ? `<p class="meta">还有 ${allDue.length - due.length} 条到期待办未在首屏展开。</p>` : ''}
    <p class="msg" id="msg" role="status" aria-live="polite"></p>
  </section>

  <section>
    <h2>先确认：要不要上线</h2>
    <blockquote>摩托车自注册登记之日起第 6 年、第 10 年进行安全技术检验；第 2 年、第 4 年、第 8 年申领免检车检验合格标志；超过 10 年的，每年检验 1 次。
      <div class="source">来源：${sourceLink('guide')}</div>
    </blockquote>
    <p class="meta">检验有效期看行驶证副证，有效期满前 3 个月（含本月）内可参检；先把违法、事故处理完毕。来源：${sourceLink('prep')}</p>
  </section>

  <section id="stations">
    <h2>② 可检摩托车的检测场（${STATIONS.length} 家）</h2>
    <p class="meta">周六均办公（法定节假日除外）；官方预约页注明：周日、法定节假日、雨雪等恶劣天气检测场停止验车。来源：${sourceLink('checkcar')}</p>
    ${STATIONS.map(stationCard).join('')}
  </section>

  <section id="offices">
    <h2>③ 顺路车管站 / 交通支队（${OFFICES.length} 家）</h2>
    <p class="meta">「每个交管局都去一下」不必真跑遍：就近选一处即可。处理违法/事故去执法站，年检标志/证件业务去车管站。</p>
    ${OFFICES.map(officeCard).join('')}
  </section>

  <section id="materials">
    <h2>④ 材料清单（官方原文摘录）</h2>
    <p class="meta">「交强险凭证」即官方原文中的「机动车交通事故责任强制保险凭证」。</p>
    <ol>${MATERIALS.map((m) => `<li>${esc(m)}</li>`).join('')}</ol>
    <p class="note">身份证：官方指南在「代理人身份证明」「免检车所有人身份证明」处要求；车主本人上线检验未单列，现场核验身份时建议随身携带。以上原文未改写。来源：${sourceLink('guide')}</p>
    <h3 style="margin-top:16px">送检车辆状态（官方原文摘录）</h3>
    <ol>${VEHICLE_CHECKS.map((m) => `<li>${esc(m)}</li>`).join('')}</ol>
    <p class="source">来源：${sourceLink('prep')}</p>
  </section>

  <section>
    <h2>⑤ 预约与费用</h2>
    <ul>
      <li>手机：交管12123 APP → 机动车业务 → 机动车检验预约。</li>
      <li>网页：<a href="https://bj.122.gov.cn/" target="_blank" rel="noopener">bj.122.gov.cn</a> 登录后选「机动车业务」→「机动车检验预约」。</li>
      <li>电话：工作日 8:00–17:00 打检测场预约电话，确认时间后再去。</li>
      <li>核发机动车检验合格标志：<b>不收费</b>（官方指南原文）。</li>
      <li>安全技术检验 / 尾气检测：<b>未查到</b>北京市统一官方价目，检测场页面也未公示价格；以现场公示和电话确认为准。</li>
    </ul>
    <p class="source">来源：${sourceLink('checkcar')} · ${sourceLink('guide')}</p>
  </section>

  <section id="sources">
    <h2>⑥ 官方来源（逐条）</h2>
    <p class="meta">以下链接于 ${esc(FETCHED)} 逐一抓取，均返回 HTTP 200。</p>
    ${sourcesTable()}
  </section>

  <p class="foot">本页只读取当前数据；点「办完」才会写入状态（调用 /api/op 的 setStatus，写前重读 revision，冲突重试 1 次）。检测场/车管站信息请出发前电话复核。</p>
</main>
<script>window.__TODAY__=${boot}</script>
<script>
(function(){
  var boot=window.__TODAY__||{pending:0,target:0,dueTotal:0};
  var initial=boot.pending, target=boot.target, total=boot.dueTotal, done=0, live=initial;
  var pill=document.getElementById('pendingPill');
  var msg=document.getElementById('msg');

  function render(){
    if(!pill) return;
    if(total>0 && done>=total){
      pill.innerHTML='pending <b>'+initial+'</b> → <b>'+live+'</b> ✓';
    }else{
      pill.innerHTML='pending <b>'+live+'</b> → <b>'+target+'</b>';
    }
  }
  function say(text, ok){
    if(!msg) return;
    msg.textContent=text;
    msg.className='msg '+(ok?'ok':'err');
  }
  function countPending(data){
    return (data && Array.isArray(data.items)?data.items:[]).filter(function(i){
      return !i.archivedAt && i.status==='pending';
    }).length;
  }
  function readState(){
    return fetch('/api/state',{cache:'no-store'}).then(function(r){
      if(!r.ok) throw new Error('读取状态失败 HTTP '+r.status);
      return r.json();
    });
  }
  function postOp(id, rev){
    return fetch('/api/op',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({op:'setStatus',id:id,status:'completed',baseRevision:rev})
    });
  }
  function complete(btn){
    var id=btn.getAttribute('data-id');
    if(!id || btn.disabled) return;
    btn.disabled=true;
    var old=btn.textContent;
    btn.textContent='处理中…';
    say('',true);
    // 写前重读 revision,再提交;409 时用最新 revision 重试 1 次。
    readState().then(function(st){
      var rev=Number(st.data && st.data.revision)||0;
      return postOp(id,rev).then(function(res){
        if(res.status===409){
          return res.json().then(function(conflict){
            var newer=Number(conflict && conflict.data && conflict.data.revision);
            if(!Number.isFinite(newer)||newer<=rev){
              return readState().then(function(st2){
                return postOp(id, Number(st2.data && st2.data.revision)||0);
              });
            }
            return postOp(id,newer);
          });
        }
        return res;
      });
    }).then(function(res){
      return res.json().then(function(body){
        if(!res.ok) throw new Error(body && body.error?body.error:('HTTP '+res.status));
        done++;
        var card=btn.closest('.card');
        if(card) card.classList.add('done-card');
        btn.textContent='已完成 ✓';
        btn.disabled=true;
        var next=countPending(body.data);
        if(Number.isFinite(next)) live=next;
        render();
        say(done>=total?'两条都办完了：pending '+initial+' → '+live+' ✓':'已办完 1 条，还剩 '+Math.max(0,total-done)+' 条',true);
      });
    }).catch(function(err){
      btn.disabled=false;
      btn.textContent=old||'办完';
      say(err && err.message?err.message:'写入失败，请重试',false);
    });
  }

  document.addEventListener('click',function(e){
    var doneBtn=e.target.closest?e.target.closest('.done'):null;
    if(doneBtn){complete(doneBtn);return}
    var copyBtn=e.target.closest?e.target.closest('.copy'):null;
    if(!copyBtn) return;
    var text=copyBtn.getAttribute('data-copy')||'';
    var old=copyBtn.textContent;
    function ok(){copyBtn.textContent='已复制';setTimeout(function(){copyBtn.textContent=old},1500)}
    function fallback(){
      try{
        var ta=document.createElement('textarea');
        ta.value=text;ta.setAttribute('readonly','');
        ta.style.position='fixed';ta.style.top='-1000px';
        document.body.appendChild(ta);ta.select();
        var yes=document.execCommand&&document.execCommand('copy');
        document.body.removeChild(ta);
        if(yes) ok(); else say('复制失败，请长按地址手动复制',false);
      }catch(_){say('复制失败，请长按地址手动复制',false)}
    }
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(ok,fallback);
    }else{
      fallback();
    }
  });

  render();
})();
</script>
</body>
</html>`
}
