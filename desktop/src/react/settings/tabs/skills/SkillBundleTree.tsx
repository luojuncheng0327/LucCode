import React, { useCallback, useMemo, useState } from 'react';
import type { SkillInfo } from '../../store';
import { t } from '../../helpers';
import { SkillRow } from './SkillRow';
import styles from '../../Settings.module.css';

export interface SkillBundleInfo {
  id: string;
  name: string;
  skillNames: string[];
  source?: string;
  agentId?: string | null;
  sourcePackage?: string | null;
  skills?: Array<{
    name: string;
    enabled: boolean;
    source: string | null;
    missing?: boolean;
  }>;
}

type TreeMode = 'manage' | 'agent';

interface SkillBundleTreeProps {
  mode: TreeMode;
  bundles: SkillBundleInfo[];
  skills: SkillInfo[];
  nameHints: Record<string, string>;
  emptyText: string;
  onDeleteSkill?: (name: string) => void;
  onToggleSkill?: (name: string, enabled: boolean) => void;
  onToggleBundle?: (bundle: SkillBundleInfo, enabled: boolean) => void;
  onCreateBundle?: () => void;
  onRenameBundle?: (bundle: SkillBundleInfo) => void;
  onExportBundle?: (bundle: SkillBundleInfo) => void;
  onDeleteBundle?: (bundle: SkillBundleInfo) => void;
  onReorderBundles?: (bundleIds: string[]) => void;
  onMoveSkillToBundle?: (skillName: string, bundle: SkillBundleInfo, index?: number) => void;
  onRemoveSkillFromBundles?: (skillName: string) => void;
  highlightedSkillName?: string | null;
  highlightedBundleId?: string | null;
  expandedState?: Record<string, boolean>;
  onExpandedStateChange?: (next: Record<string, boolean>) => void;
}

function skillDragType() {
  return 'application/x-luc-skill-name';
}

function bundleDragType() {
  return 'application/x-luc-skill-bundle-id';
}

function startSkillDrag(event: React.DragEvent<HTMLDivElement>, skillName: string) {
  event.dataTransfer.setData(skillDragType(), skillName);
  event.dataTransfer.effectAllowed = 'move';
}

function startBundleDrag(event: React.DragEvent<HTMLDivElement>, bundleId: string) {
  event.dataTransfer.setData(bundleDragType(), bundleId);
  event.dataTransfer.effectAllowed = 'move';
}

function skillFromDrop(event: React.DragEvent) {
  return event.dataTransfer.getData(skillDragType()).trim();
}

function bundleFromDrop(event: React.DragEvent) {
  return event.dataTransfer.getData(bundleDragType()).trim();
}

function bundleEnabledState(bundle: SkillBundleInfo, skillByName: Map<string, SkillInfo>) {
  const skillNames = bundle.skillNames.filter(name => skillByName.has(name));
  if (skillNames.length === 0) return { all: false, partial: false, next: true };
  const enabled = skillNames.filter(name => skillByName.get(name)?.enabled).length;
  return {
    all: enabled === skillNames.length,
    partial: enabled > 0 && enabled < skillNames.length,
    next: enabled !== skillNames.length,
  };
}

function skillConfigurable(skill: SkillInfo) {
  if (skill.configurable === false) return false;
  if (skill.readonly) return false;
  if (skill.source === 'workspace') return false;
  if (skill.managedBy === 'workspace' || skill.managedBy === 'plugin') return false;
  return true;
}

function skillDeletable(skill: SkillInfo) {
  if (skill.deletable === false) return false;
  if (skill.readonly) return false;
  if (skill.source === 'workspace') return false;
  if (skill.managedBy === 'workspace' || skill.managedBy === 'plugin') return false;
  return true;
}

