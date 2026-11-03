import React, { useEffect, useRef, useState } from "react";
import { Button, Field, Section, Select } from "../../app/ui.jsx";

export function GameDiscovery({ value, change, report }) {
  const [games, setGames] = useState([]),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [scope, setScope] = useState("auto"),
    [current, setCurrent] = useState(null),
    [matrix, setMatrix] = useState([]),
    [checking, setChecking] = useState(false);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    window.toolkit.call("games.supported").then((rows) => {
      if (alive.current) setMatrix(rows);
    }).catch((error) => { if (alive.current) report(error); });
    discover();
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    let active = true;
    setCurrent(null);
    if (value) {
      setChecking(true);
      window.toolkit.call("games.inspect", { path: value }).then((engine) => {
        if (active) setCurrent(engine);
      }).catch((error) => {
        if (active) setCurrent({ error: error.message });
      }).finally(() => { if (active) setChecking(false); });
    } else setChecking(false);
    return () => { active = false; };
  }, [value]);
  async function discover() {
    return discoverFrom();
  }
  async function discoverFrom(roots) {
    setBusy(true);
    try {
      const result = await window.toolkit.call(
        "games.discover",
        roots?.length ? { roots } : {},
      );
      if (!alive.current) return;
      setGames(result.games);
      const source = roots?.length ? "所选目录下" : "本机安装目录下";
      if (result.games.length === 1 && roots?.length) {
        change(result.games[0].path);
        setMessage(`已从所选目录找到并选择 ${result.games[0].version}。`);
      } else {
        setMessage(
          result.games.length
            ? `${source}找到 ${result.games.length} 个版本，请在下方选择。`
            : `${source}没有找到 Minecraft.Windows.exe，请选择 MCStudioDownload 或其下的游戏目录。`,
        );
      }
      if (result.warnings.length)
        setMessage((old) => old + "\n" + result.warnings.join("\n"));
    } catch (error) {
      if (alive.current) report(error);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function pickInstallDirectory() {
    try {
      const directory = await window.toolkit.call("files.directory");
      if (directory) await discoverFrom([directory]);
    } catch (error) {
      if (alive.current) report(error);
    }
  }
  return (
    <div className="discovery-row">
      <Button disabled={busy} onClick={discover}>
        {busy ? "正在查找…" : "查找已安装版本"}
      </Button>
      <Button disabled={busy} onClick={pickInstallDirectory}>
        选择安装目录
      </Button>
      <Field label="版本筛选">
        <Select value={scope} onChange={setScope} options={[
          { value: "auto", label: "自动联机：仅显示已验证版本" },
          { value: "all", label: "普通启动：显示全部版本" },
        ]} />
      </Field>
      {!!games.length && (
        <Field label="发现结果">
          <Select
            value={value}
            placeholder="请选择游戏版本"
            options={games.filter(game => scope === "all" || game.engineProfile?.autoJoin).map((game) => ({
              value: game.path,
              label: `${game.engineVersion || game.version} · ${game.engineProfile?.label || "未验证 · 仅手动启动"} · ${game.path}`,
            }))}
            onChange={change}
          />
        </Field>
      )}
      {!busy && games.length > 0 && scope === "auto" && !games.some(game => game.engineProfile?.autoJoin) && (
        <p className="muted">已发现的程序尚未通过自动联机验证，可切换到“手动启动”选择。</p>
      )}
      {value && (
        <p className="muted" role="status">
          当前选择：{checking ? "正在校验版本…" : current?.error || (current?.version
            ? `${current.version} · ${current.profile.label}`
            : "未验证构建；保留手动启动，不能自动联机。")}
        </p>
      )}
      {matrix.length > 0 && (
        <details className="engine-capabilities">
          <summary>查看已登记游戏版本的能力</summary>
          <p className="muted">按游戏程序实际构建校验。独立隔离需要内置启动器；未安装的版本需先安装后才能选择。</p>
          <table>
            <thead><tr><th>游戏版本</th><th>自动入房</th><th>独立主机</th><th>独立来宾</th></tr></thead>
            <tbody>{matrix.map(p => (
              <tr key={p.digest}>
                <td>{p.version}</td>
                <td>{p.autoJoin ? "已验证" : "待验证"}</td>
                <td>{p.isolatedHost ? "已验证" : "待验证"}</td>
                <td>{p.isolatedClient ? "已验证" : "待验证"}</td>
              </tr>
            ))}</tbody>
          </table>
        </details>
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
