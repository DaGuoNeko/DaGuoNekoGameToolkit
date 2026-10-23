const { watch } = require("node:fs");

// Watch only this launch's owned pack directories. Reloads share the controller's
// normal serialization, generation checks, incremental scan and official xupdate.
class EmbeddedReloader {
  constructor(
    directories,
    { target, reload, report, watchDirectory = watch, delay = 600 },
  ) {
    this.target = target;
    this.reload = reload;
    this.report = report;
    this.delay = delay;
    this.watchers = [];
    this.pending = false;
    this.closed = false;
    this.running = false;
    try {
      for (const dir of new Set(directories)) {
        const watcher = watchDirectory(
          dir,
          { recursive: true, persistent: false },
          (_event, filename) => {
            if (filename == null || /\.py$/i.test(String(filename)))
              this.changed();
          },
        );
        watcher.on("error", (error) => {
          this.close();
          this.report({ error: "自动热更新监听已停止：" + error.message });
        });
        this.watchers.push(watcher);
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }
  changed() {
    if (this.closed) return;
    this.pending = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delay);
    this.timer.unref?.();
  }
  resume() {
    if (this.pending && !this.running && !this.closed && !this.timer)
      this.changed();
  }
  async flush() {
    this.timer = null;
    if (this.closed || this.running || !this.pending) return;
    const target = this.target();
    if (!target) return;
    this.pending = false;
    this.running = true;
    try {
      const result = await this.reload(target);
      if (!this.closed) this.report({ result });
    } catch (error) {
      // An ambiguous timeout must never replay the same change automatically.
      this.pending = false;
      clearTimeout(this.timer);
      this.timer = null;
      if (!this.closed)
        this.report({
          error:
            "自带模组自动热更新未完成：" +
            error.message +
            "；请检查后手动热更新",
        });
    } finally {
      this.running = false;
      this.resume();
    }
  }
  close() {
    this.closed = true;
    this.pending = false;
    clearTimeout(this.timer);
    this.timer = null;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }
}
module.exports = { EmbeddedReloader };
