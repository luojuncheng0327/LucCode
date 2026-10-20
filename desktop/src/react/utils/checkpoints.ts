import { lucFetch } from '../hooks/use-luc-fetch';

export type UserEditCheckpointReason = 'edit-start' | 'autosave-interval';

export async function requestUserEditCheckpoint(
  filePath: string,
  reason: UserEditCheckpointReason,
): Promise<void> {
  await lucFetch('/api/checkpoints/user-edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filePath, reason }),
  });
}
