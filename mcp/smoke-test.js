import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "opentodo-")), "todos.json");

const transport = new StdioClientTransport({
  command: "node",
  args: [path.join(import.meta.dirname, "server.js")],
  env: { ...process.env, OPENTODO_FILE: tmpFile },
});

const client = new Client({ name: "smoke", version: "0.1.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));
assert.equal(tools.tools.length, 9);

const text = (r) => r.content.map((c) => c.text).join("\n");

const add1 = text(await client.callTool({ name: "add", arguments: { content: "完成 ai lighting 项目", priority: "high", project: "ai lighting", list: "work" } }));
const id1 = add1.match(/added (\w+)/)[1];
const add2 = text(await client.callTool({ name: "add", arguments: { content: "blog 实现 token usage", project: "blog/机器人", list: "work" } }));
const id2 = add2.match(/added (\w+)/)[1];
console.log("\nafter add:\n" + text(await client.callTool({ name: "list", arguments: { include_archived: true } })));

let data = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
assert.equal(data.version, 2, "schema v2");
assert.deepEqual(data.lists, ["work"], "list registered in lists");

const listWork = text(await client.callTool({ name: "list", arguments: { list: "work" } }));
assert.ok(listWork.includes(id1) && listWork.includes(id2), "list param filters by project");

const upd = text(await client.callTool({ name: "update", arguments: { id: id1, status: "completed" } }));
assert.match(upd, /\[completed\]/);

const arch = text(await client.callTool({ name: "update", arguments: { id: id1, archived: true } }));
assert.match(arch, /\(archived\)/);

let list = text(await client.callTool({ name: "list", arguments: {} }));
assert.ok(!list.includes(id1) && list.includes(id2), "archived hidden by default");

list = text(await client.callTool({ name: "list", arguments: { include_archived: true } }));
assert.ok(list.includes(id1), "archived visible with include_archived");

const restored = text(await client.callTool({ name: "restore", arguments: { id: id1 } }));
assert.match(restored, /restored/);

// clear default archives completed (safe, nothing lost) instead of deleting
const cleared = text(await client.callTool({ name: "clear", arguments: {} }));
assert.match(cleared, /done \(1 item\(s\) affected\)/);
list = text(await client.callTool({ name: "list", arguments: {} }));
assert.ok(!list.includes(id1) && list.includes(id2), "clear archived the completed item");

// clear scope archived permanently empties the archive
const purgeArch = text(await client.callTool({ name: "clear", arguments: { scope: "archived" } }));
assert.match(purgeArch, /done \(1 item\(s\) affected\)/);

const removed = text(await client.callTool({ name: "remove", arguments: { id: id2 } }));
assert.match(removed, /removed/);

// Project tools: create / rename / remove, inbox normalization, auto-registry
const createdProject = text(await client.callTool({ name: "create_project", arguments: { name: "blog" } }));
assert.match(createdProject, /project \(created\): blog/);
data = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
assert.ok(data.lists.includes("blog"), "create_project writes to lists registry");

const add3 = text(await client.callTool({ name: "add", arguments: { content: "blog item", list: "blog" } }));
const id3 = add3.match(/added (\w+)/)[1];

const intoInbox = text(await client.callTool({ name: "update", arguments: { id: id3, list: "收件箱" } }));
data = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
assert.strictEqual(data.items.find((i) => i.id === id3).list, null, "update list=收件箱 normalizes to inbox");

list = text(await client.callTool({ name: "list", arguments: { list: "收件箱" } }));
assert.ok(list.includes(id3), "list param 收件箱 filters to inbox");

const autoReg = text(await client.callTool({ name: "update", arguments: { id: id3, list: "隐项目" } }));
data = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
assert.ok(data.lists.includes("隐项目"), "update auto-registers a brand-new list");
assert.strictEqual(data.items.find((i) => i.id === id3).list, "隐项目");

const renamed = text(await client.callTool({ name: "rename_project", arguments: { oldName: "隐项目", newName: "显项目" } }));
assert.match(renamed, /renamed 隐项目 -> 显项目/);
data = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
assert.ok(data.lists.includes("显项目") && !data.lists.includes("隐项目"), "rename_project updates registry");
assert.strictEqual(data.items.find((i) => i.id === id3).list, "显项目", "rename_project moves items");

list = text(await client.callTool({ name: "list", arguments: { list: "显项目" } }));
assert.ok(list.includes(id3), "list param uses renamed project");

const removedProj = text(await client.callTool({ name: "remove_project", arguments: { name: "显项目" } }));
assert.match(removedProj, /removed project "显项目", 1 item\(s\) moved to inbox/);
data = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
assert.ok(!data.lists.includes("显项目"), "remove_project clears registry");
assert.strictEqual(data.items.find((i) => i.id === id3).list, null, "remove_project moves items to inbox");

const removed3 = text(await client.callTool({ name: "remove", arguments: { id: id3 } }));
assert.match(removed3, /removed/);

const finalData = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
assert.equal(finalData.items.length, 0);
assert.ok(finalData.revision >= 14, "revision incremented per write");
console.log("\nfinal file:\n" + JSON.stringify(finalData, null, 2));
console.log("\nSMOKE TEST PASSED");

await client.close();
fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });