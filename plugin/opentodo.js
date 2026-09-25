// Opentodo — opencode plugin
//
// Loaded only inside the Opentodo app's own `opencode serve` (the app sets
// OPENCODE_CONFIG_DIR to a directory containing this plugin). It does two things:
//
//   1. Registers the `opentodo_*` tools the assistant uses to read/write the
//      shared backlog JSON. Running inside opencode means no separate Node
//      process is needed — the plugin runs in opencode's own runtime.
//   2. Injects a compact backlog summary + the current project into the system
//      prompt, so the assistant knows the list exists and which project new
//      todos belong to.
//
// Data file: ~/.config/opentodo/todos.json (OPENTODO_FILE overrides).
// Current project pointer: ~/.config/opentodo/.active (written by the app).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { tool } from "@opencode-ai/plugin";

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
  return { version: 2, revision: 0, updatedAt: nowIso(), items: [], lists: [] };
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

function normalizeData(raw = {}) {
  const items = Array.isArray(raw.items) ? raw.items.map(normalizeItem) : [];
  const lists = Array.isArray(raw.lists)
    ? [...new Set(raw.lists.map((l) => String(l)).filter(Boolean))]
    : [];
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
  fs.renameSync(tmp, file);
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
    "Default list = current project; use another list only if the content is strongly related to it. Give every new item a short `project` group (reuse an existing one when it fits) so nothing lands in 未分组. Do not modify existing items.",
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

const tools = {
  opentodo_list: tool({
    description:
      `Read the user's personal Opentodo backlog (shared JSON at ${FILE}). ` +
      "Use this before adding/updating so you reuse existing ids. " +
      "Archived items are hidden unless include_archived=true. " +
      "`list` scopes to one project; empty or omitted returns all projects. " +
      "Returns one line per item with its id, priority, list, project and content.",
    args: {
      status: tool.schema.enum(STATUS).optional().describe("Only return items with this status"),
      list: tool.schema.string().optional().describe("Only items in this project/list, e.g. 'work' or '博客'"),
      project: tool.schema.string().optional().describe("Only return items in this project/group/category"),
      include_completed: tool.schema.boolean().optional().describe("Include completed/cancelled items (default true)"),
      include_archived: tool.schema.boolean().optional().describe("Include archived items (default false)"),
    },
    execute: async ({ status, list, project, include_completed = true, include_archived = false }) =>
      guard(() => {
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
      }),
  }),

  opentodo_add: tool({
    description:
      `Add a new item to the user's Opentodo backlog (${FILE}). Returns the new item id. ` +
      "Use the current session's project as list unless the user targets another one.",
    args: {
      content: tool.schema.string().min(1).describe("The task text"),
      priority: tool.schema.enum(PRIORITY).optional().describe("Default: medium"),
      list: tool.schema.string().optional().describe("Project/list name, e.g. 'work' or 'blog' (default: 收件箱)"),
      project: tool.schema.string().optional().describe("Group/category within the list, e.g. 'ai lighting' or 'blog/vlog'"),
    },
    execute: async ({ content, priority, list, project }) =>
      guard(() => {
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
          if (item.list && !d.lists.includes(item.list)) d.lists.push(item.list);
          return item;
        }, FILE);
        return `added ${result.id}: ${result.content}\n\n${formatItems(data.items)}`;
      }),
  }),

  opentodo_update: tool({
    description:
      "Update an existing item by id (content, status, priority, project, list, order, archived). " +
      "Setting status to completed stamps completedAt; leaving completed clears it. " +
      "Set archived=true to move it into the archive, archived=false to restore it. " +
      "Moving `list` moves it across projects.",
    args: {
      id: tool.schema.string().describe("Item id from opentodo_list"),
      content: tool.schema.string().optional(),
      status: tool.schema.enum(STATUS).optional(),
      priority: tool.schema.enum(PRIORITY).optional(),
      list: tool.schema.string().nullable().optional().describe("Move to another project; null moves to 收件箱"),
      project: tool.schema.string().nullable().optional(),
      order: tool.schema.number().optional(),
      archived: tool.schema.boolean().optional().describe("Archive (true) or restore (false) the item"),
    },
    execute: async ({ id, content, status, priority, list, project, order, archived }) =>
      guard(() => {
        const { result } = update((d) => {
          const item = findItem(d, id);
          if (!item) throw new Error(`no item with id ${id}`);
          if (content !== undefined) item.content = content;
          if (priority !== undefined) item.priority = priority;
          if (project !== undefined) item.project = project === "" ? null : project;
          if (list !== undefined) {
            item.list = normList(list);
            if (item.list && !d.lists.includes(item.list)) d.lists.push(item.list);
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
      }),
  }),

  opentodo_restore: tool({
    description: "Bring an archived item back (clears archivedAt). Alias for update archived=false.",
    args: { id: tool.schema.string().describe("Item id from opentodo_list with include_archived=true") },
    execute: async ({ id }) =>
      guard(() => {
        const { result } = update((d) => {
          const item = findItem(d, id);
          if (!item) throw new Error(`no item with id ${id}`);
          item.archivedAt = null;
          item.updatedAt = new Date().toISOString();
          return item;
        }, FILE);
        return `restored ${result.id}: ${result.content}`;
      }),
  }),

  opentodo_remove: tool({
    description:
      "Permanently delete an item by id. Unarchived items are deleted for good (no recycle path). " +
      "For completed tasks that may matter later prefer update archived=true instead.",
    args: { id: tool.schema.string().describe("Item id from opentodo_list") },
    execute: async ({ id }) =>
      guard(() => {
        const { data, result } = update((d) => {
          const idx = d.items.findIndex((it) => it.id === id);
          if (idx === -1) throw new Error(`no item with id ${id}`);
          const [removed] = d.items.splice(idx, 1);
          return removed;
        }, FILE);
        return `removed ${result.id}: ${result.content}\n\n${formatItems(data.items)}`;
      }),
  }),

  opentodo_clear: tool({
    description:
      "Clean up items. scope='completed' moves completed items into the archive (default, safe — " +
      "nothing is lost); scope='archived' permanently empties the archive; scope='all' deletes all " +
      "non-archived items. Optionally restrict to a single project via `list`.",
    args: {
      scope: tool.schema.enum(["completed", "archived", "all"]).optional().describe("Default: completed"),
      list: tool.schema.string().optional().describe("Only act on items in this project/list"),
    },
    execute: async ({ scope = "completed", list }) =>
      guard(() => {
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
            if (scope === "archived") return !it.archivedAt;
            return !!it.archivedAt; // 'all': keep archive, drop everything else
          });
          return before - d.items.filter(inScope).length;
        }, FILE);
        return `done (${result} item(s) affected)\n\n${formatItems(data.items)}`;
      }),
  }),

  opentodo_create_project: tool({
    description:
      "Create a named project (independent todolist). Projects show in the app's project menu; " +
      "items reference them via their `list` field. Prefer this over inventing list names on add/update.",
    args: { name: tool.schema.string().min(1).describe("Project name, e.g. 'travel' or 'work'") },
    execute: async ({ name }) =>
      guard(() => {
        const trimmed = String(name || "").trim();
        if (!trimmed) throw new Error("project name empty");
        const { data } = update((d) => {
          if (!d.lists.includes(trimmed)) d.lists.push(trimmed);
          return trimmed;
        }, FILE);
        return `project (created): ${trimmed}\n\nprojects: ${data.lists.map((p) => `"${p}"`).join(", ") || "(none)"}`;
      }),
  }),

  opentodo_rename_project: tool({
    description: "Rename a project; all its items move to the new name.",
    args: {
      oldName: tool.schema.string().describe("Current project name"),
      newName: tool.schema.string().describe("New project name"),
    },
    execute: async ({ oldName, newName }) =>
      guard(() => {
        const oldN = String(oldName || "").trim();
        const newN = String(newName || "").trim();
        if (!oldN || !newN) throw new Error("project names empty");
        if (oldN === newN) throw new Error("oldName and newName are the same");
        update((d) => {
          if (!d.lists.includes(oldN)) throw new Error(`no project "${oldN}"`);
          if (d.lists.includes(newN)) throw new Error(`project exists: ${newN}`);
          d.lists = d.lists.map((p) => (p === oldN ? newN : p));
          for (const it of d.items) if (it.list === oldN) it.list = newN;
          return newN;
        }, FILE);
        return `renamed ${oldN} -> ${newN}`;
      }),
  }),

  opentodo_remove_project: tool({
    description:
      "Delete a project AND all of its items (including archived) — irreversible. Requires explicit user confirmation.",
    args: { name: tool.schema.string().describe("Project name to remove") },
    execute: async ({ name }) =>
      guard(() => {
        const trimmed = String(name || "").trim();
        if (!trimmed) throw new Error("project name empty");
        const { result } = update((d) => {
          const idx = d.lists.indexOf(trimmed);
          if (idx === -1) throw new Error(`no project "${trimmed}"`);
          d.lists.splice(idx, 1);
          const before = d.items.length;
          d.items = d.items.filter((it) => it.list !== trimmed);
          return before - d.items.length;
        }, FILE);
        return `removed project "${trimmed}", ${result} item(s) deleted`;
      }),
  }),
};

export const OpentodoPlugin = async () => {
  return {
    tool: tools,
    "experimental.chat.system.transform": async (_input, output) => {
      const text = render();
      if (text) output.system.push(text);
    },
  };
};
