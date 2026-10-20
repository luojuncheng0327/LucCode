export interface ModelRef {
  id: string;
  provider?: string;
}

export interface ModelOption extends ModelRef {
  provider: string;
  name?: string;
}

export interface AutomationExecutor {
  kind?: string;
  action?: string;
  agentId?: string | null;
  pluginId?: string;
  actionId?: string;
  params?: Record<string, unknown>;
  prompt?: string;
}

export interface CronJob {
  id: string;
  type?: 'at' | 'every' | 'cron';
  enabled: boolean;
  label?: string;
  prompt?: string;
  schedule: string | number;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  createdAt?: string;
  model?: string | ModelRef;
  actorAgentId?: string;
  executor?: AutomationExecutor;
}
