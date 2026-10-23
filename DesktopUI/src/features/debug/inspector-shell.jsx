import React, { useEffect, useRef, useState } from "react";
import { UiInspectorPage } from "./debug-ui.jsx";
import { useDebugSession } from "./debug-session.jsx";
import { ErrorBox } from "../../app/ui.jsx";
export function InspectorShell() {
  const { closeInspector, inspectorDirty } = useDebugSession();
  const [settings, setSettings] = useState({ ThemeHue: 210 }),
    [error, setError] = useState("");
  const closeRef = useRef(closeInspector);
  closeRef.current = closeInspector;
  useEffect(() => {
    let alive = true;
    const theme = (value) => {
      document.documentElement.dataset.theme = value.dark ? "dark" : "light";
      if (value.settings) setSettings(value.settings);
    };
    const offTheme = window.toolkit.onTheme(theme);
    const offClose = window.toolkit.onInspectorClose(() =>
      closeRef.current().catch((error) => alive && setError(error.message)),
    );
    window.toolkit
      .call("bootstrap")
      .then((value) => {
        if (alive) {
          theme(value);
          setSettings(value.settings);
        }
      })
      .catch((error) => alive && setError(error.message));
    return () => {
      alive = false;
      offTheme();
      offClose();
    };
  }, []);
  useEffect(() => {
    window.toolkit
      .call("window.dirty", { dirty: inspectorDirty })
      .catch((error) => setError(error.message));
  }, [inspectorDirty]);
  return (
    <main
      className="inspector-popout inspector-main"
      style={{ "--accent-hue": settings.ThemeHue }}
    >
      <div className="page-container">
        <ErrorBox>{error}</ErrorBox>
        <UiInspectorPage />
      </div>
    </main>
  );
}
