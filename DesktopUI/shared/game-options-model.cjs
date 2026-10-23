// Keys verified against the development game's options.txt and settings resources.
const optionFields = [
  {
    key: "content_log_file",
    label: "开启原版内容日志文件",
    group: "游戏调试日志",
    boolean: true,
    initial: "1",
    hint: "开启后可在运行日志中切换到游戏调试日志，查看原版 JSON、资源和实体等内容错误。",
  },
  {
    key: "dev_connection_quality",
    label: "网络调节器",
    group: "网络调试",
    choices: [
      ["0", "关闭（本地内存连接）"],
      ["1", "完整网络堆栈（无限制）"],
      ["2", "4G：100 ms 延迟 / 1% 丢包"],
      ["3", "3G：200 ms 延迟 / 2% 丢包"],
      ["4", "慢：300 ms 延迟 / 3% 丢包"],
      ["5", "非常慢：400 ms 延迟 / 4% 丢包"],
    ],
    initial: "1",
    hint: "本地游戏进入世界后此项可能变灰，请在启动前选择。正常网络调试选“完整网络堆栈”，弱网档位会主动制造延迟与丢包。",
  },
  {
    key: "dev_show_latency_graph",
    label: "显示网络延迟图",
    group: "网络调试",
    boolean: true,
    initial: "1",
  },
  {
    key: "dev_add_http_delay_seconds",
    label: "HTTP 额外延迟（秒）",
    group: "网络调试",
    min: 0,
    max: 10,
    step: 1,
    initial: "0",
    hint: "仅用于 HTTP 请求，不等同于游戏数据包延迟。",
  },
  {
    key: "gfx_fullscreen",
    label: "全屏",
    group: "画面",
    boolean: true,
    initial: "0",
  },
  {
    key: "gfx_gamma",
    label: "亮度",
    group: "画面",
    min: 0,
    max: 1,
    step: 0.01,
    initial: "0.5",
  },
  {
    key: "gfx_viewdistance",
    label: "渲染距离（区块）",
    group: "画面",
    min: 4,
    max: 64,
    step: 1,
    scale: 16,
    initial: "192",
    hint: "每区块 16 格；游戏可能按设备能力限制最终值。",
  },
  {
    key: "gfx_max_framerate",
    label: "帧率上限",
    group: "画面",
    min: 0,
    max: 1000,
    step: 1,
    initial: "0",
    hint: "0 表示不限制。",
  },
  {
    key: "gfx_fancyskies",
    label: "精美天空",
    group: "画面",
    boolean: true,
    initial: "1",
  },
  {
    key: "audio_main",
    label: "主音量",
    group: "声音",
    min: 0,
    max: 1,
    step: 0.01,
    initial: "1",
  },
  {
    key: "audio_sound",
    label: "音效音量",
    group: "声音",
    min: 0,
    max: 1,
    step: 0.01,
    initial: "1",
  },
  {
    key: "audio_music",
    label: "音乐音量",
    group: "声音",
    min: 0,
    max: 1,
    step: 0.01,
    initial: "0.5",
  },
  {
    key: "ctrl_sensitivity2_mouse",
    label: "鼠标灵敏度",
    group: "操作",
    min: 0,
    max: 1,
    step: 0.01,
    initial: "0.5",
  },
];
const byKey = Object.fromEntries(optionFields.map((f) => [f.key, f]));
function validateOverrides(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("游戏设置格式无效");
  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    const field = Object.hasOwn(byKey, key) ? byKey[key] : null;
    if (!field) throw Error("不支持的游戏设置：" + key);
    if (typeof raw !== "string" || !/^\d+(?:\.\d+)?$/.test(raw))
      throw Error(field.label + "的值无效");
    const n = Number(raw),
      scale = field.scale || 1;
    if (
      field.boolean
        ? !["0", "1"].includes(raw)
        : field.choices
          ? !field.choices.some(([v]) => v === raw)
          : !Number.isFinite(n) ||
            n / scale < field.min ||
            n / scale > field.max ||
            (field.step === 1 && !Number.isInteger(n / scale))
    )
      throw Error(field.label + "超出允许范围");
    result[key] = String(n);
  }
  return result;
}
module.exports = { optionFields, validateOverrides };
