// Opentodo — opencode V2 plugin
//
// Loaded only inside the Opentodo app's own `opencode serve` (the app keeps an
// isolated location + config dir and copies this plugin into
// `<location>/.opencode/plugins/opentodo/index.js`, where opencode discovers it).
// It does two things:
//
//   1. Registers the `opentodo_*` tools the assistant uses to read/write the
//      shared backlog JSON. Running inside opencode means no separate Node
//      process is needed — the plugin runs in opencode's own runtime.
//   2. Injects a compact backlog summary + the current project into the system
//      prompt (session "context" hook), so the assistant knows the list exists
//      and which project new todos belong to.
//
// Data file: ~/.config/opentodo/todos.json (OPENTODO_FILE overrides).
// Current project pointer: ~/.config/opentodo/.active (written by the app).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Plugin } from "@opencode/plugin";

// ---------------------------------------------------------------------------
// Data layer (inlined so the plugin is a single self-contained file; mirrors
// mcp/lib/store.js). Shares the same JSON contract, mkdir lock and atomic
// rename so it coexists with the app and any other client.
// ---------------------------------------------------------------------------

const STATUS = ["pending", "in_progress", "completed", "cancelled"];
const PRIORITY = ["high", "medium", "low"];
const DEFAULT_FILE = path.join(os.homedir(), ".config", "opentodo", "todos.json");

function nowIso() {
  return new Date().toISOString();
}

