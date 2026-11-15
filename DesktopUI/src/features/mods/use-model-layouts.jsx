import { useEffect, useRef, useState } from "react";

export function useModelLayouts() {
  const [layouts, setLayouts] = useState({});
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(0);
  const [errors, setErrors] = useState({});
  const latest = useRef({});
  const versions = useRef({});
  const active = useRef(false);
  const load = async () => {
    setErrors({});
    try {
      const result = await window.toolkit.call("content.read-layouts");
      if (!active.current) return;
      latest.current = result.layouts;
      setLayouts(result.layouts); setReady(true);
    } catch (error) { if (active.current) setErrors({ load: "布局读取失败：" + error.message }); }
  };
  useEffect(() => {
    active.current = true; load();
    return () => { active.current = false; };
  }, []);
  const save = async (mode, layout) => {
    if (!ready) return;
    latest.current = { ...latest.current, [mode]: layout };
    setLayouts(latest.current);
    const version = (versions.current[mode] || 0) + 1;
    versions.current[mode] = version;
    setPending(value => value + 1);
    setErrors(value => { const next = { ...value }; delete next[mode]; return next; });
    try {
      await window.toolkit.call("content.save-layout", { mode, layout });
    } catch (error) {
      if (active.current && versions.current[mode] === version) setErrors(value => ({ ...value, [mode]: "布局保存失败，当前调整尚未保存：" + error.message }));
    } finally { if (active.current) setPending(value => value - 1); }
  };
  const retry = () => {
    if (!ready) { load(); return; }
    for (const mode of Object.keys(errors)) if (latest.current[mode]) save(mode, latest.current[mode]);
  };
  return { layouts, ready, pending, error: Object.values(errors).join("\n"), save, retry };
}
