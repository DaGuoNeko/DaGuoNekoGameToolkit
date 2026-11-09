import { useSyncExternalStore } from "react";
import { RuntimeView } from "../../shared/runtime-state.cjs";
const runtime = new RuntimeView();
const subscribe = listeners => listener => { listeners.add(listener); return () => listeners.delete(listener); };
const subscribeMetadata = subscribe(runtime.metadataListeners), subscribeLogs = subscribe(runtime.listeners);
const metadata = () => runtime.metadata, full = () => runtime.value;
export const receiveRuntime = value => runtime.receive(value);
export function useRuntimeState(withLogs = false) {
  return useSyncExternalStore(withLogs ? subscribeLogs : subscribeMetadata, withLogs ? full : metadata);
}
