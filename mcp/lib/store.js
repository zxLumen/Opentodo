import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const STATUS = ["pending", "in_progress", "completed", "cancelled"];
export const PRIORITY = ["high", "medium", "low"];

const DEFAULT_FILE = path.join(os.homedir(), ".config", "opentodo", "todos.json");

export function resolveFile() {
  return process.env.OPENTODO_FILE || DEFAULT_FILE;
}

export function newId() {
  return crypto.randomBytes(4).toString("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function emptyData() {
  return { version: 2, revision: 0, updatedAt: nowIso(), items: [], lists: [] };
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
    list:
      raw.list == null || raw.list === "" || String(raw.list).trim() === "收件箱"
        ? null
        : String(raw.list),
    archivedAt: raw.archivedAt || null,
    order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : 0,
    createdAt: raw.createdAt || now,
    updatedAt: raw.updatedAt || now,
    completedAt: status === "completed" ? raw.completedAt || now : null,
  };
}

export function normalizeData(raw = {}) {
  const items = Array.isArray(raw.items) ? raw.items.map(normalizeItem) : [];
  const lists = Array.isArray(raw.lists)
    ? [...new Set(raw.lists.map((l) => String(l)).filter(Boolean))]
    : [];
  // 自愈：条目里出现的项目若不在注册表中，合并进来，保证任何客户端读到的 lists 都完整。
  const seen = new Set(lists);
  for (const it of items) {
    if (it.list && !seen.has(it.list)) {
      seen.add(it.list);
      lists.push(it.list);
    }
  }
  return {
    version: 2,
    revision: Number.isFinite(Number(raw.revision)) ? Number(raw.revision) : 0,
    updatedAt: raw.updatedAt || nowIso(),
    items,
    lists,
  };
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
  fs.renameSync(tmp, file);
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

// Serialized read-modify-write with an exclusive cross-process lock.
// `fn(data)` may mutate `data` and/or return a result value.
export function update(fn, file = resolveFile()) {
  const release = acquireLock(file);
  try {
    const data = read(file);
    const result = fn(data);
    data.revision += 1;
    data.updatedAt = nowIso();
    backup(file);
    atomicWrite(file, data);
    return { data, result };
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
