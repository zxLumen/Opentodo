import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const STATUS = ["pending", "in_progress", "completed", "cancelled"];
export const PRIORITY = ["high", "medium", "low"];
export const CURRENT_VERSION = 3;

const DEFAULT_FILE = path.join(os.homedir(), ".config", "opentodo", "todos.json");

export function resolveFile() {
  return process.env.OPENTODO_FILE || DEFAULT_FILE;
}

export function newId() {
  return crypto.randomBytes(4).toString("hex");
}

export function nowIso() {
  return new Date().toISOString();
}

function emptyData() {
  return {
    version: CURRENT_VERSION,
    revision: 0,
    updatedAt: nowIso(),
    items: [],
    lists: ["收件箱"],
    tombstones: [],
    listTombstones: [],
    listRenames: [],
    listsUpdatedAt: nowIso(),
  };
}

export function normalizeItem(raw = {}) {
  const now = nowIso();
  const status = STATUS.includes(raw.status) ? raw.status : "pending";
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : newId(),
    content: String(raw.content ?? "").trim(),
    status,
    priority: PRIORITY.includes(raw.priority) ? raw.priority : "medium",
    project: raw.project == null || raw.project === "" ? null : String(raw.project),
    list: raw.list == null || raw.list === "" ? "收件箱" : String(raw.list),
    archivedAt: raw.archivedAt || null,
    order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : 0,
    createdAt: raw.createdAt || now,
    updatedAt: raw.updatedAt || now,
    completedAt: status === "completed" ? raw.completedAt || now : null,
  };
}

/** 墓碑时间戳;无效值统一回落到 epoch,保证比较稳定。 */
function stamp(value) {
  const t = Date.parse(String(value ?? ""));
  return Number.isFinite(t) ? t : 0;
}

function normalizeTombstones(raw) {
  const map = new Map();
  if (Array.isArray(raw)) {
    for (const t of raw) {
      const id = typeof t?.id === "string" ? t.id : "";
      if (!id) continue;
      const deletedAt = String(t.deletedAt || "");
      const prev = map.get(id);
      if (!prev || stamp(deletedAt) > stamp(prev.deletedAt)) map.set(id, { id, deletedAt });
    }
  }
  return [...map.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function normalizeListTombstones(raw) {
  const map = new Map();
  if (Array.isArray(raw)) {
    for (const t of raw) {
      const name = typeof t?.name === "string" ? t.name.trim() : "";
      if (!name) continue;
      const deletedAt = String(t.deletedAt || "");
      const prev = map.get(name);
      if (!prev || stamp(deletedAt) > stamp(prev.deletedAt)) map.set(name, { name, deletedAt });
    }
  }
  return [...map.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** 按时间顺序应用改名(支持 a→b→c,也支持 b→a 改回来)。 */
export function makeRenameResolver(renames) {
  const sorted = [...(renames || [])].sort((a, b) => stamp(a.at) - stamp(b.at));
  return (name) => {
    let current = name;
    for (const r of sorted) {
      if (r.from === current) current = r.to;
    }
    return current;
  };
}

function normalizeRenames(raw) {
  const map = new Map();
  if (Array.isArray(raw)) {
    for (const r of raw) {
      const from = typeof r?.from === "string" ? r.from.trim() : "";
      const to = typeof r?.to === "string" ? r.to.trim() : "";
      if (!from || !to || from === to) continue;
      const at = String(r.at || "");
      const prev = map.get(from);
      if (!prev || stamp(at) > stamp(prev.at)) map.set(from, { from, to, at });
    }
  }
  return [...map.values()].sort((a, b) => stamp(a.at) - stamp(b.at));
}

/**
 * v3 规范化:
 *   - 项目改名记录按时间顺序作用到清单与条目
 *   - 条目墓碑、项目墓碑生效(删除永远赢)
 *   - `list` 为空的旧条目归入「收件箱」
 *   - 条目里出现、但不在注册表里的项目自动登记
 */
export function normalizeData(raw = {}) {
  const tombstones = normalizeTombstones(raw.tombstones);
  const listTombstones = normalizeListTombstones(raw.listTombstones);
  const listRenames = normalizeRenames(raw.listRenames);

  const applyRename = makeRenameResolver(listRenames);

  const deletedItems = new Set(tombstones.map((t) => t.id));
  const deletedLists = new Set(listTombstones.map((t) => t.name));

  const items = [];
  if (Array.isArray(raw.items)) {
    for (const rawItem of raw.items) {
      const item = normalizeItem(rawItem);
      item.list = applyRename(item.list);
      if (deletedItems.has(item.id)) continue;
      if (deletedLists.has(item.list)) continue;
      items.push(item);
    }
  }

  let lists = Array.isArray(raw.lists)
    ? [...new Set(raw.lists.map((l) => applyRename(String(l))).filter(Boolean))]
    : [];
  lists = lists.filter((name) => !deletedLists.has(name));

  const seen = new Set(lists);
  if (lists.length === 0) {
    lists.push("收件箱");
    seen.add("收件箱");
  }
  for (const it of items) {
    if (it.list && !seen.has(it.list)) {
      seen.add(it.list);
      lists.push(it.list);
    }
  }

  return {
    version: CURRENT_VERSION,
    revision: Number.isFinite(Number(raw.revision)) ? Number(raw.revision) : 0,
    updatedAt: raw.updatedAt || nowIso(),
    items,
    lists,
    tombstones,
    listTombstones,
    listRenames,
    listsUpdatedAt: raw.listsUpdatedAt || "",
  };
}

// ---------------------------------------------------------------------------
// 墓碑 / 改名记录的小工具(ops 表与客户端共用)
// ---------------------------------------------------------------------------

export function addItemTombstone(data, id, deletedAt = nowIso()) {
  if (!id) return;
  if (!Array.isArray(data.tombstones)) data.tombstones = [];
  const prev = data.tombstones.find((t) => t.id === id);
  if (!prev) data.tombstones.push({ id, deletedAt });
  else if (stamp(deletedAt) > stamp(prev.deletedAt)) prev.deletedAt = deletedAt;
}

export function addListTombstone(data, name, deletedAt = nowIso()) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return;
  if (!Array.isArray(data.listTombstones)) data.listTombstones = [];
  const prev = data.listTombstones.find((t) => t.name === trimmed);
  if (!prev) data.listTombstones.push({ name: trimmed, deletedAt });
  else if (stamp(deletedAt) > stamp(prev.deletedAt)) prev.deletedAt = deletedAt;
  data.listsUpdatedAt = deletedAt;
}

export function removeListTombstone(data, name) {
  if (!Array.isArray(data.listTombstones)) return;
  data.listTombstones = data.listTombstones.filter((t) => t.name !== name);
}

export function recordListRename(data, from, to, at = nowIso()) {
  if (!from || !to || from === to) return;
  if (!Array.isArray(data.listRenames)) data.listRenames = [];
  // 同一个旧名只保留最新一条;链条由 normalizeData 按时间顺序展开。
  data.listRenames = data.listRenames.filter((r) => r.from !== from);
  data.listRenames.push({ from, to, at });
  data.listsUpdatedAt = at;
}

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function lockDir(file) {
  return `${file}.lock`;
}

function acquireLock(file, { retries = 200, delayMs = 25, staleMs = 10000 } = {}) {
  const dir = lockDir(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let i = 0; i < retries; i++) {
    try {
      fs.mkdirSync(dir);
      try {
        fs.writeFileSync(path.join(dir, "owner"), `${process.pid}\n${Date.now()}\n`);
      } catch {}
      return () => {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
      };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        const st = fs.statSync(dir);
        if (Date.now() - st.mtimeMs > staleMs) {
          fs.rmSync(dir, { recursive: true, force: true });
          continue;
        }
      } catch {}
      sleepSync(delayMs);
    }
  }
  throw new Error(`opentodo: failed to acquire lock at ${dir}`);
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  // Windows: rename over an existing file can transiently fail with EPERM/EBUSY
  // when another client (app / plugin / antivirus) still has it open.
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      const retry = ["EPERM", "EACCES", "EBUSY"].includes(e.code) && i < 20;
      if (!retry) throw e;
      sleepSync(25);
    }
  }
}

