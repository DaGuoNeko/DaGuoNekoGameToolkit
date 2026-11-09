const fieldNames = { Command: "命令内容", CustomName: "自定义名称", identifier: "实体标识", name: "名称", title: "标题", subtitle: "副标题", count: "目标数量", Count: "物品数量", Slot: "槽位", Name: "物品标识", Items: "容器物品", ChestItems: "容器物品", Inventory: "背包物品", Pos: "位置", commands: "命令序列", cmd: "命令", delay_ticks: "延迟（脚本刻）", target: "任务目标", brief: "前置任务", nextquest: "后续任务", parent_uid: "所属分组", child_uid: "子任务", owner_quest_uid: "所属任务", events: "事件配置", text: "文本", dialog_list: "对话绑定", dialog_data: "对话绑定", stacmd: "开始交互指令", encmd: "结束交互指令", progress_scope: "进度范围", _type_: "类型", params: "目标参数", auto: "自动执行", TickDelay: "执行延迟", conditionalMode: "条件模式", TrackOutput: "记录输出", LastOutput: "上次输出", health: "生命值", DimensionId: "维度", PlayerLevel: "玩家等级", PlayerLevelProgress: "等级进度" };
const pointer = key => String(key).replace(/~/g, "~0").replace(/\//g, "~1");
function fieldLabel(path) {
  return path.split("/").filter(Boolean).map(part => { const key = part.replace(/~1/g, "/").replace(/~0/g, "~"); return fieldNames[key] || key; }).join(" / ") || "对象内容";
}
function preview(value, max = 600) {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "未记录";
  return text.length > max ? text.slice(0, max) + "…" : text;
}
function describeObject(object, includeSections = true) {
  const value = object.value || {}, sections = [];
  const description = object.kind === "command" ? preview(value.Command, 140) : object.kind === "library" ? `${Array.isArray(value.commands) ? value.commands.length : 0} 条命令` : object.kind === "extra" ? `${Object.keys(value || {}).length} 个字段 · 网易可选数据` : preview(value.subtitle || value.identifier || object.rule || "", 140);
  if (!includeSections) return { description };
  const fields = (title, data, base = "", keys = Object.keys(data || {})) => {
    if (!data || typeof data !== "object") return;
    const selected = keys.filter(key => Object.hasOwn(data, key));
    if (selected.length) sections.push({ title, total: selected.length, rows: selected.slice(0, 30).map(key => ({ label: fieldNames[key] || key, value: preview(data[key]), field: base + "/" + pointer(key) })) });
  };
  if (object.kind === "command") fields("命令与执行设置", value, "", ["Command", "auto", "TickDelay", "conditionalMode", "TrackOutput", "LastOutput"]);
  else if (object.kind === "npc") {
    fields("实体信息", value, "", ["CustomName", "identifier", "UniqueID", "Pos"]);
    fields("对话与身份", value.scriptData?.NPC_IDENTITY, "/scriptData/NPC_IDENTITY");
    fields("交互指令", value.scriptData?.NPC_IDENTITY?.inte_data, "/scriptData/NPC_IDENTITY/inte_data", ["stacmd", "encmd"]);
  } else if (["quest", "questGroup", "objective"].includes(object.kind)) {
    fields("任务概况", value, "", ["title", "name", "subtitle", "_type_", "count", "progress_scope", "parent_uid", "owner_quest_uid"]);
    fields("目标与流程", value, "", ["text", "brief", "target", "nextquest", "child_uid", "params", "events"]);
  } else if (object.kind === "library") {
    const commands = Array.isArray(value.commands) ? value.commands : [];
    sections.push({ title: "命令序列", total: commands.length, rows: commands.slice(0, 60).map((command, i) => ({ label: String(i + 1).padStart(2, "0"), value: preview(typeof command === "string" ? command : command?.cmd), note: typeof command === "object" ? `延迟 ${preview(command?.delay_ticks ?? 0)} 脚本刻` : "", field: "/commands/" + i })) });
  } else if (object.kind === "dialogue") fields("对话内容与选项", value.data || value, value.data ? "/data" : "");
  else if (object.kind === "template") fields("模板配置", value.config || value, value.config ? "/config" : "");
  else if (["container", "player"].includes(object.kind)) {
    fields("已保存状态", value, "", ["CustomName", "PlayerLevel", "PlayerLevelProgress", "Pos", "DimensionId"]);
    for (const key of ["Items", "ChestItems", "Inventory", "EnderChestInventory"]) if (Array.isArray(value[key])) {
      const items = value[key];
      sections.push({ title: fieldNames[key] || key, total: items.length, rows: items.slice(0, 60).map((item, i) => ({ label: `槽位 ${item.Slot ?? i}`, value: `${preview(item.Name || item.id || "未记录标识")} × ${preview(item.Count ?? item.count ?? "未记录")}`, field: "/" + key + "/" + i })) });
    }
  } else fields(object.kind === "attributes" ? "已保存属性（非最终运行值）" : object.kind === "progress" ? "已保存任务进度" : "内容概览", value);
  return { description, sections };
}
module.exports = { describeObject, fieldLabel };