export function SkillBundleTree({
  mode,
  bundles,
  skills,
  nameHints,
  emptyText,
  onDeleteSkill,
  onToggleSkill,
  onToggleBundle,
  onCreateBundle,
  onRenameBundle,
  onExportBundle,
  onDeleteBundle,
  onReorderBundles,
  onMoveSkillToBundle,
  onRemoveSkillFromBundles,
  highlightedSkillName,
  highlightedBundleId,
  expandedState,
  onExpandedStateChange,
}: SkillBundleTreeProps) {
  const [internalExpanded, setInternalExpanded] = useState<Record<string, boolean>>({});
  const expanded = expandedState ?? internalExpanded;
  const setBundleExpanded = useCallback((bundleId: string, nextExpanded: boolean) => {
    const next = { ...expanded, [bundleId]: nextExpanded };
    if (expandedState) {
      onExpandedStateChange?.(next);
    } else {
      setInternalExpanded(next);
    }
  }, [expanded, expandedState, onExpandedStateChange]);
  const skillByName = useMemo(() => new Map(skills.map(skill => [skill.name, skill])), [skills]);
  const bundledNames = useMemo(() => new Set(bundles.flatMap(bundle => bundle.skillNames)), [bundles]);
  const looseSkills = skills.filter(skill => !bundledNames.has(skill.name));
  const hasItems = bundles.length > 0 || looseSkills.length > 0;

  const canManage = mode === 'manage';

  const moveBundleBefore = (draggedId: string, targetId: string) => {
    if (!canManage || draggedId === targetId) return;
    const ids = bundles.map(bundle => bundle.id);
    const next = ids.filter(id => id !== draggedId);
    const targetIndex = next.indexOf(targetId);
    if (targetIndex === -1) return;
    next.splice(targetIndex, 0, draggedId);
    onReorderBundles?.(next);
  };

  const moveBundleToEnd = (draggedId: string) => {
    if (!canManage) return;
    const ids = bundles.map(bundle => bundle.id);
    if (ids[ids.length - 1] === draggedId) return;
    onReorderBundles?.([...ids.filter(id => id !== draggedId), draggedId]);
  };

  const dropOnBundle = (event: React.DragEvent, bundle: SkillBundleInfo, index?: number) => {
    if (!canManage) return;
    event.preventDefault();
    event.stopPropagation();
    const skillName = skillFromDrop(event);
    if (skillName) onMoveSkillToBundle?.(skillName, bundle, index);
  };

  const dropOnBundleHeader = (event: React.DragEvent, bundle: SkillBundleInfo) => {
    if (!canManage) return;
    event.preventDefault();
    const draggedBundleId = bundleFromDrop(event);
    if (draggedBundleId) {
      moveBundleBefore(draggedBundleId, bundle.id);
      return;
    }
    dropOnBundle(event, bundle);
  };

  const dropOnLoose = (event: React.DragEvent) => {
    if (!canManage) return;
    event.preventDefault();
    const draggedBundleId = bundleFromDrop(event);
    if (draggedBundleId) {
      moveBundleToEnd(draggedBundleId);
      return;
    }
    const skillName = skillFromDrop(event);
    if (skillName) onRemoveSkillFromBundles?.(skillName);
  };

  if (!hasItems) {
    return (
      <div className={styles['skill-bundle-tree']}>
        {canManage && onCreateBundle ? (
          <button
            className={styles['skill-bundle-create']}
            type="button"
            title={t('settings.skills.createBundleTitle')}
            aria-label={t('settings.skills.createBundleAriaLabel')}
            onClick={onCreateBundle}
          >
            {t('settings.skills.createBundleBtn')}
          </button>
        ) : null}
        <p className={styles['agent-skill-empty']} style={{ padding: 'var(--space-16)', margin: 0 }}>
          {emptyText}
        </p>
      </div>
    );
  }

  return (
    <div className={styles['skill-bundle-tree']}>
      {canManage && onCreateBundle ? (
        <div className={styles['skill-bundle-toolbar']}>
          <button
            className={styles['skill-bundle-create']}
            type="button"
            title={t('settings.skills.createBundleTitle')}
            aria-label={t('settings.skills.createBundleAriaLabel')}
            onClick={onCreateBundle}
          >
            {t('settings.skills.createBundleBtn')}
          </button>
        </div>
      ) : null}

      <div className={styles['skills-list-block']}>
        {bundles.map((bundle) => {
          const isExpanded = expanded[bundle.id] === true;
          const state = bundleEnabledState(bundle, skillByName);
          return (
            <div className={styles['skill-bundle-group']} key={bundle.id}>
              <div
                className={`${styles['skill-bundle-header']}${highlightedBundleId === bundle.id ? ` ${styles['skill-bundle-highlight']}` : ''}`}
                data-highlighted-bundle={highlightedBundleId === bundle.id ? bundle.id : undefined}
                data-testid={`skill-bundle-header-${bundle.id}`}
                draggable={canManage}
                onDragStart={(event) => startBundleDrag(event, bundle.id)}
                onDragOver={(event) => { if (canManage) event.preventDefault(); }}
                onDrop={(event) => dropOnBundleHeader(event, bundle)}
              >
                <button
                  className={styles['skill-bundle-caret']}
                  type="button"
                  aria-label={isExpanded ? t('settings.skills.collapseBundleAriaLabel') : t('settings.skills.expandBundleAriaLabel')}
                  title={isExpanded ? t('settings.skills.collapseBundleAriaLabel') : t('settings.skills.expandBundleAriaLabel')}
                  onClick={() => setBundleExpanded(bundle.id, !isExpanded)}
                >
                  {isExpanded ? '⌄' : '›'}
                </button>
                <div className={styles['skill-bundle-title']}>
                  <span>{bundle.name}</span>
                  <small>{bundle.skillNames.length} skills</small>
                </div>
                <div className={styles['skill-bundle-actions']}>
                  {mode === 'agent' && onToggleBundle ? (
                    <button
                      data-testid={`skill-bundle-toggle-${bundle.id}`}
                      className={`luc-toggle mini${state.all ? ' on' : ''}${state.partial ? ' bundle-mixed' : ''}`}
                      type="button"
                      title={state.next ? t('settings.skills.enableBundleTitle') : t('settings.skills.disableBundleTitle')}
                      aria-label={state.next ? t('settings.skills.enableBundleAriaLabel', { name: bundle.name }) : t('settings.skills.disableBundleAriaLabel', { name: bundle.name })}
                      onClick={() => onToggleBundle(bundle, state.next)}
                    />
                  ) : null}
                  {canManage && onRenameBundle ? (
                    <button
                      className={styles['skill-bundle-icon-button']}
                      type="button"
                      title={t('settings.skills.renameBundleTitle')}
                      aria-label={t('settings.skills.renameBundleAriaLabel', { name: bundle.name })}
                      onClick={() => onRenameBundle(bundle)}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 20h9" />
                        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                      </svg>
                    </button>
                  ) : null}
                  {canManage && onExportBundle ? (
                    <button
                      className={styles['skill-bundle-icon-button']}
                      type="button"
                      title={t('settings.skills.exportBundleTitle')}
                      aria-label={t('settings.skills.exportBundleAriaLabel', { name: bundle.name })}
                      onClick={() => onExportBundle(bundle)}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                    </button>
                  ) : null}
                  {canManage && onDeleteBundle ? (
                    <button
                      className={styles['skill-card-delete']}
                      type="button"
                      title={t('settings.skills.dissolveBundleTitle')}
                      aria-label={t('settings.skills.dissolveBundleAriaLabel', { name: bundle.name })}
                      onClick={() => onDeleteBundle(bundle)}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  ) : null}
                </div>
              </div>
              {isExpanded ? (
                <div className={styles['skill-bundle-children']}>
                  {bundle.skillNames.length === 0 ? (
                    <div className={styles['skill-bundle-empty']}>{t('settings.skills.emptyBundle')}</div>
                  ) : bundle.skillNames.map((skillName, index) => {
                    const skill = skillByName.get(skillName) || {
                      name: skillName,
                      description: t('settings.skills.skillNotFound'),
                      enabled: false,
                      source: 'missing',
                    };
                    return (
                      <SkillRow
                        key={`${bundle.id}:${skillName}`}
                        skill={skill}
                        nameHint={nameHints[skillName]}
                        deletable={canManage && skillDeletable(skill)}
                        draggable={canManage && skillDeletable(skill)}
                        onDragStart={canManage && skillDeletable(skill) ? startSkillDrag : undefined}
                        onDelete={canManage && skillDeletable(skill) ? onDeleteSkill : undefined}
                        onToggle={mode === 'agent' && skillConfigurable(skill) ? onToggleSkill : undefined}
                        onDragOver={(event) => { if (canManage) event.preventDefault(); }}
                        onDrop={(event) => dropOnBundle(event, bundle, index)}
                        className={`${styles['skill-bundle-child-row']}${highlightedSkillName === skillName ? ` ${styles['skill-install-highlight']}` : ''}`}
                        highlighted={highlightedSkillName === skillName}
                        extraActions={canManage ? (
                          <button
                            className={styles['skill-bundle-icon-button']}
                            type="button"
                            title={t('settings.skills.removeFromBundleTitle')}
                            aria-label={t('settings.skills.removeFromBundleAriaLabel', { name: skillName })}
                            onClick={(event) => {
                              event.stopPropagation();
                              onRemoveSkillFromBundles?.(skillName);
                            }}
                          >
                            ↩
                          </button>
                        ) : null}
                      />
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}

        <div
          className={styles['skill-bundle-loose-zone']}
          onDragOver={(event) => { if (canManage) event.preventDefault(); }}
          onDrop={dropOnLoose}
        >
          {looseSkills.map(skill => (
            <SkillRow
              key={skill.name}
              skill={skill}
              nameHint={nameHints[skill.name]}
              deletable={canManage && skillDeletable(skill)}
              draggable={canManage && skillDeletable(skill)}
              onDragStart={canManage && skillDeletable(skill) ? startSkillDrag : undefined}
              onDelete={canManage && skillDeletable(skill) ? onDeleteSkill : undefined}
              onToggle={mode === 'agent' && skillConfigurable(skill) ? onToggleSkill : undefined}
              className={highlightedSkillName === skill.name ? styles['skill-install-highlight'] : ''}
              highlighted={highlightedSkillName === skill.name}
            />
          ))}
          {looseSkills.length === 0 ? (
            <div className={styles['skill-bundle-empty']}>{t('settings.skills.noLooseSkills')}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
