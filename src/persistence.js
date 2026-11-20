class GraphPersistence {
  constructor(snapshot, write, reportError, delayMs = 180) {
    this.snapshot = snapshot;
    this.write = write;
    this.reportError = reportError;
    this.delayMs = delayMs;
    this.dirty = false;
    this.timer = undefined;
    this.writing = undefined;
  }

  schedule() {
    this.dirty = true;
    if (this.writing) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.delayMs);
  }

  async flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.writing) {
      await this.writing;
      if (this.dirty) await this.flush();
      return;
    }
    if (!this.dirty) return;

    this.dirty = false;
    const state = this.snapshot();
    this.writing = Promise.resolve().then(() => this.write(state)).catch(error => {
      try {
        void Promise.resolve(this.reportError(error)).catch(() => {});
      } catch {
        // Failure to show a notification must not block later saves.
      }
    });
    await this.writing;
    this.writing = undefined;
    if (this.dirty) await this.flush();
  }
}

module.exports = { GraphPersistence };
