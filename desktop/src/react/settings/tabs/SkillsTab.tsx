import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSettingsStore, type SkillInfo } from '../store';
import { lucFetch } from '../api';
import { t } from '../helpers';
import { SkillBundleTree, type SkillBundleInfo } from './skills/SkillBundleTree';
import { SkillCapabilities } from './skills/SkillCapabilities';
import { CompatPathDrawer } from './skills/CompatPathDrawer';
import { AgentSelect } from './bridge/AgentSelect';
import { SettingsSection } from '../components/SettingsSection';
import styles from '../Settings.module.css';

type BundleDialogState =
  | { type: 'create'; name: string }
  | { type: 'rename'; bundle: SkillBundleInfo; name: string }
  | { type: 'delete'; bundle: SkillBundleInfo };

interface ExternalPathsData {
  configured: string[];
  discovered: { dirPath: string; label: string; exists: boolean }[];
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

export function SkillsTab() {
  const settingsConfig = useSettingsStore(s => s.settingsConfig);
  const showToast = useSettingsStore(s => s.showToast);
  const currentAgentId = useSettingsStore(s => s.currentAgentId);

  const [skillsViewAgentId, setSkillsViewAgentId] =
    useState<string | null>(currentAgentId);
  const skillsViewAgentIdRef = useRef(skillsViewAgentId);
  skillsViewAgentIdRef.current = skillsViewAgentId;

  const [skillsList, setSkillsList] = useState<SkillInfo[]>([]);
  const [skillBundles, setSkillBundles] = useState<SkillBundleInfo[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const skillsListOwnerIdRef = useRef<string | null>(null);
  const [bundleDialog, setBundleDialog] = useState<BundleDialogState | null>(null);
  const skillFileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (skillsViewAgentId) return;
    if (currentAgentId) setSkillsViewAgentId(currentAgentId);
  }, [currentAgentId]); // eslint-disable-line react-hooks/exhaustive-deps -- sticky selector only hydrates from currentAgentId while empty

  const [externalPathsData, setExternalPathsData] = useState<ExternalPathsData>({
    configured: [],
    discovered: [],
  });

  const loadSkills = useCallback(async () => {
    const agentId = skillsViewAgentIdRef.current;
    if (!agentId) {
      skillsListOwnerIdRef.current = null;
      setSkillsList([]);
      setSkillBundles([]);
      setSkillsLoading(false);
      return;
    }
    const ownerChanged = skillsListOwnerIdRef.current !== agentId;
    if (ownerChanged) {
      setSkillsLoading(true);
      setSkillsList([]);
      setSkillBundles([]);
    }
    try {
      const snapshotAgentId = agentId;
      const [skillsRes, bundlesRes] = await Promise.all([
        lucFetch(`/api/skills?agentId=${encodeURIComponent(agentId)}&runtime=1`),
        lucFetch(`/api/skills/bundles?agentId=${encodeURIComponent(agentId)}`),
      ]);
      const data = await skillsRes.json();
      const bundleData = await bundlesRes.json();
      if (data.error) throw new Error(data.error);
      if (bundleData.error) throw new Error(bundleData.error);
      if (skillsViewAgentIdRef.current !== snapshotAgentId) return;
      setSkillsList(data.skills || []);
      setSkillBundles(bundleData.bundles || []);
      skillsListOwnerIdRef.current = snapshotAgentId;
    } catch (err) {
      console.error('[skills] load failed:', err);
    } finally {
      if (skillsViewAgentIdRef.current === agentId && ownerChanged) {
        setSkillsLoading(false);
      }
    }
  }, []);

  const loadExternalPaths = useCallback(async () => {
    try {
      const res = await lucFetch('/api/skills/external-paths');
      const data = await res.json();
      setExternalPathsData({
        configured: data.configured || [],
        discovered: data.discovered || [],
      });
    } catch (err) {
      console.error('[skills] load external paths failed:', err);
    }
  }, []);

