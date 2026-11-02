import React, { useEffect, useState } from "react";
import {
  Button,
  Intro,
  Section,
  Field,
  Select,
  ErrorBox,
  Modal,
  HelpDisclosure,
} from "../../app/ui.jsx";
import { optionFields, validateOverrides } from "../../../shared/game-options-model.cjs";
import "./game-options.css";
const call = (method, args = {}) => window.toolkit.call(method, args);
const choices = (f) =>
  f.choices ||
  (f.boolean
    ? [
        ["0", "关闭"],
        ["1", "开启"],
      ]
    : null);
function display(f, value) {
  if (value === undefined) return "文件中未设置";
  return (
    choices(f)?.find(([key]) => key === value)?.[1] ||
    (f.scale ? String(Number(value) / f.scale) : value)
  );
}
export function GameOptionsPage({ draft, setDraft }) {
  const [snapshot, setSnapshot] = useState(null),
    [working, setWorking] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [query, setQuery] = useState(""),
    [confirm, setConfirm] = useState(false);
  const dirty =
    draft && JSON.stringify(draft.values) !== JSON.stringify(draft.saved);
  const adopt = (value) => {
    setSnapshot(value);
    setDraft({
      revision: value.revision,
      values: value.overrides,
      saved: value.overrides,
    });
  };
  useEffect(() => {
    let live = true;
    call("game-options.read")
      .then((value) => {
        if (!live) return;
        setSnapshot(value);
        setDraft(
          (old) =>
            old || {
              revision: value.revision,
              values: value.overrides,
              saved: value.overrides,
            },
        );
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, []);
  const change = (key, value) =>
    setDraft((old) => {
      const values = { ...old.values };
      const numberInputs = { ...old.numberInputs };
      delete numberInputs[key];
      if (value === "") delete values[key];
      else values[key] = value;
      return { ...old, values, numberInputs };
    });
  const changeNumber = (field, text) => {
    // Keep the visible draft (including empty text or "0.") separate from file units.
    const value =
      field.scale && /^\d+(?:\.\d+)?$/.test(text)
        ? String(Number(text) * field.scale)
        : text;
    setDraft((old) => ({
      ...old,
      values: { ...old.values, [field.key]: value },
      numberInputs: { ...old.numberInputs, [field.key]: text },
    }));
  };
  const action = async (fn) => {
    setWorking(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  };
  const save = () =>
    action(async () => {
      const values = validateOverrides(draft.values);
      adopt(
        await call("game-options.save", {
          revision: draft.revision,
          overrides: values,
        }),
      );
      setNotice("已保存，将在下一次启动游戏前应用。");
    });
  const reload = () =>
    action(async () => {
      adopt(await call("game-options.read"));
      setConfirm(false);
    });
  return (
    <div className="game-options-page">
      <Intro
        title="游戏设置"
        subtitle="启动前设置网络、画面、声音和操作；所有启动配置与空白客户端共用。"
      />
      <ErrorBox>{error || snapshot?.fileError}</ErrorBox>
      {notice && <p role="status">{notice}</p>}
      <div className="toolbar game-options-toolbar">
        <Button primary disabled={!dirty || working} onClick={save}>
          保存游戏设置
        </Button>
        <Button
          disabled={working}
          onClick={() => (dirty ? setConfirm(true) : reload())}
        >
          重新读取游戏设置
        </Button>
        <Button
          disabled={!draft || working}
          onClick={() =>
            setDraft((old) => ({ ...old, values: {}, numberInputs: {} }))
          }
        >
          全部改为不覆盖
        </Button>
        <Button
          disabled={working}
          onClick={() => action(() => call("game-options.folder"))}
        >
          定位 options.txt
        </Button>
        <Button
          disabled={working}
          onClick={() =>
            action(() => call("game-options.folder", { backups: true }))
          }
        >
          打开设置备份
        </Button>
        <span className="muted">
          {dirty ? "有未保存修改" : "已保存"} ·{" "}
          {Object.keys(draft?.values || {}).length} 项启动覆盖
        </span>
      </div>
      <HelpDisclosure label="配置文件与生效范围">
      <p className="muted break-all">
        实际配置文件：{snapshot?.optionsFile || "正在读取…"}
      </p>
      <p className="muted">
        保存只记录启动设置，游戏文件在启动前备份并更新。未覆盖的项保留游戏原值；取消覆盖不会恢复以前的值。不同客户端共用此文件，有游戏运行时禁止改写。
      </p>
      </HelpDisclosure>
      {snapshot?.running && (
        <p role="status">
          检测到开发测试端正在运行，可先保存下一次启动的设置；需要改写文件时，请先退出相关测试端。
        </p>
      )}
      <input
        aria-label="搜索游戏设置"
        placeholder="搜索设置名称或配置键…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {!draft && <p>正在读取游戏设置…</p>}
      {draft &&
        ["网络调试", "画面", "声音", "操作"].map((group) => {
          const fields = optionFields.filter(
            (f) =>
              f.group === group &&
              (f.label + f.key + group)
                .toLowerCase()
                .includes(query.toLowerCase()),
          );
          if (!fields.length) return null;
          return (
            <Section
              key={group}
              title={group}
              description={
                group === "网络调试"
                  ? "开发版专用。选“完整网络堆栈（无限制）”后保存，再启动游戏；已进入的世界需要退出游戏后重开。"
                  : undefined
              }
              action={
                group === "网络调试" ? (
                  <Button
                    disabled={working}
                    onClick={() => change("dev_connection_quality", "1")}
                  >
                    启用完整网络堆栈
                  </Button>
                ) : undefined
              }
            >
              <fieldset
                disabled={working}
                className="workspace-fieldset game-options-grid"
              >
                {fields.map((f) => {
                  const options = choices(f),
                    overridden = Object.hasOwn(draft.values, f.key),
                    current = snapshot?.current[f.key],
                    value = draft.values[f.key] ?? current ?? f.initial;
                  return (
                    <div className="game-option" data-overridden={overridden} key={f.key}>
                      <Field label={f.label} hint={f.hint}>
                        {options ? (
                          <Select
                            value={overridden ? value : ""}
                            options={[
                              { value: "", label: "不覆盖（沿用游戏设置）" },
                              ...options.map(([value, label]) => ({
                                value,
                                label,
                              })),
                            ]}
                            onChange={(value) => change(f.key, value)}
                          />
                        ) : (
                          <div className="game-option-number">
                            <input
                              aria-label={f.label}
                              type="text"
                              inputMode={f.step === 1 ? "numeric" : "decimal"}
                              value={
                                draft.numberInputs?.[f.key] ??
                                (value === ""
                                  ? ""
                                  : f.scale
                                    ? String(Number(value) / f.scale)
                                    : value)
                              }
                              onChange={(e) => changeNumber(f, e.target.value)}
                            />
                          </div>
                        )}
                      </Field>
                      {!options && (
                        <label className="check-row">
                          <input
                            type="checkbox"
                            aria-label={"覆盖" + f.label}
                            checked={overridden}
                            onChange={(e) =>
                              change(
                                f.key,
                                e.target.checked ? (current ?? f.initial) : "",
                              )
                            }
                          />
                          启动时覆盖
                        </label>
                      )}
                      {!options && (
                        <p className="muted game-option-current">
                          直接编辑会启用覆盖 · 范围 {f.min}–{f.max}
                        </p>
                      )}
                      <p className="muted game-option-current">
                        文件当前值：{display(f, current)}
                      </p>
                      <HelpDisclosure label="配置键"><code>{f.key}</code></HelpDisclosure>
                    </div>
                  );
                })}
              </fieldset>
            </Section>
          );
        })}
      {confirm && (
        <Modal title="重新读取游戏设置？" onClose={() => setConfirm(false)}>
          <p>未保存的游戏设置修改将被放弃。</p>
          <div className="toolbar">
            <Button onClick={() => setConfirm(false)}>取消</Button>
            <Button primary disabled={working} onClick={reload}>
              确认重新读取
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
