// Replies and pushed events may overlap or arrive after a newer snapshot.
// Epochs separate cleared/new sessions; IDs deduplicate overlapping log ranges.
function mergeRuntime(current, incoming) {
  if (!current) return { ...incoming, logs: unique(incoming.logs || []) };
  if (incoming.epoch < current.epoch) return current;
  const newer = incoming.revision >= current.revision;
  const logs =
    incoming.epoch > current.epoch
      ? incoming.logs || []
      : [...current.logs, ...(incoming.logs || [])];
  return { ...(newer ? incoming : current), logs: unique(logs) };
}
function unique(logs) {
  return [...new Map(logs.map((entry) => [entry.id, entry])).values()]
    .sort((a, b) => a.id - b.id)
    .slice(-2000);
}
// 启动会话与 Host Bridge 的 ID 不同，必须同时核对登记身份和所属进程。
function debugTargetFor(session, bridges) {
  if (!session?.bridgeRegistrationId || !session.pid) return undefined;
  return bridges.find(bridge => bridge.connected && bridge.registrationId === session.bridgeRegistrationId && bridge.mcdkPid === session.pid);
}
function launchTargetFor(bridge, sessions) {
  if (!bridge?.registrationId || !bridge.mcdkPid) return undefined;
  return sessions.find(session => session.bridgeRegistrationId === bridge.registrationId && session.pid === bridge.mcdkPid);
}
class RuntimeView {
  constructor() {
    this.value = { session: null, logs: [], epoch: 0, revision: -1 };
    this.metadata = this.value; this.signature = "";
    this.listeners = new Set(); this.metadataListeners = new Set();
  }
  receive(incoming) {
    const next = mergeRuntime(this.value, incoming);
    if (next === this.value) return;
    this.value = next;
    const { logs, revision, ...metadata } = next;
    const signature = JSON.stringify(metadata);
    if (signature !== this.signature) {
      this.signature = signature; this.metadata = { ...next, logs: [] };
      for (const listener of this.metadataListeners) listener();
    }
    for (const listener of this.listeners) listener();
  }
}
module.exports = { mergeRuntime, debugTargetFor, launchTargetFor, RuntimeView };
