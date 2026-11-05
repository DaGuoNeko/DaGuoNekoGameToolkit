import React, { useEffect, useState } from "react";
import { Section, Field, Select, Button, ErrorBox } from "../../app/ui.jsx";
export function WindowSizeSettings({ value, save }) {
  const current = value || {
    enabled: true,
    width: 1280,
    height: 720,
    fullscreen: false,
  };
  const [enabled, setEnabled] = useState(current.enabled);
  const [fullscreen, setFullscreen] = useState(current.fullscreen ?? false);
  const [width, setWidth] = useState(String(current.width));
  const [height, setHeight] = useState(String(current.height));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setEnabled(current.enabled);
    setFullscreen(current.fullscreen ?? false);
    setWidth(String(current.width));
    setHeight(String(current.height));
  }, [current.enabled, current.fullscreen, current.width, current.height]);
  const presets = ["960×540", "1280×720", "1600×900", "1920×1080", "2560×1440"];
  const size = width + "×" + height;
  const valid =
    /^\d+$/.test(width) &&
    /^\d+$/.test(height) &&
    Number(width) >= 640 &&
    Number(width) <= 7680 &&
    Number(height) >= 360 &&
    Number(height) <= 4320;
  const dirty =
    enabled !== current.enabled ||
    fullscreen !== (current.fullscreen ?? false) ||
    width !== String(current.width) ||
    height !== String(current.height);
  return (
    <Section
      title="默认游戏窗口大小"
      description="保存后用于下一次启动存档和空白客户端，不改变已运行的窗口。"
    >
      <fieldset className="workspace-fieldset" disabled={saving}>
        <label className="check-row">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          使用默认窗口大小
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={fullscreen}
            onChange={(e) => setFullscreen(e.target.checked)}
          />
          全屏模式
        </label>
        <Field label="常用窗口尺寸">
          <Select
            value={presets.includes(size) ? size : "custom"}
            options={[
              ...presets.map((s) => ({ value: s, label: s })),
              { value: "custom", label: "自定义" },
            ]}
            onChange={(v) => {
              if (v !== "custom") {
                const [w, h] = v.split("×");
                setWidth(w);
                setHeight(h);
              }
            }}
          />
        </Field>
        <div className="world-form">
          <Field label="窗口宽度（像素）">
            <input
              type="number"
              min="640"
              max="7680"
              step="1"
              value={width}
              onChange={(e) => setWidth(e.target.value)}
            />
          </Field>
          <Field label="窗口高度（像素）">
            <input
              type="number"
              min="360"
              max="4320"
              step="1"
              value={height}
              onChange={(e) => setHeight(e.target.value)}
            />
          </Field>
        </div>
        {!valid && (
          <p className="muted">
            宽度请输入 640–7680，高度请输入 360–4320 的整数。
          </p>
        )}
        <p className="muted">
          关闭“使用默认窗口大小”后使用游戏原有尺寸；全屏模式会在下一次启动时生效。启动配置中单独指定的尺寸优先；自动加入房主的测试客户端继承房主本次启动尺寸。
        </p>
        <ErrorBox>{error}</ErrorBox>
        <Button
          primary
          disabled={saving || !valid || !dirty}
          onClick={async () => {
            setSaving(true);
            setError("");
            try {
              await save({
                GameWindowSize: {
                  enabled,
                  width: Number(width),
                  height: Number(height),
                  fullscreen,
                },
              });
            } catch (e) {
              setError(e.message);
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? "保存中…" : "保存窗口大小"}
        </Button>
      </fieldset>
    </Section>
  );
}
