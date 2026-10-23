const properties = [
  ["visible", "可见", "bool", "布局", null],
  ["position", "位置", "vec2", "布局", "runtime"],
  ["size", "大小", "vec2", "布局", "runtime"],
  ["layer", "层级", "int", "布局", "runtime"],
  ["order", "顺序", "int", "布局", "runtime"],
  ["minSize", "最小尺寸", "vec2", "布局", "runtime"],
  ["maxSize", "最大尺寸", "vec2", "布局", "runtime"],
  ["clipsChildren", "裁剪子控件", "bool", "布局", "runtime"],
  ["text", "文本", "text", "文字", "text"],
  ["editText", "输入框文本", "text", "文字", "text"],
  ["color", "文字颜色 RGBA", "vec4", "文字", "text"],
  ["shadow", "文字阴影", "bool", "文字", "text"],
  ["linePadding", "行间距", "number", "文字", "text"],
  ["scrollPosition", "滚动位置", "number", "交互", "control"],
  ["scrollPercent", "滚动百分比", "int", "交互", "control"],
  ["toggleState", "开关状态", "bool", "交互", "control"],
  ["sliderValue", "滑块值", "number", "交互", "control"],
].map(([key, label, type, group, section]) => ({
  key,
  label,
  type,
  group,
  section,
}));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function valueOf(details, property) {
  return property.section
    ? details?.properties?.[property.section]?.[property.key]
    : details?.[property.key];
}
function supports(property, value) {
  if (property.type === "bool") return typeof value === "boolean";
  if (property.type === "text") return typeof value === "string";
  if (property.type.startsWith("vec"))
    return (
      Array.isArray(value) &&
      value.length === Number(property.type.slice(3)) &&
      value.every(Number.isFinite)
    );
  return Number.isFinite(value);
}
function formatValue(property, value) {
  return property.type === "bool"
    ? value
    : Array.isArray(value)
      ? value.map(String)
      : String(value);
}
function parseValue(property, value) {
  if (property.type === "bool") {
    if (typeof value !== "boolean") throw Error("请选择开关值");
    return value;
  }
  if (property.type === "text") {
    if (
      typeof value !== "string" ||
      value.length > 65536 ||
      value.includes("\0")
    )
      throw Error("文本无效或过长");
    return value;
  }
  const numeric = (input) => {
    if (
      typeof input !== "string" ||
      !input.trim() ||
      !Number.isFinite(Number(input)) ||
      Math.abs(Number(input)) > 1e7
    )
      throw Error("请输入有效数值");
    return Number(input);
  };
  if (property.type.startsWith("vec")) {
    if (
      !Array.isArray(value) ||
      value.length !== Number(property.type.slice(3))
    )
      throw Error("数值数量不正确");
    return value.map(numeric);
  }
  const number = numeric(value);
  if (property.type === "int" && !Number.isInteger(number))
    throw Error("请输入整数");
  if (property.key === "scrollPercent" && (number < 0 || number > 100))
    throw Error("百分比范围为 0–100");
  return number;
}
function mergePage(old, incoming, append = false) {
  if (!append || !old) return { ...incoming, nodes: [...incoming.nodes] };
  const nodes = new Map(old.nodes.map((node) => [node.path, node]));
  for (const node of incoming.nodes) {
    const previous = nodes.get(node.path);
    nodes.set(node.path, {
      ...previous,
      ...node,
      childCount: node.childCount ?? previous?.childCount,
    });
  }
  return {
    ...incoming,
    offset: Math.min(old.offset, incoming.offset),
    nodes: [...nodes.values()].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)),
  };
}
function mergeReveal(pages, incoming) {
  if (!incoming.length) return pages;
  const next = { ...pages };
  for (const page of incoming) {
    const old = next[page.parentPath];
    const contiguous =
      old &&
      page.offset <= old.offset + old.nodes.length &&
      old.offset <= page.offset + page.nodes.length;
    next[page.parentPath] = mergePage(old, page, contiguous);
  }
  return next;
}
function withVisibility(pages, path, visible) {
  const parent = path.slice(0, path.lastIndexOf("/"));
  const page = pages[parent];
  if (!page) return pages;
  const index = page.nodes.findIndex((node) => node.path === path);
  if (index < 0 || page.nodes[index].visible === visible) return pages;
  const nodes = page.nodes.slice();
  nodes[index] = { ...nodes[index], visible };
  return { ...pages, [parent]: { ...page, nodes } };
}
function flattenTree(pages, expanded) {
  const result = [],
    seen = new Set();
  function visit(parent, depth) {
    if (depth > 32 || seen.has(parent)) return;
    seen.add(parent);
    const page = pages[parent];
    if (!page) return;
    if (page.offset > 0)
      result.push({
        more: true,
        before: true,
        path: parent,
        depth,
        offset: Math.max(0, page.offset - 160),
        remaining: page.offset,
      });
    for (const node of page.nodes) {
      result.push({
        ...node,
        childCount: pages[node.path]?.total ?? node.childCount,
        depth,
      });
      if (expanded.includes(node.path)) visit(node.path, depth + 1);
    }
    if (page.offset + page.nodes.length < page.total)
      result.push({
        more: true,
        path: parent,
        depth,
        offset: page.offset + page.nodes.length,
        remaining: page.total - page.offset - page.nodes.length,
      });
  }
  visit("", 0);
  return result;
}
module.exports = {
  properties,
  equal,
  valueOf,
  supports,
  formatValue,
  parseValue,
  mergePage,
  mergeReveal,
  flattenTree,
  withVisibility,
};
const typeNames = {
  Button: "按钮",
  Panel: "面板",
  Label: "文本",
  Image: "图片",
  Grid: "网格",
  StackPanel: "堆叠面板",
  ScrollView: "滚动区域",
  Toggle: "开关",
  Slider: "滑块",
  EditBox: "输入框",
  Screen: "屏幕",
  CollectionPanel: "集合面板",
  InputPanel: "输入面板",
  Custom: "自定义控件",
  Factory: "工厂",
  Dropdown: "下拉框",
};
function typeLabel(type) {
  return typeNames[type] || type;
}
const labels = {
  visible: "可见",
  size: "大小",
  position: "相对位置",
  globalPosition: "全局位置",
  layer: "层级",
  order: "同级顺序",
  directChildren: "直接子控件数",
  minSize: "最小尺寸",
  maxSize: "最大尺寸",
  clipsChildren: "裁剪子控件",
  sizeX: "宽度定义",
  sizeY: "高度定义",
  positionX: "水平位置定义",
  positionY: "垂直位置定义",
  anchorFrom: "自身锚点",
  anchorTo: "父级锚点",
  text: "文本",
  editText: "输入框文本",
  color: "文字颜色",
  alignment: "文字对齐",
  shadow: "文字阴影",
  linePadding: "行间距",
  gridDimension: "网格行列",
  stackOrientation: "排列方向",
  scrollPosition: "滚动位置",
  scrollPercent: "滚动百分比",
  toggleState: "开关状态",
  sliderValue: "滑块值",
};
function readableValue(value, key) {
  if (value === null || value === undefined) return "未提供";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number")
    return String(Math.round(value * 10000) / 10000);
  if (Array.isArray(value)) {
    const names = key.toLowerCase().includes("size")
      ? ["宽", "高"]
      : key.toLowerCase().includes("position")
        ? ["X", "Y"]
        : key === "color"
          ? ["R", "G", "B", "A"]
          : [];
    return value
      .map((v, i) => (names[i] ? names[i] + "：" : "") + readableValue(v, ""))
      .join("，");
  }
  if (typeof value === "object")
    return Object.entries(value)
      .map(
        ([k, v]) =>
          `${k}：${typeof v === "object" ? JSON.stringify(v) : String(v)}`,
      )
      .join("；");
  const anchors = {
    center: "居中",
    top_left: "左上",
    top_middle: "上中",
    top_right: "右上",
    left_middle: "左中",
    right_middle: "右中",
    bottom_left: "左下",
    bottom_middle: "下中",
    bottom_right: "右下",
    horizontal: "水平",
    vertical: "垂直",
    left: "左对齐",
    right: "右对齐",
  };
  return key.startsWith("anchor") ||
    key === "alignment" ||
    key === "stackOrientation"
    ? anchors[value] || value
    : value;
}
function propertyRows(details) {
  if (!details) return [];
  const identity = [
    { key: "name", label: "名称", value: details.name, group: "基本信息" },
    {
      key: "type",
      label: "类型",
      value: `${typeLabel(details.type)}（${details.type}）`,
      group: "基本信息",
    },
    { key: "path", label: "路径", value: details.path, group: "基本信息" },
  ];
  const groups = {
    runtime: "布局与状态",
    layout: "布局定义",
    text: "文字",
    control: "控件状态",
    variables: "自定义变量",
  };
  const rows = [];
  for (const [section, values] of Object.entries(details.properties || {}))
    for (const [key, value] of Object.entries(values))
      rows.push({
        key: section + "." + key,
        label: labels[key] || key,
        value: readableValue(value, key),
        group: groups[section] || section,
      });
  return [...rows, ...identity];
}
module.exports.typeLabel = typeLabel;
module.exports.propertyRows = propertyRows;
module.exports.readableValue = readableValue;