function emptyData() {
  return {
    version: 3,
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

function resolveFile() {
  return process.env.OPENTODO_FILE || DEFAULT_FILE;
}

function newId() {
  return crypto.randomBytes(4).toString("hex");
}

function normalizeItem(raw = {}) {
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

function normalizeData(raw = {}) {
  const tombstones = normalizeTombstones(raw.tombstones);
  const listTombstones = normalizeListTombstones(raw.listTombstones);
  const listRenames = normalizeRenames(raw.listRenames);
  const renameSteps = [...listRenames].sort((a, b) => stamp(a.at) - stamp(b.at));
  const applyRename = (name) => {
    let current = name;
    for (const r of renameSteps) {
      if (r.from === current) current = r.to;
    }
    return current;
  };
  const deletedItems = new Set(tombstones.map((t) => t.id));
  const deletedLists = new Set(listTombstones.map((t) => t.name));

  const items = [];
  if (Array.isArray(raw.items)) {
    for (const rawItem of raw.items) {
      const item = normalizeItem(rawItem);
      item.list = applyRename(item.list);
      if (deletedItems.has(item.id) || deletedLists.has(item.list)) continue;
      items.push(item);
    }
  }

  let lists = Array.isArray(raw.lists)
    ? [...new Set(raw.lists.map((l) => applyRename(String(l))).filter(Boolean))]
    : [];
  lists = lists.filter((name) => !deletedLists.has(name));

  const seen = new Set(lists);
  // 与 app 一致：注册表为空时预置默认项目「收件箱」。
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
    version: 3,
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

function addItemTombstone(data, id, deletedAt = nowIso()) {
  if (!id) return;
  if (!Array.isArray(data.tombstones)) data.tombstones = [];
  const prev = data.tombstones.find((t) => t.id === id);
  if (!prev) data.tombstones.push({ id, deletedAt });
  else if (stamp(deletedAt) > stamp(prev.deletedAt)) prev.deletedAt = deletedAt;
}

function addListTombstone(data, name, deletedAt = nowIso()) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return;
  if (!Array.isArray(data.listTombstones)) data.listTombstones = [];
  const prev = data.listTombstones.find((t) => t.name === trimmed);
  if (!prev) data.listTombstones.push({ name: trimmed, deletedAt });
  else if (stamp(deletedAt) > stamp(prev.deletedAt)) prev.deletedAt = deletedAt;
  data.listsUpdatedAt = deletedAt;
}

function removeListTombstone(data, name) {
  if (!Array.isArray(data.listTombstones)) return;
  data.listTombstones = data.listTombstones.filter((t) => t.name !== name);
}

function recordListRename(data, from, to, at = nowIso()) {
  if (!from || !to || from === to) return;
  if (!Array.isArray(data.listRenames)) data.listRenames = [];
  data.listRenames = data.listRenames.filter((r) => r.from !== from);
  data.listRenames.push({ from, to, at });
  data.listsUpdatedAt = at;
}

function ensureList(data, name) {
  if (!name) return;
  const revived = (data.listTombstones || []).some((t) => t.name === name);
  removeListTombstone(data, name);
  if (!data.lists.includes(name)) data.lists.push(name);
  if (revived) data.listRenames = (data.listRenames || []).filter((r) => r.from !== name && r.to !== name);
}

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function acquireLock(file, { retries = 200, delayMs = 25, staleMs = 10000 } = {}) {
  const dir = `${file}.lock`;
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

function read(file = resolveFile()) {
  try {
    const text = fs.readFileSync(file, "utf8");
    if (!text.trim()) return emptyData();
    return normalizeData(JSON.parse(text));
  } catch (e) {
    if (e.code === "ENOENT") return emptyData();
    throw new Error(`opentodo: failed to read ${file}: ${e.message}`);
  }
}

function update(fn, file = resolveFile()) {
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

function findItem(data, id) {
  return data.items.find((it) => it.id === id) || null;
}

function nextOrder(data, project, list) {
  const same = data.items.filter((it) => it.project === project && it.list === list);
  return same.reduce((max, it) => Math.max(max, it.order), 0) + 1;
}

const STATUS_MARK = { pending: " ", in_progress: "~", completed: "x", cancelled: "-" };

function formatItems(items) {
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

// ---------------------------------------------------------------------------

const FILE = resolveFile();
const MAX_ITEMS = 20;

function readActive() {
  if (process.env.OPENTODO_ACTIVE) return process.env.OPENTODO_ACTIVE || null;
  const activeFile =
    process.env.OPENTODO_ACTIVE_FILE || path.join(path.dirname(FILE), ".active");
  try {
    const text = fs.readFileSync(activeFile, "utf8").trim();
    return text || null;
  } catch {
    return null;
  }
}

function normList(value) {
  if (value === undefined || value === null || value === "") return "收件箱";
  const s = String(value).trim();
  return s === "" ? "收件箱" : s;
}

function guard(fn) {
  try {
    return fn();
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function render() {
  const all = read(FILE).items;
  const active = readActive();
  const items = (active ? all.filter((it) => it.list === active) : all).filter(
    (it) => it.status !== "completed" && it.status !== "cancelled" && !it.archivedAt,
  );

  const groups = [...new Set(items.map((it) => it.project).filter(Boolean))];

  const lines = [
    "## Personal backlog (Opentodo)",
    `The user keeps a personal todo backlog at ${FILE}.`,
    `Current project: ${active ? `"${active}"` : `"收件箱" (default)`}. ` +
      "When you use the opentodo_* tools, pass list=<current project> unless the user explicitly " +
      "mentions another project or asks for everything.",
    "Use the `opentodo_*` tools to read or change it (opentodo_list / opentodo_add / opentodo_update / opentodo_restore / opentodo_remove / opentodo_clear / opentodo_create_project / opentodo_rename_project / opentodo_remove_project).",
    "The user's message is usually backlog CONTENT to record, NOT an instruction for you to perform — you cannot execute it; only record it as todo(s). Split a multi-item message (numbered / multiple lines / semicolons) into separate items and drop the numbering/bullets.",
    "Only change existing items when the user clearly uses an action verb (complete / remove / archive / restore / edit / clear / list); otherwise always opentodo_add.",
    "Deciding which list (project) an item goes to: look at the SUBJECT of the user's message (usually the leading word).",
    "  · If the subject is a domain/project name (e.g. 装修 / 汽车保养 / 健身 / 读书 / 旅行): if it ALREADY EXISTS as a project → use that project (pass list); if it does NOT exist as any project and is not just a sub-topic of the current project → CREATE A NEW PROJECT (call opentodo_create_project first, then add the item(s) with list=<new project>).",
    "  · If the subject is only a time/action/object/one-off (e.g. 下午三点开会 / 买牛奶 / 回邮件) → keep it in the CURRENT project.",
    "  · If you are UNSURE whether it's a new project or a group of the current project → ASK the user one short question first; do not guess.",
    "Otherwise default list = current project. Give every new item a short `project` group (reuse an existing one when it fits) so nothing lands in 未分组. Do not modify existing items.",
    groups.length
      ? `Existing groups in this project (reuse when fitting): ${groups.map((g) => `"${g}"`).join(", ")}.`
      : "No groups yet in this project.",
    "The current project and its items are already shown below — do NOT call opentodo_list just to look.",
    "To create a new project, call opentodo_create_project first, then pass its name as `list` on add/update. Moving items to a new list auto-registers the project.",
    "Archived items stay safe in the archive; to tidy completed tasks use opentodo_clear (default scope archives them).",
    `Current: ${items.length} active item(s) in current project.`,
  ];
  for (const it of items.slice(0, MAX_ITEMS)) {
    const proj = it.project ? ` [${it.project}]` : "";
    const mark = it.status === "in_progress" ? "~" : " ";
    lines.push(`- [${mark}] ${it.id} (${it.priority})${proj} ${it.content}`);
  }
  if (items.length > MAX_ITEMS) lines.push(`- … and ${items.length - MAX_ITEMS} more`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// V2 tool definitions (JSON Schema input; execute returns structured content).
// ---------------------------------------------------------------------------

const S = {
  string: (extra = {}) => ({ type: "string", ...extra }),
  nullableString: (extra = {}) => ({ anyOf: [{ type: "string" }, { type: "null" }], ...extra }),
  boolean: (extra = {}) => ({ type: "boolean", ...extra }),
  number: (extra = {}) => ({ type: "number", ...extra }),
  enum: (values, extra = {}) => ({ type: "string", enum: values, ...extra }),
};

/** Build an object schema with `additionalProperties: false`. */
function obj(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

const TOOLS = [
  {
    name: "opentodo_list",
    description:
      `Read the user's personal Opentodo backlog (shared JSON at ${FILE}). ` +
      "Use this before adding/updating so you reuse existing ids. " +
      "Archived items are hidden unless include_archived=true. " +
      "`list` scopes to one project; empty or omitted returns all projects. " +
      "Returns one line per item with its id, priority, list, project and content.",
    input: obj({
      status: S.enum(STATUS, { description: "Only return items with this status" }),
      list: S.string({ description: "Only items in this project/list, e.g. 'work' or '博客'" }),
      project: S.string({ description: "Only return items in this project/group/category" }),
      include_completed: S.boolean({ description: "Include completed/cancelled items (default true)" }),
      include_archived: S.boolean({ description: "Include archived items (default false)" }),
    }),
    async execute(a) {
      const { status, list, project, include_completed = true, include_archived = false } = a ?? {};
      return guard(() => {
        const data = read(FILE);
        let items = data.items;
        if (status) items = items.filter((it) => it.status === status);
        if (list !== undefined) {
          const target = normList(list);
          items = items.filter((it) => it.list === target);
        }
        if (project) items = items.filter((it) => it.project === project);
        if (!include_archived) items = items.filter((it) => !it.archivedAt);
        if (!include_completed) {
          items = items.filter((it) => it.status !== "completed" && it.status !== "cancelled");
        }
        items = [...items].sort(
          (a, b) =>
            (a.list ?? "").localeCompare(b.list ?? "") ||
            (a.project ?? "").localeCompare(b.project ?? "") ||
            a.order - b.order,
        );
        return formatItems(items);
      });
    },
  },
  {
    name: "opentodo_add",
    description:
      `Add a new item to the user's Opentodo backlog (${FILE}). Returns the new item id. ` +
      "Use the current session's project as list unless the user targets another one.",
    input: obj(
      {
        content: S.string({ minLength: 1, description: "The task text" }),
        priority: S.enum(PRIORITY, { description: "Default: medium" }),
        list: S.string({ description: "Project/list name, e.g. 'work' or 'blog' (default: 收件箱)" }),
        project: S.string({ description: "Group/category within the list, e.g. 'ai lighting' or 'blog/vlog'" }),
      },
      ["content"],
    ),
    async execute({ content, priority, list, project }) {
      return guard(() => {
        const { data, result } = update((d) => {
          const item = normalizeItem({
            id: newId(),
            content,
            priority: priority ?? "medium",
            list: normList(list),
            project: project ?? null,
            order: nextOrder(d, project ?? null, normList(list)),
          });
          d.items.push(item);
          ensureList(d, item.list);
          return item;
        }, FILE);
        return `added ${result.id}: ${result.content}\n\n${formatItems(data.items)}`;
      });
    },
  },
  {
    name: "opentodo_update",
    description:
      "Update an existing item by id (content, status, priority, project, list, order, archived). " +
      "Setting status to completed stamps completedAt; leaving completed clears it. " +
      "Set archived=true to move it into the archive, archived=false to restore it. " +
      "Moving `list` moves it across projects.",
    input: obj(
      {
        id: S.string({ description: "Item id from opentodo_list" }),
        content: S.string(),
        status: S.enum(STATUS),
        priority: S.enum(PRIORITY),
        list: S.nullableString({ description: "Move to another project; null moves to 收件箱" }),
        project: S.nullableString(),
        order: S.number(),
        archived: S.boolean({ description: "Archive (true) or restore (false) the item" }),
      },
      ["id"],
    ),
    async execute({ id, content, status, priority, list, project, order, archived }) {
      return guard(() => {
        const { result } = update((d) => {
          const item = findItem(d, id);
          if (!item) throw new Error(`no item with id ${id}`);
          if (content !== undefined) item.content = content;
          if (priority !== undefined) item.priority = priority;
          if (project !== undefined) item.project = project === "" ? null : project;
          if (list !== undefined) {
            item.list = normList(list);
            ensureList(d, item.list);
          }
          if (order !== undefined) item.order = order;
          if (archived !== undefined) {
            item.archivedAt = archived ? new Date().toISOString() : null;
          }
          if (status !== undefined) {
            item.status = status;
            item.completedAt = status === "completed" ? new Date().toISOString() : null;
          }
          item.updatedAt = new Date().toISOString();
          return item;
        }, FILE);
        return `updated ${result.id}: [${result.status}]${result.archivedAt ? " (archived)" : ""} ${result.content}`;
      });
    },
  },
  {
    name: "opentodo_restore",
    description: "Bring an archived item back (clears archivedAt). Alias for update archived=false.",
    input: obj({ id: S.string({ description: "Item id from opentodo_list with include_archived=true" }) }, ["id"]),
    async execute({ id }) {
      return guard(() => {
        const { result } = update((d) => {
          const item = findItem(d, id);
          if (!item) throw new Error(`no item with id ${id}`);
          item.archivedAt = null;
          item.updatedAt = new Date().toISOString();
          return item;
        }, FILE);
        return `restored ${result.id}: ${result.content}`;
      });
    },
  },
  {
    name: "opentodo_remove",
    description:
      "Permanently delete an item by id. Unarchived items are deleted for good (no recycle path). " +
      "For completed tasks that may matter later prefer update archived=true instead.",
    input: obj({ id: S.string({ description: "Item id from opentodo_list" }) }, ["id"]),
    async execute({ id }) {
      return guard(() => {
        const { data, result } = update((d) => {
          const idx = d.items.findIndex((it) => it.id === id);
          if (idx === -1) throw new Error(`no item with id ${id}`);
          addItemTombstone(d, id);
          const [removed] = d.items.splice(idx, 1);
          return removed;
        }, FILE);
        return `removed ${result.id}: ${result.content}\n\n${formatItems(data.items)}`;
      });
    },
  },
  {
    name: "opentodo_clear",
    description:
      "Clean up items. scope='completed' moves completed items into the archive (default, safe — " +
      "nothing is lost); scope='archived' permanently empties the archive; scope='all' deletes all " +
      "non-archived items. Optionally restrict to a single project via `list`.",
    input: obj({
      scope: S.enum(["completed", "archived", "all"], { description: "Default: completed" }),
      list: S.string({ description: "Only act on items in this project/list" }),
    }),
    async execute({ scope = "completed", list }) {
      return guard(() => {
        const { data, result } = update((d) => {
          const now = new Date().toISOString();
          const target = list !== undefined ? normList(list) : undefined;
          const inScope = (it) => (target === undefined ? true : it.list === target);
          if (scope === "completed") {
            let n = 0;
            for (const it of d.items) {
              if (it.status === "completed" && !it.archivedAt && inScope(it)) {
                it.archivedAt = now;
                it.updatedAt = now;
                n += 1;
              }
            }
            return n;
          }
          const before = d.items.filter(inScope).length;
          d.items = d.items.filter((it) => {
            if (!inScope(it)) return true;
            const keep = scope === "archived" ? !it.archivedAt : !!it.archivedAt;
            if (!keep) addItemTombstone(d, it.id);
            return keep; // 'all': keep archive, drop everything else
          });
          return before - d.items.filter(inScope).length;
        }, FILE);
        return `done (${result} item(s) affected)\n\n${formatItems(data.items)}`;
      });
    },
  },
  {
    name: "opentodo_create_project",
    description:
      "Create a named project (independent todolist). Projects show in the app's project menu; " +
      "items reference them via their `list` field. Prefer this over inventing list names on add/update.",
    input: obj({ name: S.string({ minLength: 1, description: "Project name, e.g. 'travel' or 'work'" }) }, ["name"]),
    async execute({ name }) {
      return guard(() => {
        const trimmed = String(name || "").trim();
        if (!trimmed) throw new Error("project name empty");
        const { data } = update((d) => {
          ensureList(d, trimmed);
          d.listsUpdatedAt = nowIso();
          return trimmed;
        }, FILE);
        return `project (created): ${trimmed}\n\nprojects: ${data.lists.map((p) => `"${p}"`).join(", ") || "(none)"}`;
      });
    },
  },
  {
    name: "opentodo_rename_project",
    description: "Rename a project; all its items move to the new name.",
    input: obj(
      {
        oldName: S.string({ description: "Current project name" }),
        newName: S.string({ description: "New project name" }),
      },
      ["oldName", "newName"],
    ),
    async execute({ oldName, newName }) {
      return guard(() => {
        const oldN = String(oldName || "").trim();
        const newN = String(newName || "").trim();
        if (!oldN || !newN) throw new Error("project names empty");
        if (oldN === newN) throw new Error("oldName and newName are the same");
        update((d) => {
          if (!d.lists.includes(oldN)) throw new Error(`no project "${oldN}"`);
          if (d.lists.includes(newN)) throw new Error(`project exists: ${newN}`);
          const at = nowIso();
          d.lists = d.lists.map((p) => (p === oldN ? newN : p));
          for (const it of d.items) {
            if (it.list === oldN) {
              it.list = newN;
              it.updatedAt = at;
            }
          }
          recordListRename(d, oldN, newN, at);
          addListTombstone(d, oldN, at);
          removeListTombstone(d, newN);
          return newN;
        }, FILE);
        return `renamed ${oldN} -> ${newN}`;
      });
    },
  },
  {
    name: "opentodo_remove_project",
    description:
      "Delete a project AND all of its items (including archived) — irreversible. Requires explicit user confirmation.",
    input: obj({ name: S.string({ description: "Project name to remove" }) }, ["name"]),
    async execute({ name }) {
      return guard(() => {
        const trimmed = String(name || "").trim();
        if (!trimmed) throw new Error("project name empty");
        const { result } = update((d) => {
          const idx = d.lists.indexOf(trimmed);
          if (idx === -1) throw new Error(`no project "${trimmed}"`);
          d.lists.splice(idx, 1);
          const before = d.items.length;
          for (const it of d.items) {
            if (it.list === trimmed) addItemTombstone(d, it.id);
          }
          d.items = d.items.filter((it) => it.list !== trimmed);
          d.listRenames = (d.listRenames || []).filter((r) => r.from !== trimmed && r.to !== trimmed);
          addListTombstone(d, trimmed);
          return before - d.items.length;
        }, FILE);
        return `removed project "${trimmed}", ${result} item(s) deleted`;
      });
    },
  },
];

export default Plugin.define({
  id: "opentodo",
  async setup(ctx) {
    // 注入 backlog 摘要 + 当前项目到每次模型请求的 system 段。
    await ctx.session.hook("context", (event) => {
      const text = render();
      if (text) event.system.push({ type: "text", text });
    });

    // 注册 opentodo_* 工具(JSON Schema 输入,execute 返回结构化 content)。
    await ctx.tool.transform((editor) => {
      for (const t of TOOLS) {
        editor.add({
          name: t.name,
          description: t.description,
          input: t.input,
          async execute(input) {
            return { content: await t.execute(input) };
          },
        });
      }
    });
  },
});
