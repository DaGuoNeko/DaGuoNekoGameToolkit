const { enabled } = require("./world-data-capabilities.cjs");
const { describeObject, fieldLabel } = require("./world-data-presentation.cjs");
const labels = { command: "命令方块", blockEntity: "方块实体", container: "容器", entity: "实体", npc: "NPC", world: "世界数据", player: "玩家数据", structure: "结构", extra: "ExtraData", quest: "任务", questGroup: "任务分组", objective: "任务目标", dialogue: "对话", template: "NPC 模板", library: "指令库", progress: "任务进度", item: "物品", attributes: "RPG 属性" };
const kindOrder = ["command", "npc", "quest", "questGroup", "objective", "dialogue", "template", "library", "container", "player", "progress", "attributes", "entity", "item", "blockEntity", "structure", "world", "extra"];
const pointer = key => String(key).replace(/~/g, "~0").replace(/\//g, "~1");
function walk(value, callback, path = "", depth = 0) {
  if (depth > 48) return;
  if (callback(value, path) === false) return;
  if (value && typeof value === "object" && !value.$binary)
    for (const [key, item] of Object.entries(value)) walk(item, callback, path + "/" + pointer(key), depth + 1);
}
function businessObjects(record, capabilities = {}) {
  const root = record.value.scriptData;
  if (!root || typeof root !== "object" || root.$binary) return [];
  const objects = [];
  const add = (kind, key, value, field, rule, aliases = []) => objects.push({
    id: record.id + ":" + kind + field, identity: kind + ":" + key, kind, name: typeof value?.name === "string" ? value.name : typeof value?.title === "string" ? value.title : key,
    value, position: record.position, dimension: record.dimension,
    evidence: { ...record.evidence, field }, rule, aliases, types: Object.fromEntries(Object.entries(record.types || {}).filter(([path]) => path === field || path.startsWith(field + "/")).map(([path, type]) => [path.slice(field.length), type])),
  });
  for (const [key, value] of Object.entries(root)) {
    const base = "/scriptData/" + pointer(key);
    add("extra", record.identity + ":" + key, value, base, "网易 ExtraData 根键");
    objects.at(-1).name = key;
    if (key === "Quest_Engine_Player_Data" && enabled(capabilities, "quest")) { add("progress", record.identity + ":" + key, value, base, "Quest Engine 已保存进度"); objects.at(-1).name = "任务进度 · " + (record.name || record.identity); }
    if (["Attr_Main_Data", "Attr_Data", "Attr_PlayerInfo"].includes(key) && enabled(capabilities, "attributes")) { add("attributes", record.identity + ":" + key, value, base, "自定义属性已保存数据（非运行时最终属性）"); objects.at(-1).name = key; }
    if (key === "Quest_Engine_Data" && enabled(capabilities, "quest")) {
      for (const [id, data] of Object.entries(value?.quest_item?.allitem || {}))
        if (["quest", "group"].includes(data?._type_)) add(data._type_ === "quest" ? "quest" : "questGroup", id, data, base + "/quest_item/allitem/" + pointer(id), "Quest Engine quest_item/allitem");
      for (const [id, data] of Object.entries(value?.quest_item?.allobjitem || {})) add("objective", id, data, base + "/quest_item/allobjitem/" + pointer(id), "Quest Engine quest_item/allobjitem");
    }
    if (key === "CUSTOMNPC_TEMPLATE_LIBRARY_V3" && enabled(capabilities, "npc") && value?.schema_version === 3)
      for (const [id, data] of Object.entries(value.items || {})) add("template", id, data, base + "/items/" + pointer(id), "Custom NPC V3");
    if (key === "CUSTOMNPC_DIALOGUE_LIBRARY_V3" && enabled(capabilities, "npc") && value?.schema_version === 3)
      for (const [category, group] of Object.entries(value.items || {}))
        for (const [id, data] of Object.entries(group.items || {})) add("dialogue", id, data, base + "/items/" + pointer(category) + "/items/" + pointer(id), "Custom NPC V3",
          group.legacy_type_id != null && data.legacy_dialogue_id != null ? ["dialogueLegacy:" + JSON.stringify([group.legacy_type_id, data.legacy_dialogue_id])] : []);
    if (key === "DAGUOMIAO_API_MOD_data_v1" && enabled(capabilities, "library") && value?.command_library?.schema_version === 2)
      for (const [id, data] of Object.entries(value.command_library.data || {})) add("library", id, data, base + "/command_library/data/" + pointer(id), "Miao Command Library V2");
  }
  return objects;
}
function references(objects, capabilities = null) {
  const index = new Map(), result = [];
  for (const object of objects) {
    for (const key of [object.identity, ...(object.aliases || [])]) { const ids = index.get(key) || []; ids.push(object.id); index.set(key, ids); }
  }
  for (const object of objects) {
    // 根数据与业务投影只分析一次，避免同一引用在结果中重复出现。
    if (["extra", "progress"].includes(object.kind)) continue;
    walk(object.value, (value, field) => {
      if (object.kind === "world" && field === "/scriptData") return false;
      const add = (kind, key, rule) => {
        const dependency = { library: "library", quest: "quest", questGroup: "quest", objective: "quest", dialogue: "npc", dialogueLegacy: "npc", template: "npc" }[kind];
        if (capabilities && dependency && !enabled(capabilities, dependency)) return;
        if (typeof key !== "string" || !key.trim() || result.length >= 20000) return;
        const targets = index.get(kind + ":" + key) || [];
        result.push({ from: object.id, to: targets.length === 1 ? targets[0] : null, target: kind + ":" + key,
          status: targets.length === 1 ? "resolved" : targets.length > 1 ? "ambiguous" : "not-found", field, rule, evidence: object.evidence });
      };
      if (field.endsWith("/NPC_IDENTITY") && value && typeof value === "object") {
        const list = Object.hasOwn(value, "dialog_list") ? value.dialog_list : [value.dialog_data];
        for (const ref of Array.isArray(list) ? list : []) {
          if (Array.isArray(ref) && ref.length >= 2) add("dialogueLegacy", JSON.stringify(ref.slice(0, 2)), "NPC 旧对话二元引用");
          else if (typeof ref === "string") add("dialogue", ref, "NPC 稳定对话 ID");
          else if (ref && typeof ref === "object") add("dialogue", ref.dialogue_id || ref.id, "NPC 稳定对话 ID");
        }
      }
      if (typeof value !== "string") return;
      const npcCommand = /\/(stacmd|encmd)$/.test(field) && field.includes("/NPC_IDENTITY/inte_data/");
      if (npcCommand && !value.startsWith("cmd.")) add("library", value, "NPC 交互指令库字段");
      if (field.endsWith("/dialogue_id")) add("dialogue", value, "Custom NPC 稳定对话 ID 字段");
      if (field.endsWith("/quest_uid") || field.endsWith("/owner_quest_uid")) add("quest", value, "Quest Engine 任务 ID 字段");
      if (["quest", "questGroup"].includes(object.kind) && (field === "/parent_uid" || /^\/child_uid\/\d+$/.test(field))) {
        const kind = index.has("quest:" + value) ? "quest" : "questGroup";
        add(kind, value, "Quest Engine 分组层级");
      }
      if (object.kind === "quest" && /^\/target\/list\/\d+$/.test(field)) add("objective", value, "Quest Engine 任务目标列表");
      if (object.kind === "quest" && field === "/nextquest/uid") add("quest", value, "Quest Engine 后续任务");
      if (field.endsWith("/Name") && /\/(Items|ChestItems|Inventory)\//.test(field)) add("item", value, "容器物品标识符（资源定义未纳入扫描）");
      const commandText = value.startsWith("cmd.") ? value.slice(4) : value.trim();
      const direct = /^cmd\(([^()]+)\)$/.exec(commandText);
      const commandField = npcCommand || /\/(Command|command|cmd|commands)(\/\d+)?$/.test(field) || ["quest", "objective"].includes(object.kind) && field.includes("/events/");
      if (direct && commandField) add("library", direct[1], "完整 cmd(ID) 调用");
      const command = /^\/?miao:cmd\s+指令库\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+/.exec(commandText);
      if (command && commandField) add("library", command[1] || command[2] || command[3], "miao:cmd 指令库调用");
      if (commandField) {
        const tokens = commandText.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+/g)?.map(token => /^['"]/.test(token) ? token.slice(1, -1).replace(/\\([\\'"])/g, "$1") : token) || [];
        const verb = tokens[0]?.replace(/^\//, "");
        const slots = { "qst:hasquest": [4, 5], "qst:hasobjdone": [3, 4], "atr:hasitems": [7, 8] }[verb];
        if (verb === "qst:hasquest") add("quest", tokens[2], "qst:hasquest 任务参数");
        if (verb === "qst:hasobjdone") add("objective", tokens[2], "qst:hasobjdone 目标参数");
        if (verb === "cnpc:ycruncmd" && tokens[1] === "指令库") add("library", tokens[3], "cnpc:ycruncmd 指令库参数（需核对接管配置）");
        for (const slot of slots || []) {
          const callback = tokens[slot]; if (!callback) continue;
          if (callback.startsWith("cmd.")) {
            const nested = /^cmd\.\/?miao:cmd\s+指令库\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+/.exec(callback);
            if (nested) add("library", nested[1] || nested[2] || nested[3], verb + " 显式指令回调");
          } else add("library", callback, verb + " 指令库回调（需核对接管配置）");
        }
      }
      if (!direct && /cmd\([^)]*[+{}]|\$\{|eval\(/.test(value) && result.length < 20000)
        result.push({ from: object.id, to: null, target: "动态表达式", status: "unknown", field, rule: "无法静态判断", evidence: object.evidence });
    });
  }
  return result;
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function compareWorldData(left, right) {
  const group = rows => { const map = new Map(); for (const row of rows) { const list = map.get(row.identity) || []; list.push(row); map.set(row.identity, list); } return map; };
  const a = group(left.objects), b = group(right.objects), changes = [];
  let truncated = false, resultBytes = 0;
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    if (changes.length >= 5000 || resultBytes >= 8 * 1024 * 1024) { truncated = true; break; }
    const before = a.get(key) || [], after = b.get(key) || [];
    if (before.length > 1 || after.length > 1) { changes.push({ identity: key, status: "ambiguous", fields: [], name: (after[0] || before[0]).name }); continue; }
    const row = after[0] || before[0];
    const partial = !left.complete || !right.complete || left.scope !== right.scope || JSON.stringify(left.capabilities) !== JSON.stringify(right.capabilities);
    if (!before.length || !after.length) { changes.push({ identity: key, name: row.name, kind: row.kind, status: partial ? before.length ? "not-observed-right" : "not-observed-left" : before.length ? "removed" : "added", fields: [], before: before[0]?.evidence, after: after[0]?.evidence }); continue; }
    const fields = [];
    function diff(x, y, path = "") {
      if (fields.length >= 200) return;
      if (JSON.stringify(stable(x)) === JSON.stringify(stable(y))) return;
      if (/\/(Items|ChestItems|Inventory|EnderChestInventory)$/.test(path) && Array.isArray(x) && Array.isArray(y)) {
        const slots = rows => rows.every(row => Number.isInteger(row?.Slot)) && new Set(rows.map(row => row.Slot)).size === rows.length;
        if (slots(x) && slots(y)) { diff(Object.fromEntries(x.map(row => [row.Slot, row])), Object.fromEntries(y.map(row => [row.Slot, row])), path); return; }
      }
      if (x && y && typeof x === "object" && typeof y === "object" && Array.isArray(x) === Array.isArray(y))
        for (const name of new Set([...Object.keys(x), ...Object.keys(y)])) diff(x[name], y[name], path + "/" + pointer(name));
      else {
        const preview = value => {
          const text = JSON.stringify(value);
          return text?.length > 8192 ? { $preview: text.slice(0, 8192), characters: text.length, truncated: true } : value;
        };
        fields.push({ path, label: fieldLabel(path), before: preview(x), after: preview(y) });
      }
    }
    diff(before[0].value, after[0].value);
    diff(before[0].types, after[0].types, "/@types");
    if (fields.length) {
      const change = { identity: key, name: row.name, kind: row.kind, status: "changed", fields, fieldsTruncated: fields.length >= 200, before: before[0].evidence, after: after[0].evidence };
      resultBytes += JSON.stringify(change).length; changes.push(change);
    }
  }
  return { left: left.source, right: right.source, leftScope: left.scope, rightScope: right.scope, changes, truncated, partial: !left.complete || !right.complete || left.scope !== right.scope || JSON.stringify(left.capabilities) !== JSON.stringify(right.capabilities) };
}
function exportWorldData(result, format, kind = "") {
  if (format === "json") return JSON.stringify(result, null, 2) + "\n";
  if (format === "svg") {
    const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
    const rows = result.relations.slice(0, 200), index = new Map(result.objects.map(o => [o.id, o.name]));
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${80 + rows.length * 60}" viewBox="0 0 1000 ${80 + rows.length * 60}"><rect width="100%" height="100%" fill="#fff"/><g font-family="sans-serif" font-size="13" fill="#202733"><text x="20" y="25">已保存数据关系 · ${rows.length}/${result.relations.length} 条 · 虚线表示当前范围未解析</text><text x="20" y="48">${escape(result.generatedAt)} · 只读静态分析</text>${rows.map((edge, i) => `<g transform="translate(0,${70 + i * 60})"><rect x="10" width="360" height="40" rx="5" fill="#edf0f4"/><text x="20" y="25">${escape(String(index.get(edge.from) || edge.from).slice(0, 34))}</text><path d="M370 20H620" stroke="#626b78" ${edge.to ? "" : 'stroke-dasharray="5 5"'}/><rect x="620" width="370" height="40" rx="5" fill="#edf0f4"/><text x="630" y="25">${escape(edge.target.slice(0, 40))}</text></g>`).join("")}</g></svg>`;
  }
  if (format !== "csv") throw Error("不支持的导出格式");
  const cell = value => { let s = String(value ?? ""); if (/^\s*[=+\-@]|^[\t\r\n]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const rows = [["类型", "名称", "身份", "维度", "X", "Y", "Z", "来源键", "字段", "数据"]];
  for (const row of result.objects.filter(row => !kind || row.kind === kind)) rows.push([labels[row.kind], row.name, row.identity, row.dimension, ...(row.position || ["", "", ""]), row.evidence.key, row.evidence.field, JSON.stringify(row.value)]);
  return "\uFEFF" + rows.map(row => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
function queryWorldData(result, { view = "objects", kind = "", query = "", offset = 0, limit = 50, includeData = false, id = "", direction = "both", status = "", field = "" } = {}, searchIndex = null) {
  if (!["objects", "relations", "fields"].includes(view) || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100 || typeof query !== "string" || query.length > 256 || typeof id !== "string" || id.length > 4096 || typeof field !== "string" || field.length > 8192 || !["both", "incoming", "outgoing"].includes(direction) || !["", "resolved", "not-found", "ambiguous", "unknown"].includes(status)) throw Error("数据查询范围无效");
  const base = { source: result.source, generatedAt: result.generatedAt, complete: result.complete, coverage: result.coverage, offset };
  if (view === "fields") {
    const object = result.objects.find(row => row.id === id);
    if (!object) throw Error("对象不在当前快照中");
    let value = object.value;
    if (field && !field.startsWith("/")) throw Error("字段路径无效");
    for (const key of field ? field.slice(1).split("/").map(key => key.replace(/~1/g, "/").replace(/~0/g, "~")) : []) {
      if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) throw Error("字段不存在");
      value = value[key];
    }
    const entries = value && typeof value === "object" ? Object.entries(value) : [["", value]];
    const rows = entries.slice(offset, offset + limit).map(([key, child]) => {
      const childField = key === "" && (value === null || typeof value !== "object") ? field : field + "/" + pointer(key);
      const expandable = child !== null && typeof child === "object";
      const text = expandable ? `${Array.isArray(child) ? "列表" : "对象"} · ${Object.keys(child).length} 项` : String(child ?? "null");
      const absolute = (object.evidence?.field || "") + childField;
      const protectedField = /^\/(x|y|z|Pos|UniqueID|UUID|identifier|id|StorageVersion|NetworkVersion|saveLongString)(\/|$)/.test(absolute);
      const opaque = child && typeof child === "object" && ["$binary", "$extension", "$map", "$float"].some(key => Object.hasOwn(child, key));
      const editable = !!object.evidence?.revision && !protectedField && !opaque && (!!absolute.includes("/scriptData/") || absolute === "/scriptData" || !expandable || /^list<(byte|short|int|long|float|double|string)>$|^(intArray|longArray)$/.test(object.types?.[childField] || ""));
      return { key, field: childField, type: object.types?.[childField] || (Array.isArray(child) ? "array" : child === null ? "null" : typeof child), expandable, editable, preview: text.slice(0, 8192), truncated: text.length > 8192 };
    });
    if (JSON.stringify(rows).length > 1024 * 1024) throw Error("字段结果过大，请减小分页数量或导出 JSON");
    return { ...base, field, total: entries.length, rows };
  }
  const needle = query.toLowerCase();
  const names = new Map(result.objects.map(row => [row.id, row.name]));
  const rows = (view === "objects" ? result.objects : result.relations).filter((row, index) => (!kind || row.kind === kind) && (!status || row.status === status) && (!id || (view === "objects" ? row.id === id : direction === "incoming" ? row.to === id : direction === "outgoing" ? row.from === id : row.to === id || row.from === id)) && (!needle || (searchIndex?.[index] ?? JSON.stringify(row).toLowerCase()).includes(needle) || view === "relations" && `${names.get(row.from)} ${names.get(row.to)}`.toLowerCase().includes(needle)));
  if (view === "objects") rows.sort((a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind));
  const selected = rows.slice(offset, offset + limit).map(row => {
    if (view === "relations") return { ...row, fromName: names.get(row.from), toName: names.get(row.to) };
    if (includeData) return row;
    const summary = describeObject(row, !!id);
    return { id: row.id, identity: row.identity, kind: row.kind, name: row.name, position: row.position, dimension: row.dimension, rule: row.rule, evidence: row.evidence, summary: id ? summary : { description: summary.description } };
  });
  if (JSON.stringify(selected).length > 1024 * 1024) throw Error("查询结果过大，请缩小范围或关闭 includeData");
  return { ...base, total: rows.length, rows: selected };
}
function summarizeSnapshot(result) {
  return { ...result, objects: result.objects.filter(row => row.position && !row.evidence?.field).slice(0, 500).map(({ id, name, kind, position, dimension }) => ({ id, name, kind, position, dimension })), relations: undefined,
    objectCount: result.objects.length, relationCount: result.relations.length, counts: Object.fromEntries(Object.keys(labels).map(kind => [kind, result.objects.filter(row => row.kind === kind).length])) };
}
module.exports = { labels, kindOrder, businessObjects, references, compareWorldData, exportWorldData, queryWorldData, summarizeSnapshot };
