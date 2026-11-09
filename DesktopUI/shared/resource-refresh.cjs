// 进度快照不等于资源变化；只消费新的相关事件及任务状态切换。
const methods = new Set([
  "settings.update", "project.save", "projects.add", "projects.remove", "projects.relocate", "project.backup",
  "profiles.create", "profiles.rename", "profiles.remove", "mods.save", "mods.remove", "mods.import-profiles", "mods.add-directories",
  "worlds.create", "worlds.update", "worlds.import", "worlds.rename", "worlds.recycle", "worlds.restore", "worlds.purge", "worlds.copy", "worlds.select",
  "worlds.sync-pack-versions", "worlds.rebind-pack-uuids", "worlds.edit-pack", "world-actions.save", "world-actions.run",
  "launch.start", "launch.quick", "launch.blank", "launch.joined", "launch.stop", "debug.restartLatest", "debug.execute", "debug.reload",
  "ui-editor.save", "ui-editor.save-as", "game-options.save",
  "architecture.prepare", "architecture.start-source", "architecture.save-source", "architecture.source-done", "architecture.start-target", "architecture.stop", "architecture.paste", "architecture.revoke",
  "rooms.create", "rooms.join", "rooms.close", "rooms.retry",
]);
function createActivityInvalidator() {
  let previous = new Map();
  return snapshot => {
    const next = new Map(); let changed = false;
    for (const event of snapshot.events || []) {
      if (!methods.has(event.method)) continue;
      const key = "event:" + event.id, value = event.lastTime || event.time || event.repeatCount || 1;
      next.set(key, value); if (previous.get(key) !== value) changed = true;
    }
    for (const task of snapshot.tasks || []) {
      if (!methods.has(task.method)) continue;
      const key = "task:" + task.id, value = task.status;
      next.set(key, value); if (previous.get(key) !== value) changed = true;
    }
    previous = next;
    return changed;
  };
}
function sameRecords(previous, next) {
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}
module.exports = { createActivityInvalidator, sameRecords };
