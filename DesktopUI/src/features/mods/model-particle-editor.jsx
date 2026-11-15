import React, { useState } from "react";
import { Button } from "../../app/ui.jsx";
import { setParticleKey, clearParticleKey } from "../../../shared/animation-particles.cjs";

export function ParticleEditor({ time, row, error, disabled, onSave }) {
  const [effect, setEffect] = useState(row?.effect || "");
  const [locator, setLocator] = useState(row?.locator || "");
  const [script, setScript] = useState(row?.source?.pre_effect_script || "");
  const [bind, setBind] = useState(row?.source?.bind_to_actor === true);
  return <section className="model-sound-editor" aria-label="粒子关键帧">
    <h3>粒子 · {time.toFixed(2)} 秒</h3>
    {error && <p role="alert">{error}</p>}
    <label className="model-sound-name">粒子名称<input aria-label="粒子名称" value={effect} disabled={disabled || !!error} onChange={event => setEffect(event.target.value)} placeholder="例如 minecraft:basic_smoke_particle" /></label>
    <label className="model-sound-name">定位器<input aria-label="粒子定位器" value={locator} disabled={disabled || !!error} onChange={event => setLocator(event.target.value)} placeholder="可留空" /></label>
    <label className="model-sound-name">脚本<input aria-label="粒子脚本" value={script} disabled={disabled || !!error} onChange={event => setScript(event.target.value)} placeholder="可留空" /></label>
    <label className="model-check"><input type="checkbox" checked={bind} disabled={disabled || !!error} onChange={event => setBind(event.target.checked)} />绑定到实体</label>
    <div className="model-tools">
      <Button disabled={disabled || !!error || !effect.trim()} onClick={() => onSave(animation => setParticleKey(animation, time, effect, locator, { script, bind }), row ? "已更新粒子" : "已记录粒子")}>{row ? "更新粒子" : "记录粒子"}</Button>
      <Button disabled={disabled || !!error || !row} onClick={() => onSave(animation => clearParticleKey(animation, time), "已删除粒子")}>删除粒子</Button>
    </div>
    <p className="model-texture-note">脚本可留空；预览不发射粒子。</p>
  </section>;
}
