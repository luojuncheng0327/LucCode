import { sessionScopedKey, sessionScopedValue } from './session-slice';

export interface SelectionSlice {
  selectedIdsBySession: Record<string, string[]>;
  toggleMessageSelection: (sessionPath: string, messageId: string) => void;
  setMessageSelection: (sessionPath: string, messageIds: string[]) => void;
  addMessagesToSelection: (sessionPath: string, messageIds: string[]) => void;
  clearSelection: (sessionPath: string) => void;
}

export const createSelectionSlice = (
  set: (partial: Partial<SelectionSlice> | ((s: SelectionSlice) => Partial<SelectionSlice>)) => void,
): SelectionSlice => ({
  selectedIdsBySession: {},

  toggleMessageSelection: (sessionPath, messageId) => set((s) => {
    const key = sessionScopedKey(s as any, sessionPath) || sessionPath;
    const current = sessionScopedValue(s as any, s.selectedIdsBySession, sessionPath) || [];
    const next = current.includes(messageId)
      ? current.filter(id => id !== messageId)
      : [...current, messageId];
    const copy = { ...s.selectedIdsBySession };
    delete copy[sessionPath];
    if (next.length === 0) delete copy[key];
    else copy[key] = next;
    return {
      selectedIdsBySession: copy,
    };
  }),

  setMessageSelection: (sessionPath, messageIds) => set((s) => {
    const key = sessionScopedKey(s as any, sessionPath) || sessionPath;
    const next = Array.from(new Set(messageIds.filter(Boolean)));
    const copy = { ...s.selectedIdsBySession };
    delete copy[sessionPath];
    if (next.length === 0) delete copy[key];
    else copy[key] = next;
    return { selectedIdsBySession: copy };
  }),

  addMessagesToSelection: (sessionPath, messageIds) => set((s) => {
    const key = sessionScopedKey(s as any, sessionPath) || sessionPath;
    const current = sessionScopedValue(s as any, s.selectedIdsBySession, sessionPath) || [];
    const next = Array.from(new Set([...current, ...messageIds.filter(Boolean)]));
    const copy = { ...s.selectedIdsBySession };
    delete copy[sessionPath];
    if (next.length === 0) delete copy[key];
    else copy[key] = next;
    return { selectedIdsBySession: copy };
  }),

  clearSelection: (sessionPath) => set((s) => {
    const key = sessionScopedKey(s as any, sessionPath) || sessionPath;
    const copy = { ...s.selectedIdsBySession };
    delete copy[key];
    delete copy[sessionPath];
    return { selectedIdsBySession: copy };
  }),
});
