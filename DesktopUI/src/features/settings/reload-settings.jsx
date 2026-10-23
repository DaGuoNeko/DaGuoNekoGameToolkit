import React, { useState } from "react";
import { Button, Field, Section } from "../../app/ui.jsx";
const keys = [
  ["reload_key", "脚本热更新按键"],
  ["reload_world_key", "重载世界按键"],
  ["reload_addon_key", "重载 Add-on 按键"],
  ["reload_shaders_key", "重载 Shader 按键"],
];
function keyName(value) {
  if (!value) return "未设置";
  const n = Number(value);
  if ((n >= 65 && n <= 90) || (n >= 48 && n <= 57))
    return String.fromCharCode(n);
  if (n >= 112 && n <= 123) return "F" + (n - 111);
  if (n >= 96 && n <= 105) return "数字键盘 " + (n - 96);
  return (
    {
      32: "空格",
      106: "数字键盘 *",
      107: "数字键盘 +",
      109: "数字键盘 -",
      110: "数字键盘 .",
      111: "数字键盘 /",
      192: "`",
      9: "Tab",
      13: "Enter",
    }[n] || "按键 " + value
  );
}
export function ReloadSettings({ options, save, report }) {
  const [working, setWorking] = useState(false);
  const update = async (key, value) => {
    setWorking(true);
    try {
      await save({ ReloadKeys: { [key]: value } });
    } catch (error) {
      report(error);
    } finally {
      setWorking(false);
    }
  };
  const assigned = keys.map(([key]) => options[key]).filter(Boolean);
  const duplicates = new Set(assigned).size !== assigned.length;
  return (
    <Section
      title="全局热更新与重载快捷键"
      description="统一用于所有启动配置，修改自动保存，在下一次启动游戏时生效。点击输入框后按键，Backspace/Delete 清除，Esc 取消。"
    >
      <fieldset className="workspace-fieldset" disabled={working}>
        <div className="world-form">
          {keys.map(([key, label]) => (
            <Field key={key} label={label}>
              <div className="toolbar">
                <input
                  readOnly
                  value={keyName(options[key])}
                  onKeyDown={(e) => {
                    if (e.key === "Tab") return;
                    e.preventDefault();
                    if (e.key === "Escape") {
                      e.currentTarget.blur();
                      return;
                    }
                    if (e.key === "Backspace" || e.key === "Delete") {
                      update(key, "");
                      return;
                    }
                    if (
                      e.repeat ||
                      e.ctrlKey ||
                      e.altKey ||
                      e.metaKey ||
                      e.shiftKey ||
                      [16, 17, 18, 91, 92].includes(e.keyCode)
                    )
                      return;
                    if (e.keyCode >= 1 && e.keyCode <= 255)
                      update(key, String(e.keyCode));
                  }}
                />
                <Button
                  aria-label={"清除" + label}
                  onClick={() => update(key, "")}
                >
                  清除
                </Button>
              </div>
            </Field>
          ))}
        </div>
        {duplicates && (
          <p className="error-box">
            按键有重复，游戏会优先响应前面的动作，请为每项选择不同按键。
          </p>
        )}
        <label className="check-row">
          <input
            type="checkbox"
            checked={options.reload_key_global}
            onChange={(e) => update("reload_key_global", e.target.checked)}
          />
          在其他游戏界面也响应快捷键
        </label>
      </fieldset>
      <p className="muted">
        按键需要该会话加载开发辅助模组，并由游戏接收输入。默认允许在其他游戏界面响应；日志页和游戏调试页的操作按钮直接通过调试连接发送请求，不依赖
        HUD 按键事件。游戏暂停或调试未就绪时仍可能无法执行。
      </p>
    </Section>
  );
}
