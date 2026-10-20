import { useMemo, useEffect, useState } from 'react';
import { lucFetch } from './use-luc-fetch';
import { useStore } from '../stores';
import { getSkillIcon } from '../utils/skill-icons';
import type { SlashItem } from '../components/input/slash-commands';

interface SkillInfo {
  name: string;
  description: string;
  hidden: boolean;
  enabled: boolean;
}

interface ServerCommandInfo {
  name: string;
  aliases?: string[];
  description?: string;
  scope?: string;
  source?: string;
}

const SERVER_COMMAND_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m4 17 6-6-6-6"/><path d="M12 19h8"/></svg>';

/**
 * Fetch enabled, visible skills for the current agent.
 * Returns a stable array that only updates when skills change.
 */
export function useSkillSlashItems({
  enabled = true,
  agentId: explicitAgentId = null,
}: {
  enabled?: boolean;
  agentId?: string | null;
} = {}): SlashItem[] {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const currentAgentId = useStore(s => s.currentAgentId);
  const agentId = explicitAgentId || currentAgentId;
  const skillCatalogVersion = useStore(s => s.skillCatalogVersion);

  useEffect(() => {
    if (!enabled) {
      setSkills([]);
      return;
    }
    if (!agentId) {
      setSkills([]);
      return;
    }
    let cancelled = false;
    setSkills([]);
    lucFetch(`/api/skills?agentId=${encodeURIComponent(agentId)}&runtime=1`)
      .then(r => r.json())
      .then(data => {
        if (!cancelled && data.skills) setSkills(data.skills);
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // skills 是 per-agent 的，不随 session 切换变化
  }, [agentId, enabled, skillCatalogVersion]);

  return useMemo(() =>
    skills
      .filter(s => s.enabled && !s.hidden)
      .map(s => ({
        name: s.name,
        label: `/${s.name}`,
        description: s.description || '',
        busyLabel: '',
        icon: getSkillIcon(s.name),
        type: 'skill' as const,
        execute: () => {},  // placeholder, actual insertion handled by InputArea
      })),
    [skills],
  );
}

/**
 * Fetch server-side slash commands contributed by plugins.
 * Core commands stay hidden on desktop because the desktop UI already has first-class controls.
 */
export function useServerSlashCommandItems({
  enabled = true,
  agentId: explicitAgentId = null,
}: {
  enabled?: boolean;
  agentId?: string | null;
} = {}): SlashItem[] {
  const [commands, setCommands] = useState<ServerCommandInfo[]>([]);
  const currentAgentId = useStore(s => s.currentAgentId);
  const agentId = explicitAgentId || currentAgentId;

  useEffect(() => {
    if (!enabled) {
      setCommands([]);
      return;
    }
    let cancelled = false;
    setCommands([]);
    const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
    lucFetch(`/api/commands${query}`)
      .then(r => r.json())
      .then(data => {
        if (!cancelled && Array.isArray(data.commands)) setCommands(data.commands);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [agentId, enabled]);

  return useMemo(() =>
    commands
      .filter(command => command.name && command.source === 'plugin')
      .map(command => ({
        name: command.name,
        aliases: Array.isArray(command.aliases) ? command.aliases : [],
        label: `/${command.name}`,
        description: command.description || '',
        busyLabel: '',
        icon: SERVER_COMMAND_ICON,
        type: 'server-command' as const,
        execute: () => {},
      })),
    [commands],
  );
}
