const cache = new Map();
const { queries, controllerQueries, validateMolangContext, validateControllerQueries } = require("./molang-context.cjs");
const functions = new Map([
  ["math.sin", [1, x => Math.sin(x * Math.PI / 180)]],
  ["math.cos", [1, x => Math.cos(x * Math.PI / 180)]],
  ["math.abs", [1, Math.abs]], ["math.floor", [1, Math.floor]],
  ["math.ceil", [1, Math.ceil]], ["math.sqrt", [1, Math.sqrt]],
  ["math.round", [1, x => Math.sign(x) * Math.floor(Math.abs(x) + 0.5)]],
  ["math.min", [2, Math.min]], ["math.max", [2, Math.max]],
  ["math.pow", [2, Math.pow]], ["math.mod", [2, (a, b) => a % b]],
  ["math.clamp", [3, (x, low, high) => Math.min(high, Math.max(low, x))]],
  ["math.lerp", [3, (a, b, t) => a + (b - a) * Math.min(1, Math.max(0, t))]],
]);
const precedence = new Map([["||", 1], ["&&", 2], ["==", 3], ["!=", 3], ["<", 4], [">", 4], ["<=", 4], [">=", 4], ["+", 5], ["-", 5], ["*", 6], ["/", 6]]);

// shortcut: 查询只接受明确提供的模拟值；变量赋值、循环和真实游戏上下文尚未接入。
function compile(source) {
  if (source.length > 2048) throw Error("Molang 表达式超过 2048 字符");
  const pattern = /\s*(\d+(?:\.\d*)?(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?|[a-z_]\w*(?:\.[a-z_]\w*)*|&&|\|\||==|!=|<=|>=|[+*/!<>?:(),;\-])/iy;
  const tokens = [];
  let at = 0;
  while (at < source.length) {
    pattern.lastIndex = at;
    const match = pattern.exec(source);
    if (!match) {
      if (!source.slice(at).trim()) break;
      throw Error("Molang 包含不支持的语法");
    }
    tokens.push(match[1].toLowerCase());
    if (tokens.length > 256) throw Error("Molang 表达式过于复杂");
    at = pattern.lastIndex;
  }
  let cursor = 0;
  const take = token => tokens[cursor] === token && (++cursor, true);
  const expect = token => { if (!take(token)) throw Error("Molang 缺少 " + token); };
  function primary(depth) {
    if (depth > 32) throw Error("Molang 嵌套过深");
    const token = tokens[cursor++];
    if (["+", "-", "!"].includes(token)) return { op: token + "u", arg: primary(depth + 1) };
    if (token === "(") {
      const node = expression(0, depth + 1);
      expect(")");
      return node;
    }
    if (token && /^\d|^\.\d/.test(token)) return { number: Number(token) };
    if (token === "math.pi") return { number: Math.PI };
    if (token === "query.anim_time" || token === "q.anim_time") return { time: true };
    const query = token?.startsWith("q.") ? "query." + token.slice(2) : token;
    if (queries.has(query)) return { query };
    if (controllerQueries.has(query)) return { controllerQuery: query };
    const fn = functions.get(token);
    if (!fn) throw Error("预览不支持 " + (token || "空表达式"));
    expect("(");
    const args = [];
    if (!take(")")) {
      do { args.push(expression(0, depth + 1)); } while (take(","));
      expect(")");
    }
    if (args.length !== fn[0]) throw Error(token + " 参数数量不正确");
    return { fn: fn[1], args };
  }
  function expression(min, depth) {
    let left = primary(depth);
    while (precedence.has(tokens[cursor]) && precedence.get(tokens[cursor]) >= min) {
      const op = tokens[cursor++];
      left = { op, left, right: expression(precedence.get(op) + 1, depth + 1) };
    }
    if (min === 0 && take("?")) {
      const yes = expression(0, depth + 1);
      expect(":");
      left = { op: "?", left, yes, no: expression(0, depth + 1) };
    }
    return left;
  }
  take("return");
  const tree = expression(0, 0);
  take(";");
  if (cursor !== tokens.length) throw Error("预览仅支持单个 Molang 表达式");
  return tree;
}

function evaluate(node, time, context, controllerContext) {
  let value;
  if (Object.hasOwn(node, "number")) value = node.number;
  else if (node.time) value = time;
  else if (node.controllerQuery) {
    if (!controllerContext) throw Error("预览不支持 " + node.controllerQuery + "：仅控制器播放可提供完成状态");
    value = controllerContext[node.controllerQuery];
  }
  else if (node.query) {
    if (!context || !Object.hasOwn(context, node.query)) throw Error("预览不支持 " + node.query + "：未提供模拟查询值");
    value = context[node.query];
  }
  else if (node.fn) value = node.fn(...node.args.map(arg => evaluate(arg, time, context, controllerContext)));
  else {
    const a = evaluate(node.arg || node.left, time, context, controllerContext);
    switch (node.op) {
      case "+u": value = a; break;
      case "-u": value = -a; break;
      case "!u": value = a ? 0 : 1; break;
      case "?": value = evaluate(a ? node.yes : node.no, time, context, controllerContext); break;
      case "&&": value = a && evaluate(node.right, time, context, controllerContext) ? 1 : 0; break;
      case "||": value = a || evaluate(node.right, time, context, controllerContext) ? 1 : 0; break;
      default: {
        const b = evaluate(node.right, time, context, controllerContext);
        switch (node.op) {
          case "+": value = a + b; break;
          case "-": value = a - b; break;
          case "*": value = a * b; break;
          case "/": value = a / b; break;
          case "==": value = +(a === b); break;
          case "!=": value = +(a !== b); break;
          case "<": value = +(a < b); break;
          case ">": value = +(a > b); break;
          case "<=": value = +(a <= b); break;
          case ">=": value = +(a >= b); break;
        }
      }
    }
  }
  if (!Number.isFinite(value)) throw Error("Molang 运算结果无效（除零、溢出或函数参数超出范围）");
  return value;
}

function evaluateMolang(source, time, context, controllerContext) {
  const checkedContext = validateMolangContext(context);
  const checkedController = validateControllerQueries(controllerContext);
  if (typeof source === "number") {
    if (!Number.isFinite(source)) throw Error("动画数值无效");
    return source;
  }
  if (typeof source !== "string") throw Error("Molang 表达式类型无效");
  if (source.length > 2048) throw Error("Molang 表达式超过 2048 字符");
  let compiled = cache.get(source);
  if (!compiled) {
    try { compiled = { tree: compile(source) }; }
    catch (error) { compiled = { error: error.message }; }
    if (cache.size >= 256) cache.delete(cache.keys().next().value);
    cache.set(source, compiled);
  }
  if (compiled.error) throw Error(compiled.error);
  return evaluate(compiled.tree, time, checkedContext, checkedController);
}

module.exports = { evaluateMolang };
