const jsonc = require("jsonc-parser");
// Lexical Windows paths, shared by the renderer and main process. Files need
// not exist: stale library entries must still be removable from profiles.
function modKey(value, base = "") {
  let full = value.replaceAll("/", "\\");
  const parent = base.replaceAll("/", "\\");
  if (!/^(?:[a-z]:\\|\\\\)/i.test(full)) {
    if (/^[a-z]:/i.test(full)) {
      if (full.slice(0, 2).toLowerCase() !== parent.slice(0, 2).toLowerCase())
        throw Error("草稿含跨盘相对路径，请重新载入配置");
      full = full.slice(2);
    }
    if (full.startsWith("\\")) {
      const root =
        /^[a-z]:/i.exec(parent)?.[0] || /^\\\\[^\\]+\\[^\\]+/.exec(parent)?.[0];
      if (!root) throw Error("无法解析草稿中的模组路径");
      full = root + full;
    } else full = parent.replace(/\\+$/, "") + "\\" + full;
  }
  const unc = full.startsWith("\\\\"),
    minimum = unc ? 2 : 1;
  const pieces = [];
  for (const piece of full.split(/\\+/)) {
    if (!piece || piece === ".") continue;
    if (piece === "..") {
      if (pieces.length > minimum) pieces.pop();
    } else pieces.push(piece);
  }
  return (unc ? "\\\\" : "") + pieces.join("\\").toLowerCase();
}
function withoutMod(entries, base, target) {
  return entries.filter(
    (entry) =>
      modKey(typeof entry === "string" ? entry : entry.path, base) !==
      modKey(target),
  );
}
function removeModJson(raw, matches) {
  const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom ? raw.slice(1) : raw;
  const errors = [];
  const value = jsonc.parse(body, errors, {
    allowTrailingComma: true,
  });
  if (
    errors.length ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    throw Error("配置 JSON 无效");
  const entries = value.included_mod_dirs;
  if (entries === undefined) return raw;
  if (
    !Array.isArray(entries) ||
    entries.some(
      (e) => typeof e !== "string" && (!e || typeof e.path !== "string"),
    )
  )
    throw Error("模组列表格式无效");
  // jsonc-parser's last-element removal can leave the final character in a
  // compact array. Use AST spans and separator tokens instead; leave comments
  // and retained node bytes intact, and validate the resulting document.
  const tree = jsonc.parseTree(body);
  if (
    tree.children.filter(
      (node) => node.children?.[0]?.value === "included_mod_dirs",
    ).length !== 1
  )
    throw Error("配置中有重复的 included_mod_dirs 字段，请先修正");
  const array = jsonc.findNodeAtLocation(tree, ["included_mod_dirs"]);
  const keep = entries.map((e) => !matches(typeof e === "string" ? e : e.path));
  if (keep.every(Boolean)) return raw;
  const last = keep.lastIndexOf(true),
    edits = [];
  const scanner = jsonc.createScanner(body);
  array.children.forEach((node, index) => {
    if (!keep[index])
      edits.push({ offset: node.offset, length: node.length, content: "" });
    const end =
      array.children[index + 1]?.offset ?? array.offset + array.length - 1;
    scanner.setPosition(node.offset + node.length);
    let keepComma = keep[index] && index < last;
    for (
      let token = scanner.scan();
      token !== jsonc.SyntaxKind.EOF && scanner.getTokenOffset() < end;
      token = scanner.scan()
    ) {
      if (token === jsonc.SyntaxKind.CommaToken) {
        if (keepComma) keepComma = false;
        else
          edits.push({
            offset: scanner.getTokenOffset(),
            length: scanner.getTokenLength(),
            content: "",
          });
      }
    }
  });
  const result = jsonc.applyEdits(body, edits),
    afterErrors = [];
  jsonc.parse(result, afterErrors, { allowTrailingComma: true });
  if (afterErrors.length) throw Error("清理模组后的 JSON 无效，已保留原配置");
  return bom + result;
}
module.exports = { modKey, withoutMod, removeModJson };
