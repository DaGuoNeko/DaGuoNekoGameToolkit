import React, { useState } from "react";
import { Button } from "../../app/ui.jsx";
import { setInstructionKey, clearInstructionKey } from "../../../shared/animation-timeline.cjs";

export function InstructionEditor({ time, row, error, disabled, onSave }) {
  const [text, setText] = useState(row?.text || "");
  return <section className="model-sound-editor" aria-label="指令关键帧">
    <h3>指令 · {time.toFixed(2)} 秒</h3>
    {error && <p role="alert">{error}</p>}
    <label className="model-sound-name">指令<input aria-label="动画指令" value={text} disabled={disabled || !!error} onChange={event => setText(event.target.value)} placeholder="例如 /say hi" /></label>
    <div className="model-tools">
      <Button disabled={disabled || !!error || !text.trim()} onClick={() => onSave(animation => setInstructionKey(animation, time, text), row ? "已更新指令" : "已记录指令")}>{row ? "更新指令" : "记录指令"}</Button>
      <Button disabled={disabled || !!error || !row} onClick={() => onSave(animation => clearInstructionKey(animation, time), "已删除指令")}>删除指令</Button>
    </div>
    <p className="model-texture-note">记在当前时间；预览不执行指令。</p>
  </section>;
}