function backup(file) {
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  } catch {}
}

export function read(file = resolveFile()) {
  try {
    const text = fs.readFileSync(file, "utf8");
    if (!text.trim()) return emptyData();
    return normalizeData(JSON.parse(text));
  } catch (e) {
    if (e.code === "ENOENT") return emptyData();
    throw new Error(`opentodo: failed to read ${file}: ${e.message}`);
  }
}

/** 内容签名:忽略 revision / updatedAt 等元数据,只比实际数据。 */
export function contentSignature(data) {
  const items = [...(data.items || [])]
    .map((it) => JSON.stringify(it))
    .sort();
  return JSON.stringify({
    items,
    lists: data.lists || [],
    tombstones: [...(data.tombstones || [])].sort((a, b) => (a.id < b.id ? -1 : 1)),
    listTombstones: [...(data.listTombstones || [])].sort((a, b) => (a.name < b.name ? -1 : 1)),
    listRenames: [...(data.listRenames || [])].sort((a, b) => {
      if (a.from !== b.from) return a.from < b.from ? -1 : 1;
      return stamp(a.at) - stamp(b.at);
    }),
  });
}

/**
 * 串行读-改-写。
 * `options.onlyIfChanged`: 内容没变就不落盘、也不递增 revision(sync 用)。
 * `options.revision`: 指定写入后的 revision(可选)。
 */
export function update(fn, file = resolveFile(), options = {}) {
  const release = acquireLock(file);
  try {
    const data = read(file);
    const before = options.onlyIfChanged ? contentSignature(data) : "";
    const result = fn(data);
    const changed = !options.onlyIfChanged || contentSignature(data) !== before;
    if (!changed) return { data, result, changed: false };
    data.revision += 1;
    data.updatedAt = nowIso();
    backup(file);
    atomicWrite(file, data);
    return { data, result, changed: true };
  } finally {
    release();
  }
}

export function findItem(data, id) {
  return data.items.find((it) => it.id === id) || null;
}

export function nextOrder(data, project, list) {
  const same = data.items.filter((it) => it.project === project && it.list === list);
  return same.reduce((max, it) => Math.max(max, it.order), 0) + 1;
}

const STATUS_MARK = { pending: " ", in_progress: "~", completed: "x", cancelled: "-" };

export function formatItems(items) {
  if (!items.length) return "(empty)";
  const lines = items.map((it) => {
    const mark = STATUS_MARK[it.status] ?? " ";
    const list = it.list ? `@${it.list} ` : "";
    const proj = it.project ? ` [${it.project}]` : "";
    const arch = it.archivedAt ? " (archived)" : "";
    return `- [${mark}] ${it.id}  (${it.priority})${proj} ${list}${it.content}${arch}`;
  });
  const done = items.filter((it) => it.status === "completed").length;
  return `${items.length} item(s), ${done} completed\n${lines.join("\n")}`;
}
