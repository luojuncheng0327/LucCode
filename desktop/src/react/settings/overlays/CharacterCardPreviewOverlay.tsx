import { useState } from 'react';
import { createPortal } from 'react-dom';
import { lucUrl } from '../api';
import { t } from '../helpers';
import { displayInitial } from '../../utils/grapheme';
import styles from '../Settings.module.css';

export type CharacterCardPlan = {
  token?: string;
  agentId?: string;
  mode?: 'import' | 'export';
  packageName: string;
  agent: {
    name: string;
    yuan: string;
    description?: string;
    identitySummary?: string;
  };
  prompts?: {
    identity?: string;
    agents?: string;
    publicAgents?: string;
  };
  memory: {
    available: boolean;
    count: number;
    preview?: string;
    unavailableReason?: string;
    compiled?: {
      facts?: string;
      today?: string;
      week?: string;
      longterm?: string;
    };
  };
  skills: {
    count: number;
    bundles: Array<{
      name: string;
      skillCount: number;
      skills: Array<{ name: string }>;
    }>;
  };
  assets: Record<string, boolean>;
};

type Props = {
  plan: CharacterCardPlan;
  mode: 'import' | 'export';
  memoryChecked: boolean;
  processing: boolean;
  onMemoryChange: (checked: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
};

export function CharacterCardPreviewOverlay({
  plan,
  mode,
  memoryChecked,
  processing,
  onMemoryChange,
  onConfirm,
  onCancel,
}: Props) {
  const [detailOpen, setDetailOpen] = useState(false);
  const skillNames = plan.skills.bundles.flatMap(bundle => bundle.skills.map(skill => skill.name));
  const visibleSkillNames = skillNames.slice(0, 3);
  const hasMoreSkills = skillNames.length > visibleSkillNames.length;
  const memoryLabel = mode === 'export' ? t('settings.characterCard.exportMemory') : t('settings.characterCard.importMemory');
  const memoryUnavailableLabel = mode === 'export' ? t('settings.characterCard.noExportableMemory') : t('settings.characterCard.noImportableMemory');
  const confirmLabel = processing ? (mode === 'export' ? t('settings.characterCard.exporting') : t('settings.characterCard.importing')) : t('settings.characterCard.confirm');
  const descriptionText = plan.agent.description || t('settings.characterCard.noDescription');
  const agentsMdText = plan.prompts?.agents || t('settings.characterCard.noAgentsMd');
  const yuanKey = (plan.agent.yuan || 'luc').toLowerCase();
  const memoryInputId = `character-card-memory-${plan.token || plan.agentId || 'preview'}`;
  const memoryAvailable = plan.memory.available;
  const memoryPreviewText = plan.memory.preview || t('settings.characterCard.noMemory');
  const memoryDetailBlocks = [
    { key: 'facts', title: t('settings.characterCard.factsSectionTitle'), value: plan.memory.compiled?.facts || '' },
    { key: 'today', title: t('settings.characterCard.todaySectionTitle'), value: plan.memory.compiled?.today || '' },
    { key: 'week', title: t('settings.characterCard.weekSectionTitle'), value: plan.memory.compiled?.week || '' },
    { key: 'longterm', title: t('settings.characterCard.longtermSectionTitle'), value: plan.memory.compiled?.longterm || '' },
  ];

  const assetUrl = (key: string) => (
    plan.assets?.[key]
      ? mode === 'export' && plan.agentId
        ? lucUrl(`/api/character-cards/export/${encodeURIComponent(plan.agentId)}/assets/${key}`)
        : plan.token
          ? lucUrl(`/api/character-cards/plans/${plan.token}/assets/${key}`)
          : ''
      : ''
  );
  const frontUrl = assetUrl('cardFront') || assetUrl('avatar');
  const backUrl = assetUrl('cardBack') || assetUrl('avatar') || frontUrl;
  const yuanIconUrl = assetUrl('yuanIcon') || backUrl;

  const overlay = (
    <div className={styles['character-card-preview-overlay']} data-yuan={yuanKey} role="dialog" aria-modal="true">
      {detailOpen ? (
        <section className={styles['character-card-detail-panel']}>
          <button
            className={styles['character-card-detail-close']}
            type="button"
            onClick={() => setDetailOpen(false)}
            disabled={processing}
          >
            ×
          </button>
          <div className={styles['character-card-detail-hero']}>
            {frontUrl ? <img src={frontUrl} draggable={false} /> : null}
            <div>
              <h3>{plan.agent.name}</h3>
              <p>{descriptionText}</p>
            </div>
          </div>
          <div className={styles['character-card-detail-grid']}>
            <section>
              <h4>Identity</h4>
              <p>{plan.prompts?.identity || plan.agent.identitySummary || t('settings.characterCard.noIdentity')}</p>
            </section>
            <section>
              <h4>AGENTS.md</h4>
              <p>{agentsMdText}</p>
            </section>
            <section>
              <h4>Yuan</h4>
              <p>{plan.agent.yuan}</p>
            </section>
            <section>
              <h4>Memory</h4>
              <p>{memoryAvailable ? t('settings.characterCard.memoryCount', { count: String(plan.memory.count), action: mode === 'export' ? t('settings.characterCard.memoryCountExport') : t('settings.characterCard.memoryCountImport') }) : memoryUnavailableLabel}</p>
              <div className={styles['character-card-memory-detail-list']}>
                {memoryDetailBlocks.map(block => (
                  <div className={styles['character-card-memory-detail-block']} key={block.key}>
                    <strong>{block.title}</strong>
                    <pre>{block.value || t('settings.characterCard.emptySection')}</pre>
                  </div>
                ))}
              </div>
            </section>
            <section>
              <h4>Skills</h4>
              {plan.skills.bundles.length > 0 ? plan.skills.bundles.map((bundle) => (
                <div className={styles['character-card-detail-bundle']} key={bundle.name}>
                  <strong>{bundle.name}</strong>
                  <span>{bundle.skillCount} skills</span>
                  <ul>
                    {bundle.skills.map(skill => <li key={skill.name}>{skill.name}</li>)}
                  </ul>
                </div>
              )) : <p>{t('settings.characterCard.noSkills')}</p>}
            </section>
          </div>
        </section>
      ) : (
        <section className={styles['character-card-preview-shell']}>
          <div className={styles['character-card-preview-cards']}>
            <article className={styles['character-card-front']}>
              <div
                className={styles['character-card-visual']}
              >
                {frontUrl ? (
                  <img src={frontUrl} draggable={false} />
                ) : (
                  <span>{displayInitial(plan.agent.name, '?')}</span>
                )}
              </div>
              <div className={styles['character-card-face']}>
                <div className={styles['character-card-title-row']}>
                  <div className={styles['character-card-title-text']}>
                    <h3>{plan.agent.name}</h3>
                    <p>{descriptionText}</p>
                  </div>
                  <button
                    className={styles['character-card-detail-trigger']}
                    type="button"
                    aria-label={t('settings.characterCard.viewDetail')}
                    onClick={() => setDetailOpen(true)}
                    disabled={processing}
                  >
                    ...
                  </button>
                </div>
                <div className={styles['character-card-face-grid']}>
                  <div className={styles['character-card-face-cell']}>
                    <span className={styles['character-card-face-label']}>YUAN</span>
                    <span className={styles['character-card-face-line']} />
                    <span className={`${styles['character-card-face-value']} ${styles['character-card-yuan-value']}`}>
                      {yuanIconUrl ? (
                        <img className={styles['character-card-yuan-icon']} src={yuanIconUrl} draggable={false} />
                      ) : null}
                      {plan.agent.yuan}
                    </span>
                  </div>
                  <div className={styles['character-card-face-cell']}>
                    <span className={styles['character-card-face-label']}>MEMORY</span>
                    <span className={styles['character-card-face-line']} />
                    <span className={`${styles['character-card-face-value']} ${styles['character-card-memory-value']}`}>
                      <span className={styles['character-card-memory-preview']}>{memoryPreviewText}</span>
                      <label
                        className={`${styles['character-card-memory-toggle']} ${!memoryAvailable ? styles['character-card-memory-toggle-disabled'] : ''}`}
                        htmlFor={memoryInputId}
                        title={!memoryAvailable ? (plan.memory.unavailableReason || memoryUnavailableLabel) : undefined}
                      >
                        <input
                          id={memoryInputId}
                          className={styles['character-card-memory-checkbox']}
                          type="checkbox"
                          checked={memoryChecked}
                          disabled={!memoryAvailable || processing}
                          onChange={(event) => onMemoryChange(event.target.checked)}
                        />
                        {memoryAvailable ? memoryLabel : memoryUnavailableLabel}
                      </label>
                    </span>
                  </div>
                  <div className={styles['character-card-face-cell']}>
                    <span className={styles['character-card-face-label']}>SKILLS</span>
                    <span className={styles['character-card-face-line']} />
                    <span className={`${styles['character-card-face-value']} ${styles['character-card-skills-value']}`}>
                      {visibleSkillNames.length > 0 ? (
                        <span className={styles['character-card-skill-list']}>
                          {visibleSkillNames.map(name => <span key={name}>{name}</span>)}
                          {hasMoreSkills ? <span>...</span> : null}
                        </span>
                      ) : t('settings.characterCard.emptySection')}
                    </span>
                  </div>
                </div>
              </div>
            </article>
            <article className={`${styles['character-card-front']} ${styles['character-card-back']}`}>
              {backUrl ? <img src={backUrl} draggable={false} /> : <span>{plan.agent.yuan}</span>}
            </article>
          </div>
          <div className={styles['character-card-preview-actions']}>
            <button
              className={styles['character-card-primary-action']}
              type="button"
              onClick={onConfirm}
              disabled={processing}
            >
              {confirmLabel}
            </button>
            <button
              className={styles['character-card-secondary-action']}
              type="button"
              onClick={onCancel}
              disabled={processing}
            >
              {t('settings.characterCard.cancel')}
            </button>
          </div>
        </section>
      )}
    </div>
  );

  return createPortal(overlay, document.body);
}
