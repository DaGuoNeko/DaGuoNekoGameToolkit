const crypto = require("node:crypto");

// 同一弹窗反复读取不增加次数；每次明确的新出现才生成一次性操作 ID。
class AssertionTracker {
  constructor() { this.sessions = new Map(); }
  observe(sessionId, bridge, snapshot) {
    const identity = `${bridge.connectionGeneration}:${bridge.minecraftPid}:${snapshot.processCreatedAt}`;
    let state = this.sessions.get(sessionId);
    if (!state || state.identity !== identity) {
      state = { identity, present: new Map(), counts: new Map() };
      this.sessions.set(sessionId, state);
    }
    const now = new Date().toISOString(), next = new Map();
    const assertions = snapshot.assertions.map(native => {
      let entry = state.present.get(native.id);
      const key = crypto.createHash("sha256").update(native.text || "").digest("hex");
      let stat = state.counts.get(key);
      if (!entry) {
        if (!stat && state.counts.size >= 1000) throw Error("ASSERTION_HISTORY_LIMIT");
        stat = { count: (stat?.count || 0) + 1, firstSeen: stat?.firstSeen || now, lastSeen: now };
        state.counts.set(key, stat);
        entry = { id: crypto.randomUUID(), nativeId: native.id, attempted: false };
      }
      stat.lastSeen = now;
      next.set(native.id, entry);
      return { ...native, id: entry.id, assertionKey: key,
        occurrenceCount: stat.count, firstSeen: stat.firstSeen, lastSeen: now,
        repeated: stat.count >= 2, attemptState: entry.attempted ? "dispatched_or_unknown" : "not_attempted",
        canIgnore: !!native.ignore?.enabled && native.enabled !== false && !entry.attempted };
    });
    state.present = next;
    return assertions;
  }
  reserve(sessionId, id) {
    const entry = [...(this.sessions.get(sessionId)?.present.values() || [])].find(x => x.id === id);
    if (!entry) throw Error("ASSERT_CHANGED_OR_IGNORE_UNSUPPORTED");
    if (entry.attempted) throw Error("ASSERT_IGNORE_ALREADY_ATTEMPTED：请重新读取状态，不自动重放");
    entry.attempted = true;
    return entry.nativeId;
  }
  forget(sessionId) { this.sessions.delete(sessionId); }
}
module.exports = { AssertionTracker };
