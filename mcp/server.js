#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  STATUS,
  PRIORITY,
  resolveFile,
  read,
  update,
  findItem,
  newId,
  nextOrder,
  formatItems,
  normalizeItem,
} from "./lib/store.js";

const FILE = resolveFile();

const server = new McpServer({
  name: "opentodo",
  version: "0.1.0",
});

function ok(text) {
  return { content: [{ type: "text", text }] };
}

function fail(message) {
  return { content: [{ type: "text", text: `error: ${message}` }], isError: true };
}

function run(fn) {
  try {
    return fn();
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

function normList(value) {
  if (value === undefined || value === null || value === "") return null;
  const s = String(value).trim();
  return s === "" || s === "收件箱" ? null : s;
}

server.registerTool(
  "list",
  {
    title: "List todos",
    description:
      `Read the user's personal Opentodo backlog (shared JSON at ${FILE}). ` +
      "Use this before adding/updating so you reuse existing ids. " +
      "Archived items are hidden unless include_archived=true. " +
      "`list` scopes to one project (useful in a session with a current project); " +
      "empty or omitted returns all projects. " +
      "Returns one line per item with its id, priority, list, project and content.",
    inputSchema: {
      status: z.enum(STATUS).optional().describe("Only return items with this status"),
      list: z.string().optional().describe("Only items in this project/list (null=inbox is not matched here)"),
      project: z.string().optional().describe("Only return items in this project/group/category"),
      include_completed: z
        .boolean()
        .optional()
        .describe("Include completed/cancelled items (default true)"),
      include_archived: z
        .boolean()
        .optional()
        .describe("Include archived items (default false)"),
    },
  },
  ({ status, list, project, include_completed = true, include_archived = false }) =>
    run(() => {
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
      return ok(formatItems(items));
    }),
);

server.registerTool(
  "add",
  {
    title: "Add todo",
    description: `Add a new item to the user's Opentodo backlog (${FILE}). Returns the new item id. Use the current session's project as list unless the user targets another one.`,
    inputSchema: {
      content: z.string().min(1).describe("The task text"),
      priority: z.enum(PRIORITY).optional().describe("Default: medium"),
      list: z.string().optional().describe("Project/list name, e.g. 'work' or 'blog' (default: inbox)"),
      project: z.string().optional().describe("Group/category within the list, e.g. 'ai lighting' or 'blog/vlog'"),
    },
  },
  ({ content, priority, list, project }) =>
    run(() => {
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
      return ok(`added ${result.id}: ${result.content}\n\n${formatItems(data.items)}`);
    }),
);

server.registerTool(
  "update",
  {
    title: "Update todo",
    description:
      "Update an existing item by id (content, status, priority, project, list, order, archived). " +
      "Setting status to completed stamps completedAt; leaving completed clears it. " +
      "Set archived=true to move it into the archive (keep snapshots without deleting), " +
      "archived=false to restore it. Moving `list` moves it across projects.",
    inputSchema: {
      id: z.string().describe("Item id from opentodo_list"),
      content: z.string().optional(),
      status: z.enum(STATUS).optional(),
      priority: z.enum(PRIORITY).optional(),
      list: z.string().nullable().optional().describe("Move to another project; null moves to inbox"),
      project: z.string().nullable().optional(),
      order: z.number().optional(),
      archived: z.boolean().optional().describe("Archive (true) or restore (false) the item"),
    },
  },
  ({ id, content, status, priority, list, project, order, archived }) =>
    run(() => {
      const { data, result } = update((d) => {
        const item = findItem(d, id);
        if (!item) throw new Error(`no item with id ${id}`);
        if (content !== undefined) item.content = content;
        if (priority !== undefined) item.priority = priority;
        if (project !== undefined) item.project = project === "" ? null : project;
        if (list !== undefined) {
          item.list = normList(list);
          // 移动到目标项目时同步注册，避免出现 UI 看不到的"隐形项目"。
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
      return ok(`updated ${result.id}: [${result.status}]${result.archivedAt ? " (archived)" : ""} ${result.content}`);
    }),
);

server.registerTool(
  "restore",
  {
    title: "Restore from archive",
    description: "Bring an archived item back (clears archivedAt). Alias for update archived=false.",
    inputSchema: { id: z.string().describe("Item id from opentodo_list with include_archived=true") },
  },
  ({ id }) =>
    run(() => {
      const { data, result } = update((d) => {
        const item = findItem(d, id);
        if (!item) throw new Error(`no item with id ${id}`);
        item.archivedAt = null;
        item.updatedAt = new Date().toISOString();
        return item;
      }, FILE);
      return ok(`restored ${result.id}: ${result.content}`);
    }),
);

server.registerTool(
  "remove",
  {
    title: "Remove todo",
    description:
      "Permanently delete an item by id. Unarchived items are deleted for good (no recycle path). " +
      "For completed tasks that may matter later prefer update archived=true instead.",
    inputSchema: { id: z.string().describe("Item id from opentodo_list") },
  },
  ({ id }) =>
    run(() => {
      const { data, result } = update((d) => {
        const idx = d.items.findIndex((it) => it.id === id);
        if (idx === -1) throw new Error(`no item with id ${id}`);
        const [removed] = d.items.splice(idx, 1);
        return removed;
      }, FILE);
      return ok(`removed ${result.id}: ${result.content}\n\n${formatItems(data.items)}`);
    }),
);

server.registerTool(
  "clear",
  {
    title: "Clear todos",
    description:
      "Clean up items. scope='completed' moves completed items into the archive (default, safe — " +
      "nothing is lost); scope='archived' permanently empties the archive; scope='all' deletes all " +
      "non-archived items. Optionally restrict to a single project via `list`.",
    inputSchema: {
      scope: z.enum(["completed", "archived", "all"]).optional().describe("Default: completed"),
      list: z.string().optional().describe("Only act on items in this project/list"),
    },
  },
  ({ scope = "completed", list }) =>
    run(() => {
      const { data, result } = update((d) => {
        const now = new Date().toISOString();
        const inScope = (it) => (list ? it.list === list : true);
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
      return ok(`done (${result} item(s) affected)\n\n${formatItems(data.items)}`);
    }),
);

server.registerTool(
  "create_project",
  {
    title: "Create project",
    description:
      "Create a named project (independent todolist). Projects show in the app's project menu; " +
      "items reference them via their `list` field. " +
      "Prefer this over inventing list names ad-hoc on `add`/`update`.",
    inputSchema: {
      name: z.string().min(1).describe("Project name, e.g. 'travel' or 'work'"),
    },
  },
  ({ name }) =>
    run(() => {
      const trimmed = String(name || "").trim();
      if (!trimmed) throw new Error("project name empty");
      if (trimmed === "收件箱") throw new Error("收件箱 is the default inbox, not a project");
      const { data } = update((d) => {
        if (!d.lists.includes(trimmed)) d.lists.push(trimmed);
        return trimmed;
      }, FILE);
      const exists = data.lists.includes(trimmed);
      return ok(exists ? `project (created): ${trimmed}` : `project (exists): ${trimmed}\n\nprojects: ${data.lists.map((p) => `"${p}"`).join(", ") || "(inbox only)"}`);
    }),
);

server.registerTool(
  "rename_project",
  {
    title: "Rename project",
    description: "Rename a project; all its items move to the new name.",
    inputSchema: {
      oldName: z.string().describe("Current project name"),
      newName: z.string().describe("New project name"),
    },
  },
  ({ oldName, newName }) =>
    run(() => {
      const oldN = String(oldName || "").trim();
      const newN = String(newName || "").trim();
      if (!oldN || !newN) throw new Error("project names empty");
      if (oldN === newN) throw new Error("oldName and newName are the same");
      if (newN === "收件箱") throw new Error("收件箱 is the default inbox, not a project");
      const { data } = update((d) => {
        if (!d.lists.includes(oldN)) throw new Error(`no project "${oldN}"`);
        if (d.lists.includes(newN)) throw new Error(`project exists: ${newN}`);
        d.lists = d.lists.map((p) => (p === oldN ? newN : p));
        for (const it of d.items) if (it.list === oldN) it.list = newN;
        return newN;
      }, FILE);
      return ok(`renamed ${oldN} -> ${newN}`);
    }),
);

server.registerTool(
  "remove_project",
  {
    title: "Remove project",
    description:
      "Delete a project from the registry. Its items are NOT deleted: they move safely to the inbox.",
    inputSchema: { name: z.string().describe("Project name to remove") },
  },
  ({ name }) =>
    run(() => {
      const trimmed = String(name || "").trim();
      if (!trimmed) throw new Error("project name empty");
      const { data, result } = update((d) => {
        const idx = d.lists.indexOf(trimmed);
        if (idx === -1) throw new Error(`no project "${trimmed}"`);
        d.lists.splice(idx, 1);
        let moved = 0;
        for (const it of d.items) if (it.list === trimmed) { it.list = null; moved += 1; }
        return moved;
      }, FILE);
      return ok(`removed project "${trimmed}", ${result} item(s) moved to inbox`);
    }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
