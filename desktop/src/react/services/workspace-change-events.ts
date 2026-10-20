import type { WorkspaceChangePayload } from '../types';

type WorkspaceChangeHandler = (payload: WorkspaceChangePayload) => void;

export function subscribeWorkspaceChanges(_handler: WorkspaceChangeHandler): () => void {
  return () => {};
}
