// Opentodo 三端合并引擎(v3)。
//
// 服务端是唯一执行合并的地方:客户端把「本地完整状态」推上来,这里在文件锁里
// 做一次确定性合并,再把权威状态返回。规则:
//
//   - 条目按 id 并集;同一条目 `updatedAt` 更新的赢(时间相同服务端赢)。
//   - 删除永远赢:条目墓碑 / 项目墓碑优先于任何并发修改,不会被旧客户端复活。
//   - 项目改名通过 listRenames 传播;旧名下的并发条目会被迁到新名。
//   - 项目列表取 `listsUpdatedAt` 更新一方的顺序,再并上另一方的独有项目。
//   - 组内 order 合并后重新编号 1..n,不改 `updatedAt`(避免同步回环)。
//
// 纯函数,不碰磁盘;调用方负责加锁与写入。

import { normalizeData, nowIso, contentSignature, makeRenameResolver } from "./store.js";

function stamp(value) {
  const t = Date.parse(String(value ?? ""));
  return Number.isFinite(t) ? t : 0;
}

function newest(map, key, value, at) {
  const prev = map.get(key);
  if (!prev || stamp(at) > stamp(prev.at)) map.set(key, { ...value, at });
}

function mergeRenames(a, b) {
  const map = new Map();
  for (const r of [...(a || []), ...(b || [])]) {
    if (!r?.from || !r?.to || r.from === r.to) continue;
    newest(map, r.from, { from: r.from, to: r.to }, r.at);
  }
  return [...map.values()]
    .map(({ from, to, at }) => ({ from, to, at }))
    .sort((x, y) => stamp(x.at) - stamp(y.at));
}

function applyRenames(renames, name) {
  return makeRenameResolver(renames)(name);
}

function mergeTombstones(a, b) {
  const map = new Map();
  for (const t of [...(a || []), ...(b || [])]) {
    if (!t?.id) continue;
    const prev = map.get(t.id);
    if (!prev || stamp(t.deletedAt) > stamp(prev.deletedAt)) {
      map.set(t.id, { id: t.id, deletedAt: String(t.deletedAt || "") });
    }
  }
  return [...map.values()].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

function mergeListTombstones(a, b) {
  const map = new Map();
  for (const t of [...(a || []), ...(b || [])]) {
    if (!t?.name) continue;
    const prev = map.get(t.name);
    if (!prev || stamp(t.deletedAt) > stamp(prev.deletedAt)) {
      map.set(t.name, { name: t.name, deletedAt: String(t.deletedAt || "") });
    }
  }
  return [...map.values()];
}

function reindexOrders(items) {
  const groups = new Map();
  for (const item of items) {
    const key = `${item.list}\u0000${item.project ?? ""}`;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = []));
    group.push(item);
  }
  for (const group of groups.values()) {
    group.sort((x, y) => {
      if (x.order !== y.order) return x.order - y.order;
      const cx = String(x.createdAt ?? "");
      const cy = String(y.createdAt ?? "");
      if (cx !== cy) return cx < cy ? -1 : 1;
      return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
    });
    group.forEach((item, i) => {
      item.order = i + 1;
    });
  }
}

/**
 * 合并服务端状态与客户端推送的状态。
 * 返回值总是 v3 结构;是否真的有变化由调用方用 contentSignature 判断。
 */
export function mergeData(serverRaw, incomingRaw, { serverTime = nowIso() } = {}) {
  const server = normalizeData(serverRaw);
  const incoming = normalizeData(incomingRaw);

  // 1) 改名:合并记录,并按时间顺序作用到两边的条目/项目上。
  const listRenames = mergeRenames(server.listRenames, incoming.listRenames);
  const remap = (name) => applyRenames(listRenames, name);
  server.items.forEach((it) => (it.list = remap(it.list)));
  incoming.items.forEach((it) => (it.list = remap(it.list)));
  server.lists = [...new Set(server.lists.map(remap).filter(Boolean))];
  incoming.lists = [...new Set(incoming.lists.map(remap).filter(Boolean))];

  // 2) 项目墓碑。若另一侧在删除之后又明确重新加回了同名项目(更晚的 listsUpdatedAt),
  //    则忽略这条墓碑(用户主动重建项目优先于旧删除)。
  const rawListTombstones = mergeListTombstones(server.listTombstones, incoming.listTombstones);
  const listTombstones = rawListTombstones.filter((t) => {
    // 只有「明确记录过 listsUpdatedAt 的新客户端」才能覆盖墓碑；
    // v2 旧客户端没有该字段，绝不能因此把已删除项目复活。
    const reAddedOnServer =
      !!server.listsUpdatedAt &&
      server.lists.includes(t.name) &&
      stamp(server.listsUpdatedAt) > stamp(t.deletedAt);
    const reAddedOnClient =
      !!incoming.listsUpdatedAt &&
      incoming.lists.includes(t.name) &&
      stamp(incoming.listsUpdatedAt) > stamp(t.deletedAt);
    return !(reAddedOnServer || reAddedOnClient);
  });
  const deletedLists = new Set(listTombstones.map((t) => t.name));

  // 3) 条目墓碑(删除永远赢)。
  const tombstones = mergeTombstones(server.tombstones, incoming.tombstones);
  const deletedIds = new Set(tombstones.map((t) => t.id));

  // 4) 条目并集 + LWW。
  const byId = new Map();
  for (const item of server.items) {
    if (deletedIds.has(item.id) || deletedLists.has(item.list)) continue;
    if (!item.content) continue;
    byId.set(item.id, item);
  }
  for (const item of incoming.items) {
    if (deletedIds.has(item.id) || deletedLists.has(item.list)) continue;
    if (!item.content) continue;
    const existing = byId.get(item.id);
    if (!existing || stamp(item.updatedAt) > stamp(existing.updatedAt)) {
      byId.set(item.id, item);
    }
  }
  const items = [...byId.values()];

  // 5) 项目注册表:顺序跟随 listsUpdatedAt 更新的一方,再并上另一方的独有项目。
  const serverNewer = stamp(server.listsUpdatedAt) >= stamp(incoming.listsUpdatedAt);
  const newer = serverNewer ? server : incoming;
  const older = serverNewer ? incoming : server;
  const lists = [];
  const seen = new Set();
  for (const name of [...newer.lists, ...older.lists]) {
    const mapped = remap(name);
    if (!mapped || seen.has(mapped) || deletedLists.has(mapped)) continue;
    seen.add(mapped);
    lists.push(mapped);
  }
  if (lists.length === 0) {
    lists.push("收件箱");
    seen.add("收件箱");
  }
  for (const item of items) {
    item.list = remap(item.list) || "收件箱";
    if (deletedLists.has(item.list)) continue;
    if (!seen.has(item.list)) {
      seen.add(item.list);
      lists.push(item.list);
    }
  }

  reindexOrders(items);

  return {
    version: 3,
    revision: Number.isFinite(Number(server.revision)) ? Number(server.revision) : 0,
    updatedAt: serverTime,
    items,
    lists,
    tombstones,
    listTombstones,
    listRenames,
    listsUpdatedAt: serverNewer ? server.listsUpdatedAt : incoming.listsUpdatedAt,
  };
}

/** 合并结果是否与服务端现状不同(忽略 revision/updatedAt)。 */
export function mergeChanged(serverRaw, merged) {
  return contentSignature(normalizeData(serverRaw)) !== contentSignature(merged);
}
