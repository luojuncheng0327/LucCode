import { useRef, useState, useEffect, useCallback } from 'react';
import { useSettingsStore } from '../store';
import { lucFetch } from '../api';
import { t } from '../helpers';
import { renderMarkdown } from '../../utils/markdown';
import { useMermaidDiagrams } from '../../hooks/use-mermaid-diagrams';
import { Overlay } from '../../ui';
import styles from '../Settings.module.css';

interface WeekDay {
  date: string;
  body: string;
}

export function CompiledMemoryViewer() {
  const [visible, setVisible] = useState(false);
  const [editing, setEditing] = useState(false);
  const [sections, setSections] = useState({ facts: '', today: '', week: '', longterm: '' });
  const [factsDraft, setFactsDraft] = useState('');
  const [todayDraft, setTodayDraft] = useState('');
  const [longtermDraft, setLongtermDraft] = useState('');
  const [weekDays, setWeekDays] = useState<WeekDay[]>([]);
  const [weekDrafts, setWeekDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [savingAll, setSavingAll] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  useMermaidDiagrams(contentRef, [sections, loading, editing]);

  useEffect(() => {
    const handler = () => { setVisible(true); setEditing(false); load(); };
    window.addEventListener('luc-view-compiled-memory', handler);
    return () => window.removeEventListener('luc-view-compiled-memory', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- listener registered once for the component lifetime; `load` intentionally always reads the latest agent/store state when invoked, not a snapshot captured at mount
  }, []);

  const load = async () => {
    setLoading(true);
    try {
      const aid = useSettingsStore.getState().getSettingsAgentId();
      const res = await lucFetch(`/api/memories/compiled?agentId=${aid}`);
      const data = await res.json();
      const nextSections = {
        facts: data.sections?.facts || '',
        today: data.sections?.today || '',
        week: data.sections?.week || '',
        longterm: data.sections?.longterm || '',
      };
      setSections(nextSections);
      setFactsDraft(nextSections.facts);
      setTodayDraft(nextSections.today);
      setLongtermDraft(nextSections.longterm);
      await loadWeekDays(aid);
    } catch (err: any) {
      setSections({ facts: '', today: '', week: '', longterm: '' });
      setFactsDraft('');
      setTodayDraft('');
      setLongtermDraft('');
      setWeekDays([]);
      setWeekDrafts({});
      useSettingsStore.getState().showToast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const loadWeekDays = async (aid: string | null) => {
    try {
      const res = await lucFetch(`/api/memories/compiled/week/days?agentId=${aid}`);
      const data = await res.json();
      const days: WeekDay[] = Array.isArray(data.days) ? data.days : [];
      setWeekDays(days);
      setWeekDrafts(Object.fromEntries(days.map((d) => [d.date, d.body])));
    } catch (err: any) {
      setWeekDays([]);
      setWeekDrafts({});
      useSettingsStore.getState().showToast(err.message, 'error');
    }
  };

  const clearCompiled = async () => {
    try {
      const aid = useSettingsStore.getState().getSettingsAgentId();
      await lucFetch(`/api/memories/compiled?agentId=${aid}`, { method: 'DELETE' });
      setSections(prev => ({ ...prev, today: '', week: '', longterm: '' }));
      setTodayDraft('');
      setLongtermDraft('');
      setWeekDays([]);
      setWeekDrafts({});
      useSettingsStore.getState().showToast(t('settings.memory.compiledCleared'), 'success');
    } catch (err: any) {
      useSettingsStore.getState().showToast(err.message, 'error');
    }
  };

  const hasDraftChanges = factsDraft !== sections.facts
    || todayDraft !== sections.today
    || longtermDraft !== sections.longterm
    || weekDays.some((day) => (weekDrafts[day.date] ?? '') !== day.body);

  const putCompiledJson = async (url: string, body: Record<string, string>) => {
    const res = await lucFetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
  };

  const saveCompiledEdits = async () => {
    if (!hasDraftChanges) {
      setEditing(false);
      return;
    }

    setSavingAll(true);
    try {
      const aid = useSettingsStore.getState().getSettingsAgentId();
      const nextSections = { ...sections };
      let nextFactsDraft = factsDraft;
      let nextTodayDraft = todayDraft;
      let nextLongtermDraft = longtermDraft;
      let nextWeekDays = weekDays;
      const nextWeekDrafts = { ...weekDrafts };

      if (todayDraft !== sections.today) {
        const data = await putCompiledJson(
          `/api/memories/compiled/today?agentId=${aid}`,
          { today: todayDraft },
        );
        nextTodayDraft = typeof data.today === 'string' ? data.today : todayDraft;
        nextSections.today = nextTodayDraft;
      }

      if (factsDraft !== sections.facts) {
        const data = await putCompiledJson(
          `/api/memories/compiled/facts?agentId=${aid}`,
          { facts: factsDraft },
        );
        nextFactsDraft = typeof data.facts === 'string' ? data.facts : factsDraft;
        nextSections.facts = nextFactsDraft;
      }

      if (longtermDraft !== sections.longterm) {
        const data = await putCompiledJson(
          `/api/memories/compiled/longterm?agentId=${aid}`,
          { longterm: longtermDraft },
        );
        nextLongtermDraft = typeof data.longterm === 'string' ? data.longterm : longtermDraft;
        nextSections.longterm = nextLongtermDraft;
      }

      const changedWeekDays = weekDays.filter((day) => (weekDrafts[day.date] ?? '') !== day.body);
      for (const day of changedWeekDays) {
        const draft = weekDrafts[day.date] ?? '';
        const data = await putCompiledJson(
          `/api/memories/compiled/week/days/${day.date}?agentId=${aid}`,
          { body: draft },
        );
        const savedBody = typeof data.body === 'string' ? data.body : draft;
        nextWeekDrafts[day.date] = savedBody;
        nextWeekDays = nextWeekDays.map((item) => (item.date === day.date ? { ...item, body: savedBody } : item));
      }

      if (changedWeekDays.length > 0) {
        const refreshed = await lucFetch(`/api/memories/compiled?agentId=${aid}`);
        const refreshedData = await refreshed.json();
        if (refreshedData.error) throw new Error(refreshedData.error);
        if (typeof refreshedData.sections?.week === 'string') {
          nextSections.week = refreshedData.sections.week;
        }
      }

      setFactsDraft(nextFactsDraft);
      setTodayDraft(nextTodayDraft);
      setLongtermDraft(nextLongtermDraft);
      setWeekDrafts(nextWeekDrafts);
      setWeekDays(nextWeekDays);
      setSections(nextSections);
      setEditing(false);
      useSettingsStore.getState().showToast(t('settings.saved'), 'success');
    } catch (err: any) {
      useSettingsStore.getState().showToast(err.message, 'error');
    } finally {
      setSavingAll(false);
    }
  };

  const close = useCallback(() => setVisible(false), []);
  const handlePrimaryAction = () => {
    if (!editing) {
      setEditing(true);
      return;
    }
    void saveCompiledEdits();
  };
  const readonlyBlocks = [
    { key: 'facts', title: t('settings.memory.editableFactsLabel'), value: sections.facts },
    { key: 'today', title: t('settings.memory.sections.today'), value: sections.today },
    { key: 'week', title: t('settings.memory.sections.week'), value: sections.week },
    { key: 'longterm', title: t('settings.memory.sections.longterm'), value: sections.longterm },
  ];

  return (
    <Overlay
      scope="inline"
      open={visible}
      onClose={close}
      backdrop="blur"
      zIndex={100}
      className={`${styles['memory-viewer']} ${styles['compiled-memory-viewer']}`}
      backdropClassName={`${styles['memory-viewer-backdrop']} ${styles['compiled-memory-viewer-backdrop']}`}
      contained
      disableContainerAnimation
    >
        <div className={styles['memory-viewer-header']}>
          <h3 className={styles['memory-viewer-title']}>{t('settings.memory.compiled')}</h3>
          <div className={styles['memory-viewer-header-actions']}>
            <button
              className={styles['compiled-edit-toggle-btn']}
              onClick={handlePrimaryAction}
              disabled={loading || savingAll}
            >
              {editing ? t('settings.memory.editSave') : t('settings.memory.editEntry')}
            </button>
            <button className={styles['compiled-clear-btn']} onClick={clearCompiled} disabled={savingAll}>
              {t('settings.memory.compiledClear')}
            </button>
            <button className={styles['memory-viewer-close']} onClick={close}>✕</button>
          </div>
        </div>
        <div className={`${styles['memory-viewer-body']} ${styles['compiled-memory-body']}`}>
          {loading ? (
            <div className="memory-viewer-empty">Loading...</div>
          ) : editing ? (
            <div className={styles['compiled-memory-editable']}>
              <section className={styles['compiled-memory-edit-section']}>
                <label className={styles['compiled-memory-editor-label']} htmlFor="compiled-memory-today-editor">
                  {t('settings.memory.sections.today')}
                </label>
                <textarea
                  id="compiled-memory-today-editor"
                  className={styles['compiled-memory-facts-editor']}
                  value={todayDraft}
                  onChange={(event) => setTodayDraft(event.target.value)}
                  disabled={savingAll}
                />
              </section>

              <section className={styles['compiled-memory-edit-section']}>
                <label className={styles['compiled-memory-editor-label']} htmlFor="compiled-memory-facts-editor">
                  {t('settings.memory.editableFactsLabel')}
                </label>
                <textarea
                  id="compiled-memory-facts-editor"
                  className={styles['compiled-memory-facts-editor']}
                  value={factsDraft}
                  onChange={(event) => setFactsDraft(event.target.value)}
                  disabled={savingAll}
                />
              </section>

              <section className={styles['compiled-memory-edit-section']}>
                <div className={styles['compiled-memory-editor-label']}>
                  {t('settings.memory.sections.week')}
                </div>
                {weekDays.length === 0 ? (
                  <div className="memory-viewer-empty">{t('settings.memory.compiledEmpty')}</div>
                ) : (
                  <div className={styles['compiled-memory-week-days']}>
                    {weekDays.map((day) => (
                      <div className={styles['compiled-memory-week-day-row']} key={day.date}>
                        <div className={styles['compiled-memory-week-day-label']}>{day.date}</div>
                        <textarea
                          aria-label={day.date}
                          className={styles['compiled-memory-week-day-editor']}
                          value={weekDrafts[day.date] ?? ''}
                          onChange={(event) => setWeekDrafts(prev => ({ ...prev, [day.date]: event.target.value }))}
                          disabled={savingAll}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className={styles['compiled-memory-edit-section']}>
                <label className={styles['compiled-memory-editor-label']} htmlFor="compiled-memory-longterm-editor">
                  {t('settings.memory.sections.longterm')}
                </label>
                <textarea
                  id="compiled-memory-longterm-editor"
                  className={styles['compiled-memory-facts-editor']}
                  value={longtermDraft}
                  onChange={(event) => setLongtermDraft(event.target.value)}
                  disabled={savingAll}
                />
              </section>
            </div>
          ) : (
            <div ref={contentRef} className={styles['compiled-memory-readonly-list']}>
              {readonlyBlocks.map(block => (
                <section className={styles['compiled-memory-readonly-block']} key={block.key}>
                  <h4>{block.title}</h4>
                  {block.value.trim() ? (
                    <div
                      className={`${styles['compiled-memory-md']} ${'md-content'}`}
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(block.value) }}
                    />
                  ) : (
                    <div className="memory-viewer-empty">{t('settings.memory.compiledEmpty')}</div>
                  )}
                </section>
              ))}
            </div>
          )}
        </div>
    </Overlay>
  );
}
