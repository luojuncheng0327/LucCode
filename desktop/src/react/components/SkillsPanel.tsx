import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../stores';
import { usePanel } from '../hooks/use-panel';
import { lucFetch } from '../hooks/use-luc-fetch';
import { AgentAvatar, resolveAgentDisplayInfo } from '../utils/agent-display';
import { SkillBundleTree, type SkillBundleInfo } from '../settings/tabs/skills/SkillBundleTree';
import type { SkillInfo } from '../settings/store';
import { AgentTabScroller, type AgentTabScrollerItem } from './automation/AgentTabScroller';
import fp from './FloatingPanels.module.css';
import settingsStyles from '../settings/Settings.module.css';
import automationStyles from './automation/AutomationPanel.module.css';
import styles from './SkillsPanel.module.css';

const ALL_SKILLS_TAB = '__all_skills__';
const HIGHLIGHT_MS = 1800;

type Translator = (key: string, params?: Record<string, string | number>) => string;
const fallbackTranslator: Translator = (key: string) => key;

type HighlightState = {
  skillName: string | null;
  bundleId: string | null;
};

type BundleDialogState =
  | { type: 'create'; name: string }
  | { type: 'rename'; bundle: SkillBundleInfo; name: string }
  | { type: 'delete'; bundle: SkillBundleInfo };

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' ? value as JsonObject : null;
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function readJsonObject(response: Response): Promise<JsonObject> {
  return asObject(await response.json()) || {};
}

function responseError(data: JsonObject): string | null {
  return stringField(data.error);
}

function skillListField(data: JsonObject): SkillInfo[] {
  return Array.isArray(data.skills) ? data.skills as SkillInfo[] : [];
}

function bundleListField(data: JsonObject): SkillBundleInfo[] {
  return Array.isArray(data.bundles) ? data.bundles as SkillBundleInfo[] : [];
}

function isFileTransfer(dataTransfer: DataTransfer): boolean {
  return dataTransfer.files.length > 0 || Array.from(dataTransfer.types).includes('Files');
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('failed to read file'));
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.includes(',') ? result.split(',').pop() || '' : result);
    };
    reader.readAsDataURL(file);
  });
}

function firstUsableAgentId(agents: Array<{ id: string; isPrimary?: boolean }>, currentAgentId: string | null): string | null {
  return currentAgentId || agents.find(agent => agent.isPrimary)?.id || agents[0]?.id || null;
}

function installedSkillName(data: JsonObject): string | null {
  const skill = asObject(data.skill);
  const installed = asObject(data.installed);
  return stringField(skill?.name) || stringField(data.name) || stringField(installed?.name);
}

function installedBundleId(data: JsonObject): string | null {
  const bundle = asObject(data.bundle);
  const skillBundle = asObject(data.skillBundle);
  return stringField(bundle?.id) || stringField(skillBundle?.id);
}

function UploadIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function AllSkillsAvatar() {
  return (
    <span className={styles.allAvatar} aria-hidden="true">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.5766 8.70419C11.2099 7.56806 11.5266 7 12 7C12.4734 7 12.7901 7.56806 13.4234 8.70419L13.5873 8.99812C13.7672 9.32097 13.8572 9.48239 13.9975 9.5889C14.1378 9.69541 14.3126 9.73495 14.6621 9.81402L14.9802 9.88601C16.2101 10.1643 16.825 10.3034 16.9713 10.7739C17.1176 11.2443 16.6984 11.7345 15.86 12.715L15.643 12.9686C15.4048 13.2472 15.2857 13.3865 15.2321 13.5589C15.1785 13.7312 15.1965 13.9171 15.2325 14.2888L15.2653 14.6272C15.3921 15.9353 15.4554 16.5894 15.0724 16.8801C14.6894 17.1709 14.1137 16.9058 12.9622 16.3756L12.6643 16.2384C12.337 16.0878 12.1734 16.0124 12 16.0124C11.8266 16.0124 11.663 16.0878 11.3357 16.2384L11.0378 16.3756C9.88634 16.9058 9.31059 17.1709 8.92757 16.8801C8.54456 16.5894 8.60794 15.9353 8.7347 14.6272L8.76749 14.2888C8.80351 13.9171 8.82152 13.7312 8.76793 13.5589C8.71434 13.3865 8.59521 13.2472 8.35696 12.9686L8.14005 12.715C7.30162 11.7345 6.88241 11.2443 7.02871 10.7739C7.17501 10.3034 7.78993 10.1643 9.01977 9.88601L9.33794 9.81402C9.68743 9.73495 9.86217 9.69541 10.0025 9.5889C10.1428 9.48239 10.2328 9.32097 10.4127 8.99812L10.5766 8.70419Z" />
        <path opacity="0.5" d="M12 2V4" />
        <path opacity="0.5" d="M12 20V22" />
        <path opacity="0.5" d="M2 12L4 12" />
        <path opacity="0.5" d="M20 12L22 12" />
        <path d="M6 18L6.34305 17.657" />
        <path d="M17.6567 6.34326L18 6" />
        <path d="M18 18L17.657 17.657" />
        <path d="M6.34326 6.34326L6 6" />
      </svg>
    </span>
  );
}