  useEffect(() => {
    loadSkills();
    loadExternalPaths();
  }, [loadSkills, loadExternalPaths, skillsViewAgentId]);

  useEffect(() => {
    const refresh = () => {
      void loadSkills();
      void loadExternalPaths();
    };
    window.addEventListener('luc-skills-changed', refresh);
    return () => window.removeEventListener('luc-skills-changed', refresh);
  }, [loadSkills, loadExternalPaths]);

  const visible = skillsList.filter(s => !s.hidden);
  const userSkills = visible.filter(s => s.source !== 'external');
  const manageableSkills = userSkills.filter(s => s.source !== 'workspace' && s.managedBy !== 'workspace' && s.managedBy !== 'plugin');
  const externalSkills = visible.filter(s => s.source === 'external');

  // 后台翻译技能名
  const [nameHints, setNameHints] = useState<Record<string, string>>({});
  useEffect(() => {
    const locale = window.i18n?.locale || 'zh';
    if (locale === 'en' || visible.length === 0) return;
    const agentId = skillsViewAgentIdRef.current;
    if (!agentId) return;
    const names = visible.map(s => s.name);
    if (names.length === 0) return;
    lucFetch('/api/skills/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, names, lang: locale }),
    })
      .then(r => r.json())
      .then(map => { if (map && typeof map === 'object') setNameHints(prev => ({ ...prev, ...map })); })
      .catch(err => console.warn('[skills] translate failed:', err));
  }, [skillsList, skillsViewAgentId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 全局安装：只注册 skill 到 engine.skillsDir，不自动对任何 agent 启用。
  // 原则：全局的管全局的。装完后用户到 Section 3 "Agent 配置" 自己打开开关。
  const installSkillFromPath = async (filePath: string) => {
    try {
      const res = await lucFetch('/api/skills/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast(t('settings.skills.installSuccess', { name: data.skill?.name || '' }), 'success');
      await loadSkills();
    } catch (err: unknown) {
      showToast(t('settings.skills.installError') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  const installSkillFromFile = async (file: File) => {
    const filePath = window.platform?.getFilePath?.(file) || (file as File & { path?: string })?.path;
    if (filePath) {
      await installSkillFromPath(filePath);
      return;
    }
    try {
      const contentBase64 = await fileToBase64(file);
      const res = await lucFetch('/api/skills/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file: {
            filename: file.name || 'skill.skill',
            contentBase64,
          },
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast(t('settings.skills.installSuccess', { name: data.skill?.name || '' }), 'success');
      await loadSkills();
    } catch (err: unknown) {
      showToast(t('settings.skills.installError') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  const installSkill = async () => {
    if (typeof window.platform?.selectSkill === 'function') {
      const selectedPath = await window.platform.selectSkill();
      if (!selectedPath) return;
      await installSkillFromPath(selectedPath);
      return;
    }
    skillFileInputRef.current?.click();
  };

  const deleteSkill = async (name: string) => {
    const agentId = skillsViewAgentIdRef.current;
    if (!agentId) {
      showToast(t('settings.saveFailed') + ': no agent selected', 'error');
      return;
    }
    const msg = t('settings.skills.deleteConfirm', { name });
    if (!confirm(msg)) return;
    try {
      const res = await lucFetch(
        `/api/skills/${encodeURIComponent(name)}?agentId=${encodeURIComponent(agentId)}`,
        { method: 'DELETE' },
      );
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast(t('settings.autoSaved'), 'success');
      await loadSkills();
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  const createBundle = () => {
    setBundleDialog({ type: 'create', name: 'New Bundle' });
  };

  const submitCreateBundle = async (name: string) => {
    const agentId = skillsViewAgentIdRef.current;
    if (!agentId) return;
    try {
      const res = await lucFetch(`/api/skills/bundles?agentId=${encodeURIComponent(agentId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, skillNames: [] }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setBundleDialog(null);
      showToast(t('settings.autoSaved'), 'success');
      await loadSkills();
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  const renameBundle = (bundle: SkillBundleInfo) => {
    setBundleDialog({ type: 'rename', bundle, name: bundle.name });
  };

  const submitRenameBundle = async (bundle: SkillBundleInfo, name: string) => {
    const agentId = skillsViewAgentIdRef.current;
    if (!agentId) return;
    if (!name || name === bundle.name) return;
    try {
      const res = await lucFetch(`/api/skills/bundles/${encodeURIComponent(bundle.id)}?agentId=${encodeURIComponent(agentId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setBundleDialog(null);
      showToast(t('settings.autoSaved'), 'success');
      await loadSkills();
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  const deleteBundle = (bundle: SkillBundleInfo) => {
    setBundleDialog({ type: 'delete', bundle });
  };

  const exportBundle = async (bundle: SkillBundleInfo) => {
    try {
      const res = await lucFetch(`/api/skills/bundles/${encodeURIComponent(bundle.id)}/export`, {
        method: 'POST',
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const skipped = Array.isArray(data.warnings) ? data.warnings.length : 0;
      const fileName = data.fileName || bundle.name;
      const msg = skipped > 0
        ? t('settings.skills.exportedWithSkipped', { fileName, count: String(skipped) })
        : t('settings.skills.exported', { fileName });
      showToast(msg, 'success');
      if (data.filePath) {
        window.platform?.showInFinder?.(data.filePath);
      }
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  const submitDeleteBundle = async (bundle: SkillBundleInfo) => {
    try {
      const res = await lucFetch(`/api/skills/bundles/${encodeURIComponent(bundle.id)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setBundleDialog(null);
      showToast(t('settings.autoSaved'), 'success');
      await loadSkills();
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  const updateBundleSkillNames = async (bundle: SkillBundleInfo, skillNames: string[]) => {
    const agentId = skillsViewAgentIdRef.current;
    if (!agentId) return;
    const res = await lucFetch(`/api/skills/bundles/${encodeURIComponent(bundle.id)}?agentId=${encodeURIComponent(agentId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skillNames }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
  };

  const reorderBundles = async (bundleIds: string[]) => {
    const agentId = skillsViewAgentIdRef.current;
    if (!agentId) return;
    try {
      const res = await lucFetch(`/api/skills/bundles/order?agentId=${encodeURIComponent(agentId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bundleIds }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setSkillBundles(data.bundles || []);
      showToast(t('settings.autoSaved'), 'success');
      await loadSkills();
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
      await loadSkills();
    }
  };

  const moveSkillToBundle = async (skillName: string, targetBundle: SkillBundleInfo, targetIndex?: number) => {
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
        if (hasSkill || bundle.id === targetBundle.id) {
          const changed = nextSkillNames.length !== bundle.skillNames.length
            || nextSkillNames.some((name, index) => name !== bundle.skillNames[index]);
          if (changed) updates.push(updateBundleSkillNames(bundle, nextSkillNames));
        }
      }
      await Promise.all(updates);
      showToast(t('settings.autoSaved'), 'success');
      await loadSkills();
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  const submitBundleDialog = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!bundleDialog) return;
    if (bundleDialog.type === 'delete') {
      await submitDeleteBundle(bundleDialog.bundle);
      return;
    }
    const name = bundleDialog.name.trim();
    if (!name) return;
    if (bundleDialog.type === 'create') {
      await submitCreateBundle(name);
      return;
    }
    await submitRenameBundle(bundleDialog.bundle, name);
  };

  const removeSkillFromBundles = async (skillName: string) => {
    try {
      const updates = skillBundles
        .filter(bundle => bundle.skillNames.includes(skillName))
        .map(bundle => updateBundleSkillNames(bundle, bundle.skillNames.filter(name => name !== skillName)));
      await Promise.all(updates);
      showToast(t('settings.autoSaved'), 'success');
      await loadSkills();
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  const toggleSkill = async (name: string, enable: boolean) => {
    const agentId = skillsViewAgentIdRef.current;
    if (!agentId) return;
    const snapshotAgentId = agentId;

    const updated = skillsList.map(s => s.name === name ? { ...s, enabled: enable } : s);
    setSkillsList(updated);

    try {
      const res = await lucFetch(`/api/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: enable }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (skillsViewAgentIdRef.current === snapshotAgentId) {
        showToast(t('settings.autoSaved'), 'success');
        await loadSkills();
      }
    } catch (err: unknown) {
      if (skillsViewAgentIdRef.current === snapshotAgentId) {
        const reverted = skillsList.map(s => s.name === name ? { ...s, enabled: !enable } : s);
        setSkillsList(reverted);
        showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
      }
    }
  };

  const toggleBundle = async (bundle: SkillBundleInfo, enable: boolean) => {
    const agentId = skillsViewAgentIdRef.current;
    if (!agentId) return;
    const snapshotAgentId = agentId;
    const bundleSkillNames = new Set(bundle.skillNames);
    const updated = skillsList.map(s => bundleSkillNames.has(s.name) ? { ...s, enabled: enable } : s);
    setSkillsList(updated);
    setSkillBundles(prev => prev.map(item => item.id === bundle.id
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
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (skillsViewAgentIdRef.current === snapshotAgentId) {
        showToast(t('settings.autoSaved'), 'success');
        await loadSkills();
      }
    } catch (err: unknown) {
      if (skillsViewAgentIdRef.current === snapshotAgentId) {
        setSkillsList(skillsList);
        showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
        await loadSkills();
      }
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).classList.remove(styles['drag-over']);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    await installSkillFromFile(file);
  };

  const addExternalPath = async () => {
    const folder = await window.platform?.selectFolder?.();
    if (!folder) return;
    const newPaths = [...externalPathsData.configured, folder];
    try {
      await lucFetch('/api/skills/external-paths', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: newPaths }),
      });
      await loadExternalPaths();
      await loadSkills();
      showToast(t('settings.autoSaved'), 'success');
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const removeExternalPath = async (pathToRemove: string) => {
    const newPaths = externalPathsData.configured.filter(p => p !== pathToRemove);
    try {
      await lucFetch('/api/skills/external-paths', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: newPaths }),
      });
      await loadExternalPaths();
      await loadSkills();
      showToast(t('settings.autoSaved'), 'success');
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const skillInstallCfg = settingsConfig ? settingsConfig.capabilities?.learn_skills || {} : undefined;
  const discoveredPaths = externalPathsData.discovered;
  const configuredOnlyPaths = externalPathsData.configured.filter(
    p => !discoveredPaths.some(d => d.dirPath === p),
  );

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="skills">

      {/* Section 1: 管理技能 — Dropzone 虚线卡 + skill list 实线卡都自带视觉，flush 不再套白卡 */}
      <SettingsSection title={t('settings.skills.manageTitle')} surface="plain">
        <div
          className={styles['skills-dropzone']}
          onClick={installSkill}
          onDragOver={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement).classList.add(styles['drag-over']); }}
          onDragLeave={(e) => (e.currentTarget as HTMLElement).classList.remove(styles['drag-over'])}
          onDrop={handleDrop}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <span>{t('settings.skills.dropzone')}</span>
        </div>
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

        {skillsLoading ? (
          <p className={`${styles['settings-muted-note']} ${styles['skills-empty']}`}>{t('status.loading')}</p>
        ) : manageableSkills.length === 0 && skillBundles.length === 0 ? (
          <p className={`${styles['settings-muted-note']} ${styles['skills-empty']}`}>{t('settings.skills.noUser')}</p>
        ) : (
          <SkillBundleTree
            mode="manage"
            bundles={skillBundles}
            skills={manageableSkills}
            nameHints={nameHints}
            emptyText={t('settings.skills.noUser')}
            onDeleteSkill={deleteSkill}
            onCreateBundle={createBundle}
            onRenameBundle={renameBundle}
            onExportBundle={exportBundle}
            onDeleteBundle={deleteBundle}
            onReorderBundles={reorderBundles}
            onMoveSkillToBundle={moveSkillToBundle}
            onRemoveSkillFromBundles={removeSkillFromBundles}
          />
        )}
      </SettingsSection>

      {/* Section 2: 全局能力（子组件，保持原样） */}
      <SkillCapabilities installCfg={skillInstallCfg} />

      {/* Section 3A: Agent Skills 开关（per-Agent 开关）
       * flush：skills-list-block 自带卡片视觉，section 不再套外层白卡 */}
      <SettingsSection
        surface="plain"
        title={t('settings.skills.userSkillsTitle')}
        context={
          <AgentSelect
            value={skillsViewAgentId}
            onChange={setSkillsViewAgentId}
          />
        }
      >
        {skillsLoading ? (
          <p className={`${styles['agent-skill-empty']} ${styles['settings-empty-inset']}`}>
            {t('status.loading')}
          </p>
        ) : userSkills.length === 0 && skillBundles.length === 0 ? (
          <p className={`${styles['agent-skill-empty']} ${styles['settings-empty-inset']}`}>
            {t('settings.skills.noUser')}
          </p>
        ) : (
          <SkillBundleTree
            mode="agent"
            bundles={skillBundles}
            skills={userSkills}
            nameHints={nameHints}
            emptyText={t('settings.skills.noUser')}
            onToggleSkill={toggleSkill}
            onToggleBundle={toggleBundle}
          />
        )}
      </SettingsSection>

      {/* Section 4: 外部兼容
       * flush：CompatPathDrawer 自带卡片视觉，外壳不再套白卡 */}
      <SettingsSection title={t('settings.skills.compatTitle')} surface="plain">
        <p className={styles['settings-section-lead']}>
          {t('settings.skills.compatDesc')}
        </p>
        <div className={styles['compat-paths-group']}>
          {discoveredPaths.map(d => (
            <CompatPathDrawer
              key={d.dirPath}
              dirPath={d.dirPath}
              label={d.label}
              exists={d.exists}
              isCustom={false}
              skills={externalSkills.filter(s => s.externalPath === d.dirPath)}
              nameHints={nameHints}
              onToggle={toggleSkill}
              onRemove={removeExternalPath}
            />
          ))}
          {configuredOnlyPaths.map(p => (
            <CompatPathDrawer
              key={p}
              dirPath={p}
              label={null}
              exists={true}
              isCustom={true}
              skills={externalSkills.filter(s => s.externalPath === p)}
              nameHints={nameHints}
              onToggle={toggleSkill}
              onRemove={removeExternalPath}
            />
          ))}
          <button className={styles['compat-add-path']} onClick={addExternalPath}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span>{t('settings.skills.compatAddPath')}</span>
          </button>
        </div>
      </SettingsSection>

      {bundleDialog ? (
        <div
          className={styles['skill-bundle-dialog-backdrop']}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setBundleDialog(null);
          }}
        >
          <form
            className={styles['skill-bundle-dialog']}
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
            <div className={styles['skill-bundle-dialog-header']}>
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
              <p className={styles['skill-bundle-dialog-text']}>
                {t('settings.skills.bundleDialog.dissolveConfirm', { name: bundleDialog.bundle.name })}
              </p>
            ) : (
              <label className={styles['skill-bundle-dialog-field']}>
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
            <div className={styles['skill-bundle-dialog-actions']}>
              <button type="button" onClick={() => setBundleDialog(null)}>
                {t('settings.skills.bundleDialog.cancelBtn')}
              </button>
              <button type="submit" className={styles['skill-bundle-dialog-primary']}>
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
  );
}
