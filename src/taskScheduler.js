"use strict";

class TaskScheduler {
  constructor() {
    this.tasksByTag = new Map();
  }

  scheduleDelayed(callback, delayMs, tag = "") {
    if (tag) {
      this.cancelByTag(tag);
    }

    const timeoutId = setTimeout(() => {
      if (tag) {
        this.tasksByTag.delete(tag);
      }

      try {
        callback();
      } catch {
        // Ignore user callback failures to keep scheduler loop alive.
      }
    }, delayMs);

    if (tag) {
      this.tasksByTag.set(tag, timeoutId);
    }

    return timeoutId;
  }

  cancelByTag(tag) {
    const timeoutId = this.tasksByTag.get(tag);
    if (!timeoutId) {
      return false;
    }

    clearTimeout(timeoutId);
    this.tasksByTag.delete(tag);
    return true;
  }

  cancelAll() {
    for (const timeoutId of this.tasksByTag.values()) {
      clearTimeout(timeoutId);
    }

    this.tasksByTag.clear();
  }
}

module.exports = {
  TaskScheduler
};
