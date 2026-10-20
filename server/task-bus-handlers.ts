export function registerTaskRegistryBusHandlers(eventBus, taskRegistry) {
  eventBus.handle("task:register-handler", ({ type, abort, run }) => {
    const handler: { abort: any; run?: any } = { abort };
    if (run !== undefined) handler.run = run;
    taskRegistry.registerHandler(type, handler);
    return { ok: true };
  });
  eventBus.handle("task:unregister-handler", ({ type }) => {
    taskRegistry.unregisterHandler(type);
    return { ok: true };
  });
  eventBus.handle("task:register", ({ taskId, type, parentSessionPath, parentSessionId, parentSessionRef, sessionId, sessionRef, legacySessionPath, meta, pluginId, agentId, persist }) => {
    taskRegistry.register(taskId, {
      type,
      parentSessionPath,
      parentSessionId,
      parentSessionRef,
      sessionId,
      sessionRef,
      legacySessionPath,
      meta,
      pluginId,
      agentId,
      persist,
    });
    return { ok: true };
  });
  eventBus.handle("task:update", ({ taskId, ...patch }) => {
    return { ok: true, task: taskRegistry.update(taskId, patch) };
  });
  eventBus.handle("task:complete", ({ taskId, result }) => {
    return { ok: true, task: taskRegistry.complete(taskId, result) };
  });
  eventBus.handle("task:fail", ({ taskId, reason, error }) => {
    return { ok: true, task: taskRegistry.fail(taskId, reason ?? error) };
  });
  eventBus.handle("task:remove", ({ taskId }) => {
    taskRegistry.remove(taskId);
    return { ok: true };
  });
  eventBus.handle("task:query", ({ taskId }) => {
    return taskRegistry.query(taskId);
  });
  eventBus.handle("task:list", (filter = {}) => {
    return taskRegistry.listAll(filter);
  });
  eventBus.handle("task:abort", ({ taskId }) => {
    return { result: taskRegistry.abort(taskId) };
  });
  eventBus.handle("task:cancel", ({ taskId, reason }) => {
    return taskRegistry.cancel(taskId, reason);
  });
  eventBus.handle("task:schedule", ({ scheduleId, ...input }) => {
    return { ok: true, schedule: taskRegistry.schedule(scheduleId, input) };
  });
  eventBus.handle("task:unschedule", ({ scheduleId }) => {
    return { ok: true, removed: taskRegistry.unschedule(scheduleId) };
  });
  eventBus.handle("task:list-schedules", (filter = {}) => {
    return taskRegistry.listSchedules(filter);
  });
}
