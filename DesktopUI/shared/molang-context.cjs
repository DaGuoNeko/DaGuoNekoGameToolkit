const queryFields = [
  { key: "is_moving", label: "移动", type: "boolean", value: 0 },
  { key: "is_on_ground", label: "着地", type: "boolean", value: 1 },
  { key: "is_in_water", label: "在水中", type: "boolean", value: 0 },
  { key: "is_sneaking", label: "潜行", type: "boolean", value: 0 },
  { key: "is_sprinting", label: "疾跑", type: "boolean", value: 0 },
  { key: "ground_speed", label: "水平速度（米/秒）", type: "number", value: 0, min: 0, max: 100 },
  { key: "vertical_speed", label: "垂直速度（米/秒）", type: "number", value: 0, min: -100, max: 100 },
];
const queries = new Map(queryFields.map(field => ["query." + field.key, field]));
const controllerQueries = new Set(["query.any_animation_finished", "query.all_animations_finished"]);
const defaultMolangContext = () => Object.fromEntries(queryFields.map(field => ["query." + field.key, field.value]));

function simulationResult(enabled, values) {
  if (!enabled) return { context: undefined, error: "" };
  try {
    const data = {};
    for (const field of queryFields) {
      const key = "query." + field.key, value = values[key];
      if (typeof value === "string" && !value.trim()) throw Error(field.label + "不能为空");
      data[key] = Number(value);
    }
    return { context: validateMolangContext(data), error: "" };
  } catch (reason) { return { context: undefined, error: reason.message }; }
}

function validateMolangContext(context) {
  if (context === undefined) return undefined;
  if (!context || typeof context !== "object" || Array.isArray(context) || ![Object.prototype, null].includes(Object.getPrototypeOf(context))) throw Error("模拟查询上下文无效");
  const descriptors = Object.getOwnPropertyDescriptors(context), result = Object.create(null);
  if (Reflect.ownKeys(descriptors).length > queries.size) throw Error("模拟查询数量超限");
  for (const key of Reflect.ownKeys(descriptors)) {
    const field = queries.get(key), descriptor = descriptors[key];
    if (!field || !Object.hasOwn(descriptor, "value")) throw Error("模拟查询包含不支持的字段");
    const value = descriptor.value;
    if (typeof value !== "number" || !Number.isFinite(value) || (field.type === "boolean" ? value !== 0 && value !== 1 : value < field.min || value > field.max)) throw Error(field.label + "的模拟值无效或越界");
    result[key] = value;
  }
  return result;
}

function validateControllerQueries(context) {
  if (context === undefined) return undefined;
  if (!context || typeof context !== "object" || Array.isArray(context) || ![Object.prototype, null].includes(Object.getPrototypeOf(context))) throw Error("控制器查询上下文无效");
  const descriptors = Object.getOwnPropertyDescriptors(context), result = Object.create(null);
  if (Reflect.ownKeys(descriptors).length !== controllerQueries.size) throw Error("控制器完成查询不完整");
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (!controllerQueries.has(key) || !Object.hasOwn(descriptor, "value") || ![0, 1].includes(descriptor.value)) throw Error("控制器完成查询值无效");
    result[key] = descriptor.value;
  }
  return result;
}

module.exports = { queryFields, queries, controllerQueries, defaultMolangContext, simulationResult, validateMolangContext, validateControllerQueries };
