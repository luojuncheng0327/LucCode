import { useCallback, useEffect, useRef, useState } from 'react';

export type BridgeSecretDraftKey =
  | 'telegramToken'
  | 'feishuAppSecret'
  | 'dingtalkClientSecret'
  | 'qqAppSecret';

export interface BridgeSecretDraft {
  ownerId: string | null;
  value: string;
  dirty: boolean;
  revision: number;
  hasStored: boolean;
}

export type BridgeSecretDrafts = Record<BridgeSecretDraftKey, BridgeSecretDraft>;
export type StoredBridgeSecrets = Record<BridgeSecretDraftKey, boolean>;

export type BridgeCredentialFieldKey =
  | 'feishuAppId'
  | 'feishuRegion'
  | 'dingtalkCorpId'
  | 'dingtalkClientId'
  | 'dingtalkRobotCode'
  | 'dingtalkApiBaseUrl'
  | 'qqAppId';

export interface BridgeCredentialFieldDraft {
  ownerId: string | null;
  value: string;
  dirty: boolean;
  revision: number;
}

export type BridgeCredentialFieldDrafts = Record<BridgeCredentialFieldKey, BridgeCredentialFieldDraft>;
export type BridgeCredentialFieldValues = Record<BridgeCredentialFieldKey, string>;

export interface BridgeSecretSubmission {
  key: BridgeSecretDraftKey;
  ownerId: string | null;
  revision: number;
  hasStoredAfterSave: boolean;
}

export interface BridgeCredentialFieldSubmission {
  key: BridgeCredentialFieldKey;
  ownerId: string | null;
  revision: number;
}

const SECRET_KEYS: BridgeSecretDraftKey[] = [
  'telegramToken',
  'feishuAppSecret',
  'dingtalkClientSecret',
  'qqAppSecret',
];

const PLATFORM_SECRET_FIELDS: Partial<Record<string, {
  key: BridgeSecretDraftKey;
  field: string;
}>> = {
  telegram: { key: 'telegramToken', field: 'token' },
  feishu: { key: 'feishuAppSecret', field: 'appSecret' },
  dingtalk: { key: 'dingtalkClientSecret', field: 'clientSecret' },
  qq: { key: 'qqAppSecret', field: 'appSecret' },
};

const CREDENTIAL_FIELD_KEYS: BridgeCredentialFieldKey[] = [
  'feishuAppId',
  'feishuRegion',
  'dingtalkCorpId',
  'dingtalkClientId',
  'dingtalkRobotCode',
  'dingtalkApiBaseUrl',
  'qqAppId',
];

const PLATFORM_CREDENTIAL_FIELDS: Partial<Record<string, Record<string, BridgeCredentialFieldKey>>> = {
  feishu: { appId: 'feishuAppId', region: 'feishuRegion' },
  dingtalk: {
    corpId: 'dingtalkCorpId',
    clientId: 'dingtalkClientId',
    robotCode: 'dingtalkRobotCode',
    apiBaseUrl: 'dingtalkApiBaseUrl',
  },
  qq: { appID: 'qqAppId' },
};

export const EMPTY_STORED_BRIDGE_SECRETS: StoredBridgeSecrets = {
  telegramToken: false,
  feishuAppSecret: false,
  dingtalkClientSecret: false,
  qqAppSecret: false,
};

export const EMPTY_BRIDGE_CREDENTIAL_FIELDS: BridgeCredentialFieldValues = {
  feishuAppId: '',
  feishuRegion: 'feishu_cn',
  dingtalkCorpId: '',
  dingtalkClientId: '',
  dingtalkRobotCode: '',
  dingtalkApiBaseUrl: '',
  qqAppId: '',
};

function createDraft(ownerId: string | null, hasStored = false): BridgeSecretDraft {
  return {
    ownerId,
    value: '',
    dirty: false,
    revision: 0,
    hasStored,
  };
}

function createDrafts(
  ownerId: string | null,
  stored: StoredBridgeSecrets = EMPTY_STORED_BRIDGE_SECRETS,
): BridgeSecretDrafts {
  return {
    telegramToken: createDraft(ownerId, stored.telegramToken),
    feishuAppSecret: createDraft(ownerId, stored.feishuAppSecret),
    dingtalkClientSecret: createDraft(ownerId, stored.dingtalkClientSecret),
    qqAppSecret: createDraft(ownerId, stored.qqAppSecret),
  };
}

function belongsToOwner(drafts: BridgeSecretDrafts, ownerId: string | null) {
  return SECRET_KEYS.every(key => drafts[key].ownerId === ownerId);
}

function createCredentialFieldDrafts(
  ownerId: string | null,
  values: BridgeCredentialFieldValues = EMPTY_BRIDGE_CREDENTIAL_FIELDS,
): BridgeCredentialFieldDrafts {
  return Object.fromEntries(CREDENTIAL_FIELD_KEYS.map(key => [key, {
    ownerId,
    value: values[key],
    dirty: false,
    revision: 0,
  }])) as BridgeCredentialFieldDrafts;
}

