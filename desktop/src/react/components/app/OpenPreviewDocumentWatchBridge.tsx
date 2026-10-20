import { useEffect, useMemo, useRef } from 'react';
import { useStore } from '../../stores';
import { resourceWatchKey, retainResourceWatch } from '../../services/resource-events';
import {
  PREVIEW_DOCUMENT_CATCH_UP_REFRESH_OPTIONS,
  openPreviewDocumentWatchResources,
  refreshPreviewDocumentTarget,
} from '../../utils/preview-document-refresh';

export function OpenPreviewDocumentWatchBridge() {
  const previewItems = useStore(s => s.previewItems);
  const openTabs = useStore(s => s.openTabs);
  const deskBasePath = useStore(s => s.deskBasePath);
  const deskWorkspaceMountId = useStore(s => s.deskWorkspaceMountId);
  const deskWorkspaceNativeRoot = useStore(s => s.deskWorkspaceNativeRoot);
  const studioWorkspaces = useStore(s => s.studioWorkspaces);
  const subscriptionsRef = useRef<Map<string, () => void>>(new Map());
  const watchResources = useMemo(
    () => openPreviewDocumentWatchResources(),
    [previewItems, openTabs, deskBasePath, deskWorkspaceMountId, deskWorkspaceNativeRoot, studioWorkspaces],
  );
  const watchResourcesKey = watchResources.map(item => resourceWatchKey(item.ref)).join('\n');

  useEffect(() => {
    const nextKeys = new Set(watchResources.map(item => resourceWatchKey(item.ref)));
    for (const [key, unsubscribe] of subscriptionsRef.current) {
      if (nextKeys.has(key)) continue;
      unsubscribe();
      subscriptionsRef.current.delete(key);
    }

    for (const item of watchResources) {
      const key = resourceWatchKey(item.ref);
      if (!subscriptionsRef.current.has(key)) {
        subscriptionsRef.current.set(key, retainResourceWatch(item.ref));
      }
      void refreshPreviewDocumentTarget(
        item.target,
        PREVIEW_DOCUMENT_CATCH_UP_REFRESH_OPTIONS,
      ).catch((err) => {
        console.warn('[preview-resource] catch-up refresh failed:', item.ref, err);
      });
    }
  }, [watchResourcesKey]); // eslint-disable-line react-hooks/exhaustive-deps -- watchResourcesKey is the reconciled subscription identity.

  useEffect(() => () => {
    for (const unsubscribe of subscriptionsRef.current.values()) unsubscribe();
    subscriptionsRef.current.clear();
  }, []);

  return null;
}
