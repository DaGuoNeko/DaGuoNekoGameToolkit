const reloadDefaults = Object.freeze({
  reload_key: "82",
  reload_world_key: "",
  reload_addon_key: "",
  reload_shaders_key: "",
  reload_key_global: true,
});
function validateReloadKeys(value, base = reloadDefaults) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("全局热更新快捷键配置应为对象");
  const result = { ...base };
  for (const [key, item] of Object.entries(value)) {
    if (!Object.hasOwn(reloadDefaults, key))
      throw Error("未知全局按键选项：" + key);
    if (key === "reload_key_global") {
      if (typeof item !== "boolean")
        throw Error("游戏界面快捷键选项必须是开关");
    } else if (
      typeof item !== "string" ||
      (item !== "" &&
        (!/^\d{1,3}$/.test(item) || Number(item) < 1 || Number(item) > 255))
    )
      throw Error("快捷键应为空或 1–255 的按键码：" + key);
    result[key] =
      key === "reload_key_global" || item === "" ? item : String(Number(item));
  }
  return result;
}
module.exports = { reloadDefaults, validateReloadKeys };
