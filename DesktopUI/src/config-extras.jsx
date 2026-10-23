import React, { useState } from "react";
import { Button, Field, Section, Select } from "./ui.jsx";

export function GameDiscovery({ value, change, report }) {
  const [games, setGames] = useState([]),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  async function discover() {
    setBusy(true);
    try {
      const result = await window.toolkit.call("games.discover");
      setGames(result.games);
      setMessage(
        result.games.length
          ? `发现 ${result.games.length} 个版本，请选择要使用的程序。`
          : "没有找到已安装版本，请手动选择游戏 EXE。",
      );
      if (result.warnings.length) setMessage(result.warnings.join("\n"));
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="discovery-row">
      <Button disabled={busy} onClick={discover}>
        {busy ? "正在发现…" : "发现游戏版本"}
      </Button>
      {!!games.length && (
        <Field label="已发现的游戏版本">
          <Select
            value={value}
            placeholder="请选择游戏版本"
            options={games.map((game) => ({
              value: game.path,
              label: `${game.version} · ${game.path}`,
            }))}
            onChange={change}
          />
        </Field>
      )}
      {message && (
        <p className="muted" role="status">
          {message}
        </p>
      )}
    </div>
  );
}

export function ConfigExtras({ form, change, profileOnly = false }) {
  const experiments = [
    ["data_driven_biomes", "自定义生物群系"],
    ["upcoming_creator_features", "即将推出的创作者功能"],
    ["experimental_creator_cameras", "实验性摄像机"],
    ["gametest", "GameTest"],
    ["deferred_technical_preview", "延迟渲染技术预览"],
  ];
  return (
    <>
      <Section title="更多运行选项">
        <div className="checks">
          {[
            ["do_weather_cycle", "天气变化"],
            ["do_daylight_cycle", "昼夜循环"],
            ["auto_hot_reload_shaders", "自动热更新 Shader"],
            ["auto_hot_reload_materials", "自动热更新材质"],
            ["auto_hot_reload_particles", "自动热更新粒子"],
          ]
            .filter(
              ([key]) =>
                !profileOnly ||
                !["do_weather_cycle", "do_daylight_cycle"].includes(key),
            )
            .map(([key, label]) => (
              <label className="check-row" key={key}>
                <input
                  type="checkbox"
                  checked={form[key]}
                  onChange={(e) => change(key, e.target.checked)}
                />
                {label}
              </label>
            ))}
        </div>
        <Field label="游戏日志协议">
          <Select
            value={form.log_protocol}
            options={[
              { value: 0, label: "标准输出" },
              { value: 1, label: "Safaia（实验性）" },
            ]}
            onChange={(value) => change("log_protocol", value)}
          />
        </Field>
      </Section>
      {!profileOnly && (
        <Section
          title="实验性功能"
          description="这些选项交给 MCDK 创建或部署测试世界时使用；现有世界的实际效果需在游戏内核对。"
        >
          <label className="check-row">
            <input
              type="checkbox"
              checked={form.experiment_options !== undefined}
              onChange={(e) =>
                change("experiment_options", e.target.checked ? {} : undefined)
              }
            />
            配置实验性功能
          </label>
          {form.experiment_options !== undefined && (
            <div className="checks">
              {experiments.map(([key, label]) => (
                <label className="check-row" key={key}>
                  <input
                    type="checkbox"
                    checked={form.experiment_options[key] ?? false}
                    onChange={(e) =>
                      change("experiment_options", {
                        ...form.experiment_options,
                        [key]: e.target.checked,
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
          )}
        </Section>
      )}
    </>
  );
}
