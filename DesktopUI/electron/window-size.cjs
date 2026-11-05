const windowSizeDefaults = {
  enabled: true,
  width: 1280,
  height: 720,
  fullscreen: false,
};
function validateWindowSize(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.enabled !== "boolean" ||
    (value.fullscreen !== undefined && typeof value.fullscreen !== "boolean") ||
    !Number.isInteger(value.width) ||
    value.width < 640 ||
    value.width > 7680 ||
    !Number.isInteger(value.height) ||
    value.height < 360 ||
    value.height > 4320
  )
    throw Error("窗口宽度须为 640–7680，高度须为 360–4320 的整数像素");
  return {
    enabled: value.enabled,
    width: value.width,
    height: value.height,
    fullscreen: value.fullscreen ?? false,
  };
}
function applyWindowSize(config, settings) {
  const size = validateWindowSize(settings || windowSizeDefaults);
  if (!size.enabled) return config;
  const style = config.window_style;
  if (
    style !== undefined &&
    (!style || typeof style !== "object" || Array.isArray(style))
  )
    throw Error("启动配置 window_style 必须为对象");
  if (style && Object.hasOwn(style, "fixed_size")) return config;
  return {
    ...config,
    window_style: { ...style, fixed_size: [size.width, size.height] },
  };
}
module.exports = { windowSizeDefaults, validateWindowSize, applyWindowSize };