function fieldsBelongToOwner(drafts: BridgeCredentialFieldDrafts, ownerId: string | null) {
  return CREDENTIAL_FIELD_KEYS.every(key => drafts[key].ownerId === ownerId);
}

/**
 * Owns all Bridge credential drafts. Secrets add `hasStored` and clear their
 * plaintext after save; non-secret fields retain their value. Both kinds use
 * owner + revision provenance so status/save responses cannot overwrite newer UI.
 */
export function useBridgeCredentialDrafts(
  ownerId: string | null,
  initialStored: StoredBridgeSecrets = EMPTY_STORED_BRIDGE_SECRETS,
  initialFields: BridgeCredentialFieldValues = EMPTY_BRIDGE_CREDENTIAL_FIELDS,
) {
  const ownerIdRef = useRef(ownerId);
  ownerIdRef.current = ownerId;
  // Revisions are monotonic for the full hook lifetime. Reusing revision 1
  // after A → B → A would let A's old in-flight save clear A's new draft.
  const nextRevisionRef = useRef(0);

  const [drafts, setDrafts] = useState<BridgeSecretDrafts>(() => (
    createDrafts(ownerId, initialStored)
  ));
  const visibleDrafts = belongsToOwner(drafts, ownerId)
    ? drafts
    : createDrafts(ownerId);
  const draftsRef = useRef(visibleDrafts);
  draftsRef.current = visibleDrafts;

  const [fieldDrafts, setFieldDrafts] = useState<BridgeCredentialFieldDrafts>(() => (
    createCredentialFieldDrafts(ownerId, initialFields)
  ));
  const visibleFieldDrafts = fieldsBelongToOwner(fieldDrafts, ownerId)
    ? fieldDrafts
    : createCredentialFieldDrafts(ownerId);
  const fieldDraftsRef = useRef(visibleFieldDrafts);
  fieldDraftsRef.current = visibleFieldDrafts;

  // Never expose the previous Agent's plaintext during the render before effects run.
  // The effect then makes that safe view the new canonical hook state.
  useEffect(() => {
    setDrafts(previous => {
      if (belongsToOwner(previous, ownerId)) return previous;
      const next = createDrafts(ownerId);
      draftsRef.current = next;
      return next;
    });
    setFieldDrafts(previous => {
      if (fieldsBelongToOwner(previous, ownerId)) return previous;
      const next = createCredentialFieldDrafts(ownerId);
      fieldDraftsRef.current = next;
      return next;
    });
  }, [ownerId]);

  const setSecretValue = useCallback((key: BridgeSecretDraftKey, value: string) => {
    const activeOwnerId = ownerIdRef.current;
    const revision = ++nextRevisionRef.current;
    const applyEdit = (previous: BridgeSecretDrafts) => {
      const active = belongsToOwner(previous, activeOwnerId)
        ? previous
        : createDrafts(activeOwnerId);
      return {
        ...active,
        [key]: {
          ...active[key],
          value,
          dirty: true,
          revision,
        },
      };
    };
    // Update provenance synchronously so a save started later in this same UI
    // event (for example a region select) captures the submitted revision.
    draftsRef.current = applyEdit(draftsRef.current);
    setDrafts(applyEdit);
  }, []);

  const setCredentialFieldValue = useCallback((key: BridgeCredentialFieldKey, value: string) => {
    const activeOwnerId = ownerIdRef.current;
    const revision = ++nextRevisionRef.current;
    const applyEdit = (previous: BridgeCredentialFieldDrafts) => {
      const active = fieldsBelongToOwner(previous, activeOwnerId)
        ? previous
        : createCredentialFieldDrafts(activeOwnerId);
      return {
        ...active,
        [key]: {
          ...active[key],
          value,
          dirty: true,
          revision,
        },
      };
    };
    fieldDraftsRef.current = applyEdit(fieldDraftsRef.current);
    setFieldDrafts(applyEdit);
  }, []);

  const syncStoredSecrets = useCallback((
    statusOwnerId: string | null,
    stored: StoredBridgeSecrets,
  ) => {
    // Status requests may finish after an Agent switch. They cannot mutate the
    // currently visible owner's drafts or stored-credential flags.
    if (statusOwnerId !== ownerIdRef.current) return;
    setDrafts(previous => {
      const active = belongsToOwner(previous, statusOwnerId)
        ? previous
        : createDrafts(statusOwnerId);
      let changed = false;
      const next = { ...active };
      for (const key of SECRET_KEYS) {
        const hasStored = stored[key] === true;
        if (active[key].hasStored === hasStored) continue;
        next[key] = { ...active[key], hasStored };
        changed = true;
      }
      if (!changed) {
        draftsRef.current = active;
        return active;
      }
      draftsRef.current = next;
      return next;
    });
  }, []);

  const syncCredentialFields = useCallback((
    statusOwnerId: string | null,
    values: BridgeCredentialFieldValues,
  ) => {
    if (statusOwnerId !== ownerIdRef.current) return;
    setFieldDrafts(previous => {
      const active = fieldsBelongToOwner(previous, statusOwnerId)
        ? previous
        : createCredentialFieldDrafts(statusOwnerId);
      let changed = false;
      const next = { ...active };
      for (const key of CREDENTIAL_FIELD_KEYS) {
        const current = active[key];
        if (current.dirty || current.value === values[key]) continue;
        next[key] = { ...current, value: values[key] };
        changed = true;
      }
      const result = changed ? next : active;
      fieldDraftsRef.current = result;
      return result;
    });
  }, []);

  const captureSubmission = useCallback((
    platform: string,
    credentials: Record<string, string> | null,
  ): BridgeSecretSubmission | null => {
    const binding = PLATFORM_SECRET_FIELDS[platform];
    if (!binding || !credentials || !Object.prototype.hasOwnProperty.call(credentials, binding.field)) {
      return null;
    }
    const current = draftsRef.current[binding.key];
    if (current.ownerId !== ownerIdRef.current || !current.dirty) return null;
    return {
      key: binding.key,
      ownerId: current.ownerId,
      revision: current.revision,
      hasStoredAfterSave: String(credentials[binding.field] || '').length > 0,
    };
  }, []);

  const captureFieldSubmissions = useCallback((
    platform: string,
    credentials: Record<string, string> | null,
  ): BridgeCredentialFieldSubmission[] => {
    const bindings = PLATFORM_CREDENTIAL_FIELDS[platform];
    if (!bindings || !credentials) return [];
    const submissions: BridgeCredentialFieldSubmission[] = [];
    for (const [field, key] of Object.entries(bindings)) {
      if (!Object.prototype.hasOwnProperty.call(credentials, field)) continue;
      const current = fieldDraftsRef.current[key];
      if (current.ownerId !== ownerIdRef.current || !current.dirty) continue;
      submissions.push({ key, ownerId: current.ownerId, revision: current.revision });
    }
    return submissions;
  }, []);

  const markSubmissionSaved = useCallback((submission: BridgeSecretSubmission | null) => {
    if (!submission) return;
    setDrafts(previous => {
      if (!belongsToOwner(previous, submission.ownerId)) return previous;
      const current = previous[submission.key];
      if (current.revision !== submission.revision) return previous;
      const next = {
        ...previous,
        [submission.key]: {
          ...current,
          value: '',
          dirty: false,
          hasStored: submission.hasStoredAfterSave,
        },
      };
      draftsRef.current = next;
      return next;
    });
  }, []);

  const markFieldSubmissionsSaved = useCallback((submissions: BridgeCredentialFieldSubmission[]) => {
    if (submissions.length === 0) return;
    setFieldDrafts(previous => {
      let next = previous;
      for (const submission of submissions) {
        if (!fieldsBelongToOwner(next, submission.ownerId)) continue;
        const current = next[submission.key];
        if (current.revision !== submission.revision) continue;
        next = {
          ...next,
          [submission.key]: { ...current, dirty: false },
        };
      }
      fieldDraftsRef.current = next;
      return next;
    });
  }, []);

  const setTelegramToken = useCallback((value: string) => {
    setSecretValue('telegramToken', value);
  }, [setSecretValue]);
  const setFeishuAppSecret = useCallback((value: string) => {
    setSecretValue('feishuAppSecret', value);
  }, [setSecretValue]);
  const setDingTalkClientSecret = useCallback((value: string) => {
    setSecretValue('dingtalkClientSecret', value);
  }, [setSecretValue]);
  const setQQAppSecret = useCallback((value: string) => {
    setSecretValue('qqAppSecret', value);
  }, [setSecretValue]);
  const setFeishuAppId = useCallback((value: string) => {
    setCredentialFieldValue('feishuAppId', value);
  }, [setCredentialFieldValue]);
  const setFeishuRegion = useCallback((value: string) => {
    setCredentialFieldValue('feishuRegion', value);
  }, [setCredentialFieldValue]);
  const setDingTalkCorpId = useCallback((value: string) => {
    setCredentialFieldValue('dingtalkCorpId', value);
  }, [setCredentialFieldValue]);
  const setDingTalkClientId = useCallback((value: string) => {
    setCredentialFieldValue('dingtalkClientId', value);
  }, [setCredentialFieldValue]);
  const setDingTalkRobotCode = useCallback((value: string) => {
    setCredentialFieldValue('dingtalkRobotCode', value);
  }, [setCredentialFieldValue]);
  const setDingTalkApiBaseUrl = useCallback((value: string) => {
    setCredentialFieldValue('dingtalkApiBaseUrl', value);
  }, [setCredentialFieldValue]);
  const setQQAppId = useCallback((value: string) => {
    setCredentialFieldValue('qqAppId', value);
  }, [setCredentialFieldValue]);

  return {
    drafts: visibleDrafts,
    fields: visibleFieldDrafts,
    setTelegramToken,
    setFeishuAppSecret,
    setDingTalkClientSecret,
    setQQAppSecret,
    setFeishuAppId,
    setFeishuRegion,
    setDingTalkCorpId,
    setDingTalkClientId,
    setDingTalkRobotCode,
    setDingTalkApiBaseUrl,
    setQQAppId,
    syncStoredSecrets,
    syncCredentialFields,
    captureSubmission,
    captureFieldSubmissions,
    markSubmissionSaved,
    markFieldSubmissionsSaved,
  };
}
