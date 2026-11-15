import { useEffect, useRef, useState } from "react";
import { defaultViews } from "../../../shared/model-views.cjs";

export function useModelViews() {
  const [session, setSession] = useState(defaultViews());
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState("");
  const active = useRef(false);
  const version = useRef(0);
  useEffect(() => {
    active.current = true;
    window.toolkit.call("content.read-views").then(result => {
      if (!active.current) return;
      setSession(result.views);
      setReady(true);
    }).catch(reason => { if (active.current) setError("视角读取失败：" + reason.message); });
    return () => { active.current = false; };
  }, []);
  const save = async views => {
    if (!ready) return;
    const current = ++version.current;
    setSession(views);
    setPending(value => value + 1);
    setError("");
    try { await window.toolkit.call("content.save-views", { views }); }
    catch (reason) { if (active.current && version.current === current) setError("视角保存失败，当前视角尚未保存：" + reason.message); }
    finally { if (active.current) setPending(value => value - 1); }
  };
  return { session, ready, pending, error, save };
}
