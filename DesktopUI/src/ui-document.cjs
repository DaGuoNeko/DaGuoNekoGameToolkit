const jsonc = require("jsonc-parser");
const MAX_TEXT = 2 * 1024 * 1024;
function parseDocument(raw) {
  if (typeof raw !== "string" || raw.length > MAX_TEXT)
    throw Error("UI 文件不能超过 2 MiB");
  const errors = [];
  const value = jsonc.parse(raw.replace(/^\uFEFF/, ""), errors, {
    allowTrailingComma: true,
  });
  if (errors.length)
    throw Error(
      "JSON 格式错误：" +
        jsonc.printParseErrorCode(errors[0].error) +
        "，位置 " +
        errors[0].offset,
    );
  if (!value || Array.isArray(value) || typeof value !== "object")
    throw Error("UI 文件顶层必须是对象");
  if (typeof value.namespace !== "string" || !value.namespace.trim())
    throw Error("UI 文件需要 namespace");
  let count = 0;
  function check(v, depth) {
    if (++count > 150000 || depth > 100)
      throw Error("UI 文件过大或嵌套超过 100 层");
    if (v && typeof v === "object")
      for (const key of Object.keys(v)) check(v[key], depth + 1);
  }
  check(value, 0);
  return value;
}
function edit(raw, path, value, insertion = false) {
  const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
  let body = raw.slice(bom.length);
  body = jsonc.applyEdits(
    body,
    jsonc.modify(body, path, value, {
      isArrayInsertion: insertion,
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
        eol: raw.includes("\r\n") ? "\r\n" : "\n",
      },
    }),
  );
  const result = bom + body;
  parseDocument(result);
  return result;
}
const anchors = {
  top_left: [0, 0],
  top_middle: [0.5, 0],
  top_right: [1, 0],
  left_middle: [0, 0.5],
  center: [0.5, 0.5],
  right_middle: [1, 0.5],
  bottom_left: [0, 1],
  bottom_middle: [0.5, 1],
  bottom_right: [1, 1],
};
function dimension(value, fallback, warnings) {
  if (typeof value === "number" && Number.isFinite(value)) return [0, value];
  if (typeof value === "string") {
    const m = value
      .replace(/\s/g, "")
      .match(/^(-?\d+(?:\.\d+)?)%(?:\+?(-?\d+(?:\.\d+)?)px)?$/);
    if (m) return [Number(m[1]) / 100, Number(m[2] || 0)];
    const px = value.match(/^(-?\d+(?:\.\d+)?)px$/);
    if (px) return [0, Number(px[1])];
  }
  if (value !== undefined)
    warnings.add("存在未解析的尺寸表达式，画布使用占位尺寸");
  return fallback;
}
function buildScene(raw, dependencies = [], screen) {
  const doc = parseDocument(raw),
    defs = new Map(),
    warnings = new Set(),
    nodes = [];
  for (const source of [...dependencies, { data: doc }]) {
    const d = source.data;
    if (!d?.namespace) continue;
    for (const [key, value] of Object.entries(d))
      if (value && typeof value === "object" && !Array.isArray(value))
        defs.set(d.namespace + "." + key.split("@")[0], {
          key,
          value,
          namespace: d.namespace,
        });
  }
  function resolve(key, value, namespace, trail = []) {
    if (trail.length > 32) {
      warnings.add("继承层数超过 32");
      return value;
    }
    const ref = key.includes("@") ? key.slice(key.indexOf("@") + 1) : null;
    if (!ref) return value;
    const full = ref.includes(".") ? ref : namespace + "." + ref;
    if (trail.includes(full)) {
      warnings.add("循环继承：" + full);
      return value;
    }
    const base = defs.get(full);
    if (!base) {
      warnings.add("缺少继承定义：" + full);
      return value;
    }
    return {
      ...resolve(base.key, base.value, base.namespace, [...trail, full]),
      ...value,
    };
  }
  function variable(value, vars, trail = []) {
    if (
      typeof value === "string" &&
      value.startsWith("$") &&
      Object.hasOwn(vars, value)
    ) {
      if (trail.includes(value) || trail.length > 32) {
        warnings.add("变量循环：" + value);
        return value;
      }
      return variable(vars[value], vars, [...trail, value]);
    }
    if (Array.isArray(value)) return value.map((v) => variable(v, vars, trail));
    if (
      typeof value === "string" &&
      (value.startsWith("$") || value.startsWith("("))
    )
      warnings.add("存在未解析的变量/表达式");
    return value;
  }
  function walk(key, source, path, parent, namespace, vars = {}, depth = 0) {
    if (depth > 80 || nodes.length >= 20000)
      throw Error("预览最多支持 20000 个节点和 80 层控件");
    const merged = resolve(key, source, namespace),
      scope = { ...vars };
    for (const [k, v] of Object.entries(merged))
      if (
        k.startsWith("$") &&
        k.endsWith("|default") &&
        !Object.hasOwn(scope, k.slice(0, -8))
      )
        scope[k.slice(0, -8)] = v;
    for (const [k, v] of Object.entries(merged))
      if (k.startsWith("$") && !k.endsWith("|default")) scope[k] = v;
    const value = {};
    for (const [k, v] of Object.entries(merged))
      value[k] = k === "controls" ? v : variable(v, scope);
    const idx = nodes.length;
    const node = {
      id: path ? JSON.stringify(path) : "inherited:" + idx,
      key,
      name: key.split("@")[0],
      path,
      parent,
      depth,
      value,
      source,
    };
    nodes.push(node);
    if (value.bindings?.length)
      warnings.add("动态绑定需要游戏校验；画布显示静态值");
    if (value.anim_type || value.anims)
      warnings.add("动画在文件中保留；画布尚未播放游戏动画");
    if (
      [
        "grid",
        "scroll_view",
        "custom",
        "collection_panel",
        "selection_wheel",
      ].includes(value.type)
    )
      warnings.add(value.type + " 暂以边界占位预览");
    const controls = value.controls;
    if (Array.isArray(controls))
      controls.forEach((entry, i) => {
        if (!entry || typeof entry !== "object") return;
        for (const [child, childValue] of Object.entries(entry))
          if (childValue && typeof childValue === "object")
            walk(
              child,
              childValue,
              path && Object.hasOwn(source, "controls")
                ? [...path, "controls", i, child]
                : null,
              idx,
              namespace,
              scope,
              depth + 1,
            );
      });
  }
  const screens = Object.keys(doc).filter(
    (k) =>
      doc[k] &&
      typeof doc[k] === "object" &&
      !Array.isArray(doc[k]) &&
      !doc[k].anim_type &&
      !k.startsWith("$"),
  );
  const current = screens.includes(screen) ? screen : screens[0];
  if (current) walk(current, doc[current], [current], -1, doc.namespace);
  const inputs = new Float32Array(nodes.length * 18);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i],
      v = n.value,
      w = dimension(v.size?.[0], [1, 0], warnings),
      h = dimension(v.size?.[1], [1, 0], warnings),
      x = dimension(v.offset?.[0], [0, 0], warnings),
      y = dimension(v.offset?.[1], [0, 0], warnings);
    const from = anchors[v.anchor_from] || anchors.center,
      to = anchors[v.anchor_to] || anchors.center;
    const alpha = typeof v.alpha === "number" ? v.alpha : 1;
    inputs.set(
      [
        n.parent,
        ...w,
        ...h,
        ...x,
        ...y,
        ...from,
        ...to,
        v.visible === false ? 0 : 1,
        typeof v.layer === "number" ? v.layer : 0,
        alpha,
        v.clips_children ? 1 : 0,
        v.type === "stack_panel" ? (v.orientation === "horizontal" ? 1 : 2) : 0,
      ],
      i * 18,
    );
  }
  return { doc, nodes, inputs, screens, current, warnings: [...warnings] };
}
function getAt(doc, path) {
  return path.reduce((v, k) => v?.[k], doc);
}
function renameKey(raw, path, name) {
  const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "",
    body = raw.slice(bom.length);
  const node = jsonc.findNodeAtLocation(jsonc.parseTree(body), path);
  const key = node.parent.children[0];
  const result =
    bom +
    jsonc.applyEdits(body, [
      { offset: key.offset, length: key.length, content: JSON.stringify(name) },
    ]);
  parseDocument(result);
  return result;
}
function changeNode(raw, path, op, payload) {
  if (!path) throw Error("继承控件只读，请打开原定义编辑");
  const doc = parseDocument(raw),
    node = getAt(doc, path);
  if (!node) throw Error("控件已不存在");
  if (op === "property")
    return edit(raw, [...path, payload.key], payload.value);
  if (op === "replace") return edit(raw, path, payload);
  if (op === "add") {
    const controls = node.controls || [];
    if (!Array.isArray(controls)) throw Error("controls 必须是数组");
    const names = new Set(controls.flatMap((c) => Object.keys(c)));
    let name = payload.type,
      i = 1;
    while (names.has(name)) name = payload.type + "_" + i++;
    const added = {
      [name]: payload.value || {
        type: payload.type,
        size: [100, 40],
        ...(payload.type === "label" ? { text: "文本", color: [1, 1, 1] } : {}),
      },
    };
    return node.controls
      ? edit(raw, [...path, "controls", controls.length], added, true)
      : edit(raw, [...path, "controls"], [added]);
  }
  if (path.length === 1) {
    if (op === "delete") return edit(raw, path, undefined);
    if (op === "rename") {
      if (Object.hasOwn(doc, payload)) throw Error("名称已存在");
      return renameKey(raw, path, payload);
    }
    if (op === "duplicate") {
      let name = path[0] + "_copy";
      while (Object.hasOwn(doc, name)) name += "_copy";
      return edit(raw, [name], node);
    }
  }
  const listPath = path.slice(0, -2),
    list = getAt(doc, listPath),
    index = path.at(-2),
    key = path.at(-1);
  if (!Array.isArray(list)) throw Error("控件结构不支持此操作");
  if (op === "delete") return edit(raw, [...listPath, index], undefined);
  if (op === "rename") {
    if (list.some((item) => Object.hasOwn(item, payload)))
      throw Error("同级名称已存在");
    return renameKey(raw, path, payload);
  }
  const copy = list.slice();
  if (op === "duplicate") {
    let name = key.split("@")[0] + "_copy";
    while (
      copy.some((c) => Object.keys(c).some((k) => k.split("@")[0] === name))
    )
      name += "_copy";
    return edit(
      raw,
      [...listPath, index + 1],
      { [name + (key.includes("@") ? "@" + key.split("@")[1] : "")]: node },
      true,
    );
  }
  if (op === "move") {
    const next = index + payload;
    if (next < 0 || next >= copy.length) return raw;
    const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "",
      body = raw.slice(bom.length),
      tree = jsonc.parseTree(body);
    const a = jsonc.findNodeAtLocation(tree, [...listPath, index]),
      b = jsonc.findNodeAtLocation(tree, [...listPath, next]);
    const result =
      bom +
      jsonc.applyEdits(body, [
        {
          offset: a.offset,
          length: a.length,
          content: body.slice(b.offset, b.offset + b.length),
        },
        {
          offset: b.offset,
          length: b.length,
          content: body.slice(a.offset, a.offset + a.length),
        },
      ]);
    parseDocument(result);
    return result;
  }
  return edit(raw, listPath, copy);
}
module.exports = {
  parseDocument,
  edit,
  buildScene,
  changeNode,
  anchors,
  MAX_TEXT,
};