export function SkillsPanel() {
  const agents = useStore(s => s.agents);
  const currentAgentId = useStore(s => s.currentAgentId);
  const agentName = useStore(s => s.agentName);
  const agentYuan = useStore(s => s.agentYuan);
  const agentAvatarUrl = useStore(s => s.agentAvatarUrl);
  const addToast = useStore(s => s.addToast);
  const t = useCallback<Translator>((key, params) => {
    const translate = (window.t ?? fallbackTranslator) as Translator;
    return translate(key, params);
  }, []);

  const [selectedTabId, setSelectedTabId] = useState<string>(ALL_SKILLS_TAB);
  const [allViewAgentId, setAllViewAgentId] = useState<string | null>(firstUsableAgentId(agents, currentAgentId));
  const [skillsList, setSkillsList] = useState<SkillInfo[]>([]);
  const [skillBundles, setSkillBundles] = useState<SkillBundleInfo[]>([]);
  const [loadedAgentId, setLoadedAgentId] = useState<string | null>(null);
  const [bundleExpandedByAgent, setBundleExpandedByAgent] = useState<Record<string, Record<string, boolean>>>({});
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [highlight, setHighlight] = useState<HighlightState>({ skillName: null, bundleId: null });
  const [bundleDialog, setBundleDialog] = useState<BundleDialogState | null>(null);
  const skillFileInputRef = useRef<HTMLInputElement | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedAgentIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (allViewAgentId || !currentAgentId) return;
    setAllViewAgentId(currentAgentId);
  }, [allViewAgentId, currentAgentId]);

  useEffect(() => () => {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
  }, []);

  const selectedAgentId = selectedTabId === ALL_SKILLS_TAB
    ? (allViewAgentId || firstUsableAgentId(agents, currentAgentId))
    : selectedTabId;
  selectedAgentIdRef.current = selectedAgentId;

  const loadSkillsForAgent = useCallback(async (agentId: string | null) => {
    if (!agentId) {
      setSkillsList([]);
      setSkillBundles([]);
      setLoadedAgentId(null);
      return;
    }
    setLoading(true);
    try {
      const [skillsRes, bundlesRes] = await Promise.all([
        lucFetch(`/api/skills?agentId=${encodeURIComponent(agentId)}&runtime=1`),
        lucFetch(`/api/skills/bundles?agentId=${encodeURIComponent(agentId)}`),
      ]);
      const data = await readJsonObject(skillsRes);
      const bundleData = await readJsonObject(bundlesRes);
      const skillError = responseError(data);
      const bundleError = responseError(bundleData);
      if (skillError) throw new Error(skillError);
      if (bundleError) throw new Error(bundleError);
      setSkillsList(skillListField(data));
      setSkillBundles(bundleListField(bundleData));
      setLoadedAgentId(agentId);
    } catch (err) {
      console.error('[skills-panel] load failed:', err);
      addToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setLoading(false);
    }
  }, [addToast, t]);

  const { visible, close } = usePanel('skills');

  useEffect(() => {
    if (!visible) return;
    void loadSkillsForAgent(selectedAgentId);
  }, [loadSkillsForAgent, selectedAgentId, visible]);

  const agentTabItems = useMemo<AgentTabScrollerItem[]>(() => {
    const allLabel = t('skills.panel.allTab');
    return [
      {
        id: ALL_SKILLS_TAB,
        label: allLabel,
        avatar: <AllSkillsAvatar />,
      },
      ...agents.map(agent => {
        const info = resolveAgentDisplayInfo({
          id: agent.id,
          agents,
          fallbackAgentName: agentName,
          fallbackAgentYuan: agentYuan,
          fallbackAgentAvatarUrl: agentAvatarUrl,
        });
        return {
          id: agent.id,
          label: info.displayName,
          avatar: <AgentAvatar info={info} className={automationStyles.agentTabAvatar} />,
        };
      }),
    ];
  }, [agentAvatarUrl, agentName, agentYuan, agents, t]);

  const visibleSkills = skillsList.filter(skill => !skill.hidden);
  const userSkills = visibleSkills.filter(skill => skill.source !== 'external');
  const manageableSkills = userSkills.filter(skill => skill.source !== 'workspace' && skill.managedBy !== 'workspace' && skill.managedBy !== 'plugin');
  const canManage = selectedTabId === ALL_SKILLS_TAB;
  const treeSkills = canManage ? manageableSkills : userSkills;
  const hasLoadedTreeItems = treeSkills.length > 0 || skillBundles.length > 0;
  const shouldShowInitialLoading = loading && !(loadedAgentId === selectedAgentId && hasLoadedTreeItems);
  const bundleExpandedState = selectedAgentId ? (bundleExpandedByAgent[selectedAgentId] || {}) : {};
  const setSelectedBundleExpandedState = useCallback((next: Record<string, boolean>) => {
    if (!selectedAgentId) return;
    setBundleExpandedByAgent(prev => ({ ...prev, [selectedAgentId]: next }));
  }, [selectedAgentId]);

  const flashInstalled = useCallback((next: HighlightState) => {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    setHighlight(next);
    highlightTimerRef.current = setTimeout(() => {
      setHighlight({ skillName: null, bundleId: null });
      highlightTimerRef.current = null;
    }, HIGHLIGHT_MS);
  }, []);

  const installTargetAgentId = useCallback(() => {
    if (selectedTabId !== ALL_SKILLS_TAB) return selectedTabId;
    return firstUsableAgentId(agents, currentAgentId);
  }, [agents, currentAgentId, selectedTabId]);

  const installSkillFromPath = useCallback(async (filePath: string) => {
    const targetAgentId = installTargetAgentId();
    if (!targetAgentId) {
      addToast(t('settings.skills.installError') + ': no current agent', 'error');
      return;
    }
    try {
      const res = await lucFetch(`/api/skills/install?agentId=${encodeURIComponent(targetAgentId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath }),
      });
      const data = await readJsonObject(res);
      const error = responseError(data);
      if (error) throw new Error(error);
      const skillName = installedSkillName(data);
      const bundleId = installedBundleId(data);
      setAllViewAgentId(targetAgentId);
      setSelectedTabId(ALL_SKILLS_TAB);
      await loadSkillsForAgent(targetAgentId);
      flashInstalled({ skillName, bundleId });
      addToast(t('settings.skills.installSuccess', { name: skillName || '' }), 'success');
    } catch (err) {
      addToast(t('settings.skills.installError') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  }, [addToast, flashInstalled, installTargetAgentId, loadSkillsForAgent, t]);

  const installSkillFromFile = useCallback(async (file: File) => {
    const filePath = window.platform?.getFilePath?.(file) || (file as File & { path?: string })?.path;
    if (filePath) {
      await installSkillFromPath(filePath);
      return;
    }
    const targetAgentId = installTargetAgentId();
    if (!targetAgentId) {
      addToast(t('settings.skills.installError') + ': no current agent', 'error');
      return;
    }
    try {
      const contentBase64 = await fileToBase64(file);
      const res = await lucFetch(`/api/skills/install?agentId=${encodeURIComponent(targetAgentId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file: {
            filename: file.name || 'skill.skill',
            contentBase64,
          },
        }),
      });
      const data = await readJsonObject(res);
      const error = responseError(data);
      if (error) throw new Error(error);
      const skillName = installedSkillName(data);
      const bundleId = installedBundleId(data);
      setAllViewAgentId(targetAgentId);
      setSelectedTabId(ALL_SKILLS_TAB);
      await loadSkillsForAgent(targetAgentId);
      flashInstalled({ skillName, bundleId });
      addToast(t('settings.skills.installSuccess', { name: skillName || '' }), 'success');
    } catch (err) {
      addToast(t('settings.skills.installError') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  }, [addToast, flashInstalled, installSkillFromPath, installTargetAgentId, loadSkillsForAgent, t]);

  const installSkill = useCallback(async () => {
    if (typeof window.platform?.selectSkill === 'function') {
      const selectedPath = await window.platform.selectSkill();
      if (!selectedPath) return;
      await installSkillFromPath(selectedPath);
      return;
    }
    skillFileInputRef.current?.click();
  }, [installSkillFromPath]);

  const handleDropCapture = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const file = event.dataTransfer.files?.[0] || null;
    if (!file) return;
    event.preventDefault();
    event.stopPropagation();
    setDragOver(false);
    void installSkillFromFile(file);
  }, [installSkillFromFile]);

  const handleDragOverCapture = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!isFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    setDragOver(true);
  }, []);

  const deleteSkill = useCallback(async (name: string) => {
    const agentId = selectedAgentId;
    if (!agentId) {
      addToast(t('settings.saveFailed') + ': no agent selected', 'error');
      return;
    }
    if (!confirm(t('settings.skills.deleteConfirm', { name }))) return;
    try {
      const res = await lucFetch(`/api/skills/${encodeURIComponent(name)}?agentId=${encodeURIComponent(agentId)}`, {
        method: 'DELETE',
      });
      const data = await readJsonObject(res);
      const error = responseError(data);
      if (error) throw new Error(error);
      await loadSkillsForAgent(agentId);
      addToast(t('settings.autoSaved'), 'success');
    } catch (err) {
      addToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  }, [addToast, loadSkillsForAgent, selectedAgentId, t]);

  const toggleSkill = useCallback(async (name: string, enable: boolean) => {
    const agentId = selectedAgentId;
    if (!agentId) return;
    const snapshotSkills = skillsList;
    setSkillsList(skillsList.map(skill => skill.name === name ? { ...skill, enabled: enable } : skill));

    try {
      const res = await lucFetch(`/api/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: enable }),
      });
      const data = await readJsonObject(res);
      const error = responseError(data);
      if (error) throw new Error(error);
      if (selectedAgentIdRef.current === agentId) {
        addToast(t('settings.autoSaved'), 'success');
        await loadSkillsForAgent(agentId);
      }
    } catch (err) {
      if (selectedAgentIdRef.current === agentId) {
        setSkillsList(snapshotSkills);
        addToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
        await loadSkillsForAgent(agentId);
      }
    }
  }, [addToast, loadSkillsForAgent, selectedAgentId, skillsList, t]);

  const toggleBundle = useCallback(async (bundle: SkillBundleInfo, enable: boolean) => {
    const agentId = selectedAgentId;
    if (!agentId) return;
    const snapshotSkills = skillsList;
    const snapshotBundles = skillBundles;
    const bundleSkillNames = new Set(bundle.skillNames);
    setSkillsList(skillsList.map(skill => bundleSkillNames.has(skill.name) ? { ...skill, enabled: enable } : skill));
    setSkillBundles(skillBundles.map(item => item.id === bundle.id
      ? {
          ...item,
          skills: item.skills?.map(skill => bundleSkillNames.has(skill.name)
            ? { ...skill, enabled: enable }
            : skill),
        }
      : item));

    try {
      const res = await lucFetch(`/api/agents/${encodeURIComponent(agentId)}/skill-bundles/${encodeURIComponent(bundle.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: enable }),
      });
      const data = await readJsonObject(res);
      const error = responseError(data);
      if (error) throw new Error(error);
      if (selectedAgentIdRef.current === agentId) {
        addToast(t('settings.autoSaved'), 'success');
        await loadSkillsForAgent(agentId);
      }
    } catch (err) {
      if (selectedAgentIdRef.current === agentId) {
        setSkillsList(snapshotSkills);
        setSkillBundles(snapshotBundles);
        addToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
        await loadSkillsForAgent(agentId);
      }
    }
  }, [addToast, loadSkillsForAgent, selectedAgentId, skillBundles, skillsList, t]);

  const createBundle = useCallback(() => {
    setBundleDialog({ type: 'create', name: 'New Bundle' });
  }, []);

  const submitCreateBundle = useCallback(async (name: string) => {
    const agentId = selectedAgentId;
    if (!agentId) return;
    try {
      const res = await lucFetch(`/api/skills/bundles?agentId=${encodeURIComponent(agentId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, skillNames: [] }),
      });
      const data = await readJsonObject(res);
      const error = responseError(data);
      if (error) throw new Error(error);
      setBundleDialog(null);
      addToast(t('settings.autoSaved'), 'success');
      await loadSkillsForAgent(agentId);
    } catch (err) {
      addToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  }, [addToast, loadSkillsForAgent, selectedAgentId, t]);

  const renameBundle = useCallback((bundle: SkillBundleInfo) => {
    setBundleDialog({ type: 'rename', bundle, name: bundle.name });
  }, []);

  const submitRenameBundle = useCallback(async (bundle: SkillBundleInfo, name: string) => {
    const agentId = selectedAgentId;
    if (!agentId || !name || name === bundle.name) return;
    try {
      const res = await lucFetch(`/api/skills/bundles/${encodeURIComponent(bundle.id)}?agentId=${encodeURIComponent(agentId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await readJsonObject(res);
      const error = responseError(data);
      if (error) throw new Error(error);
      setBundleDialog(null);
      addToast(t('settings.autoSaved'), 'success');
      await loadSkillsForAgent(agentId);
    } catch (err) {
      addToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  }, [addToast, loadSkillsForAgent, selectedAgentId, t]);

  const deleteBundle = useCallback((bundle: SkillBundleInfo) => {
    setBundleDialog({ type: 'delete', bundle });
  }, []);

  const exportBundle = useCallback(async (bundle: SkillBundleInfo) => {
    try {
      const res = await lucFetch(`/api/skills/bundles/${encodeURIComponent(bundle.id)}/export`, {
        method: 'POST',
      });
      const data = await readJsonObject(res);
      const error = responseError(data);
      if (error) throw new Error(error);
      const warnings = Array.isArray(data.warnings) ? data.warnings : [];
      const fileName = stringField(data.fileName) || bundle.name;
      const msg = warnings.length > 0
        ? t('settings.skills.exportedWithSkipped', { fileName, count: String(warnings.length) })
        : t('settings.skills.exported', { fileName });
      addToast(msg, 'success');
      const filePath = stringField(data.filePath);
      if (filePath) window.platform?.showInFinder?.(filePath);
    } catch (err) {
      addToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  }, [addToast, t]);

  const submitDeleteBundle = useCallback(async (bundle: SkillBundleInfo) => {
    const agentId = selectedAgentId;
    try {
      const res = await lucFetch(`/api/skills/bundles/${encodeURIComponent(bundle.id)}`, {
        method: 'DELETE',
      });
      const data = await readJsonObject(res);
      const error = responseError(data);
      if (error) throw new Error(error);
      setBundleDialog(null);
      addToast(t('settings.autoSaved'), 'success');
      await loadSkillsForAgent(agentId);
    } catch (err) {
      addToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  }, [addToast, loadSkillsForAgent, selectedAgentId, t]);

  const submitBundleDialog = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    if (!bundleDialog) return;
    if (bundleDialog.type === 'delete') {
      await submitDeleteBundle(bundleDialog.bundle);
    } else if (bundleDialog.type === 'create') {
      await submitCreateBundle(bundleDialog.name.trim());
    } else {
      await submitRenameBundle(bundleDialog.bundle, bundleDialog.name.trim());
    }
  }, [bundleDialog, submitCreateBundle, submitDeleteBundle, submitRenameBundle]);

  const updateBundleSkillNames = useCallback(async (bundle: SkillBundleInfo, skillNames: string[]) => {
    const agentId = selectedAgentId;
    if (!agentId) return;
    const res = await lucFetch(`/api/skills/bundles/${encodeURIComponent(bundle.id)}?agentId=${encodeURIComponent(agentId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skillNames }),
    });
    const data = await readJsonObject(res);
    const error = responseError(data);
    if (error) throw new Error(error);
  }, [selectedAgentId]);

  const reorderBundles = useCallback(async (bundleIds: string[]) => {
    const agentId = selectedAgentId;
    if (!agentId) return;
    try {
      const res = await lucFetch(`/api/skills/bundles/order?agentId=${encodeURIComponent(agentId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bundleIds }),
      });
      const data = await readJsonObject(res);
      const error = responseError(data);
      if (error) throw new Error(error);
      setSkillBundles(bundleListField(data));
      await loadSkillsForAgent(agentId);
      addToast(t('settings.autoSaved'), 'success');
    } catch (err) {
      addToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
      await loadSkillsForAgent(agentId);
    }
  }, [addToast, loadSkillsForAgent, selectedAgentId, t]);

  const moveSkillToBundle = useCallback(async (skillName: string, targetBundle: SkillBundleInfo, targetIndex?: number) => {
    const agentId = selectedAgentId;
    if (!agentId) return;
    try {
      const updates: Promise<void>[] = [];
      for (const bundle of skillBundles) {
        const hasSkill = bundle.skillNames.includes(skillName);
        const withoutSkill = bundle.skillNames.filter(name => name !== skillName);
        let nextSkillNames = withoutSkill;
        if (bundle.id === targetBundle.id) {
          const insertAt = typeof targetIndex === 'number'
            ? Math.max(0, Math.min(targetIndex, withoutSkill.length))
            : withoutSkill.length;
          nextSkillNames = [
            ...withoutSkill.slice(0, insertAt),
            skillName,
            ...withoutSkill.slice(insertAt),
          ];
        }
        const changed = hasSkill || bundle.id === targetBundle.id;
        if (changed) updates.push(updateBundleSkillNames(bundle, nextSkillNames));
      }
      await Promise.all(updates);
      await loadSkillsForAgent(agentId);
      addToast(t('settings.autoSaved'), 'success');
    } catch (err) {
      addToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  }, [addToast, loadSkillsForAgent, selectedAgentId, skillBundles, t, updateBundleSkillNames]);

  const removeSkillFromBundles = useCallback(async (skillName: string) => {
    const agentId = selectedAgentId;
    if (!agentId) return;
    try {
      const updates = skillBundles
        .filter(bundle => bundle.skillNames.includes(skillName))
        .map(bundle => updateBundleSkillNames(bundle, bundle.skillNames.filter(name => name !== skillName)));
      await Promise.all(updates);
      await loadSkillsForAgent(agentId);
      addToast(t('settings.autoSaved'), 'success');
    } catch (err) {
      addToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  }, [addToast, loadSkillsForAgent, selectedAgentId, skillBundles, t, updateBundleSkillNames]);

  if (!visible) return null;

  return (
    <div className={fp.floatingPanel} id="skillsPanel">
      <div className={fp.floatingPanelInner}>
        <div className={fp.floatingPanelHeader}>
          <h2 className={fp.floatingPanelTitle}>{t('skills.panel.title')}</h2>
          <button className={fp.floatingPanelClose} onClick={close} aria-label={t('common.close')}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className={fp.floatingPanelBody}>
          <div
            className={styles.dropSurface}
            data-testid="skills-panel-drop-surface"
            data-drag-over={dragOver ? 'true' : undefined}
            onDragOverCapture={handleDragOverCapture}
            onDragLeave={() => setDragOver(false)}
            onDropCapture={handleDropCapture}
          >
            <AgentTabScroller
              items={agentTabItems}
              activeId={selectedTabId}
              ariaLabel={t('skills.panel.agentTabs')}
              previousLabel={t('skills.panel.previousAgent')}
              nextLabel={t('skills.panel.nextAgent')}
              onSelect={setSelectedTabId}
            />

            {canManage ? (
              <>
                <button className={styles.dropzone} type="button" onClick={installSkill}>
                  <UploadIcon />
                  <span>{t('settings.skills.dropzone')}</span>
                </button>
                <input
                  ref={skillFileInputRef}
                  type="file"
                  accept=".zip,.skill"
                  hidden
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0] || null;
                    event.currentTarget.value = '';
                    if (file) void installSkillFromFile(file);
                  }}
                />
              </>
            ) : null}

            {shouldShowInitialLoading ? (
              <div className={styles.empty}>{t('status.loading')}</div>
            ) : treeSkills.length === 0 && skillBundles.length === 0 ? (
              <div className={styles.empty}>{t('settings.skills.noUser')}</div>
            ) : (
              <SkillBundleTree
                mode={canManage ? 'manage' : 'agent'}
                bundles={skillBundles}
                skills={treeSkills}
                nameHints={{}}
                emptyText={t('settings.skills.noUser')}
                onDeleteSkill={canManage ? deleteSkill : undefined}
                onCreateBundle={canManage ? createBundle : undefined}
                onRenameBundle={canManage ? renameBundle : undefined}
                onExportBundle={canManage ? exportBundle : undefined}
                onDeleteBundle={canManage ? deleteBundle : undefined}
                onReorderBundles={canManage ? reorderBundles : undefined}
                onMoveSkillToBundle={canManage ? moveSkillToBundle : undefined}
                onRemoveSkillFromBundles={canManage ? removeSkillFromBundles : undefined}
                onToggleSkill={canManage ? undefined : toggleSkill}
                onToggleBundle={canManage ? undefined : toggleBundle}
                highlightedSkillName={highlight.skillName}
                highlightedBundleId={highlight.bundleId}
                expandedState={bundleExpandedState}
                onExpandedStateChange={setSelectedBundleExpandedState}
              />
            )}
          </div>
        </div>
        {bundleDialog ? (
          <div
            className={settingsStyles['skill-bundle-dialog-backdrop']}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setBundleDialog(null);
            }}
          >
            <form
              className={settingsStyles['skill-bundle-dialog']}
              role="dialog"
              aria-modal="true"
              aria-label={
                bundleDialog.type === 'create'
                  ? t('settings.skills.bundleDialog.createTitle')
                  : bundleDialog.type === 'rename'
                    ? t('settings.skills.bundleDialog.renameTitle')
                    : t('settings.skills.bundleDialog.dissolveTitle')
              }
              onSubmit={submitBundleDialog}
            >
              <div className={settingsStyles['skill-bundle-dialog-header']}>
                <h3>
                  {bundleDialog.type === 'create'
                    ? t('settings.skills.bundleDialog.createTitle')
                    : bundleDialog.type === 'rename'
                      ? t('settings.skills.bundleDialog.renameTitle')
                      : t('settings.skills.bundleDialog.dissolveTitle')}
                </h3>
                <button
                  type="button"
                  title={t('settings.skills.bundleDialog.cancel')}
                  aria-label={t('settings.skills.bundleDialog.closeAriaLabel')}
                  onClick={() => setBundleDialog(null)}
                >
                  ×
                </button>
              </div>
              {bundleDialog.type === 'delete' ? (
                <p className={settingsStyles['skill-bundle-dialog-text']}>
                  {t('settings.skills.bundleDialog.dissolveConfirm', { name: bundleDialog.bundle.name })}
                </p>
              ) : (
                <label className={settingsStyles['skill-bundle-dialog-field']}>
                  <span>{t('settings.skills.bundleDialog.bundleNameLabel')}</span>
                  <input
                    value={bundleDialog.name}
                    autoFocus
                    onChange={(event) => setBundleDialog(prev => {
                      if (!prev || prev.type === 'delete') return prev;
                      return { ...prev, name: event.target.value };
                    })}
                  />
                </label>
              )}
              <div className={settingsStyles['skill-bundle-dialog-actions']}>
                <button type="button" onClick={() => setBundleDialog(null)}>
                  {t('settings.skills.bundleDialog.cancelBtn')}
                </button>
                <button type="submit" className={settingsStyles['skill-bundle-dialog-primary']}>
                  {bundleDialog.type === 'create'
                    ? t('settings.skills.bundleDialog.createBtn')
                    : bundleDialog.type === 'rename'
                      ? t('settings.skills.bundleDialog.saveBtn')
                      : t('settings.skills.bundleDialog.dissolveBtn')}
                </button>
              </div>
            </form>
          </div>
        ) : null}
      </div>
    </div>
  );
}
