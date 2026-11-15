import React, { useState } from "react";
import { Button, Select } from "../../app/ui.jsx";
import { setSoundKey, clearSoundKey } from "../../../shared/animation-sounds.cjs";

export function SoundEditor({ time, row, error, disabled, onSave }) {
  const [index, setIndex] = useState(row ? 0 : -1);
  const [name, setName] = useState(row?.sounds[0]?.effect || "");
  const [pitch, setPitch] = useState(row?.sounds[0]?.pitch == null ? "" : String(row.sounds[0].pitch));
  const [volume, setVolume] = useState(row?.sounds[0]?.volume == null ? "" : String(row.sounds[0].volume));
  const selected = row?.sounds[index];
  const choose = value => {
    const next = Number(value);
    const sound = row?.sounds[next];
    setIndex(next);
    setName(sound?.effect || "");
    setPitch(sound?.pitch == null ? "" : String(sound.pitch));
    setVolume(sound?.volume == null ? "" : String(sound.volume));
  };
  return <section className="model-sound-editor" aria-label="声音关键帧">
    <h3>声音 · {time.toFixed(2)} 秒</h3>
    {error && <p role="alert">{error}</p>}
    {row && <Select aria-label="当前声音" disabled={disabled || !!error} value={String(index)}
      options={[...row.sounds.map((sound, i) => ({ value: String(i), label: (i + 1) + ". " + sound.effect })), { value: "-1", label: "追加声音" }]}
      onChange={choose} />}
    <label className="model-sound-name">声音名称<input aria-label="声音名称" value={name} disabled={disabled || !!error} onChange={event => setName(event.target.value)} placeholder="例如 random.click" /></label>
    <div className="model-transform">
      <label className="model-sound-name">音高<input aria-label="音高" value={pitch} disabled={disabled || !!error} onChange={event => setPitch(event.target.value)} placeholder="默认" /></label>
      <label className="model-sound-name">音量<input aria-label="音量" value={volume} disabled={disabled || !!error} onChange={event => setVolume(event.target.value)} placeholder="默认" /></label>
    </div>
    <div className="model-tools">
      <Button disabled={disabled || !!error || !name.trim()} onClick={() => onSave(animation => setSoundKey(animation, time, name, index, { pitch, volume }), "已记录声音")}>{selected ? "更新声音" : "记录声音"}</Button>
      <Button disabled={disabled || !!error || !selected} onClick={() => onSave(animation => clearSoundKey(animation, time, index), "已删除声音")}>删除声音</Button>
    </div>
    <p className="model-texture-note">音高和音量可留空；预览暂不播放音频。</p>
  </section>;
}
