export interface SettingsSearchNavItem {
  id: string;
  label: string;
}

export interface SettingsSearchEntry {
  id: string;
  tabId: string;
  titleKey?: string;
  title?: string;
  pathKeys?: string[];
  path?: string[];
  aliases?: string[];
}

export interface SettingsSearchResult {
  id: string;
  tabId: string;
  title: string;
  path: string;
  score: number;
}

type Translate = (key: string) => string;

const BUILT_IN_SETTINGS_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    id: 'agent-profile',
    tabId: 'agent',
    titleKey: 'settings.tabs.agent',
    pathKeys: ['settings.tabs.agent'],
    // 'AGENTS.md' 同时是工作区条目的别名，一个词命中两个设置项是预期的：
    // 人格文件和工作区注入都叫这个名字，用户搜它时两处都该出现。
    aliases: ['assistant', 'agent', 'persona', 'role', 'avatar', 'memory', 'yuan', 'AGENTS.md', '助手', '人设', '角色', '头像', '记忆', '源'],
  },
  {
    id: 'me-profile',
    tabId: 'me',
    titleKey: 'settings.tabs.me',
    pathKeys: ['settings.tabs.me'],
    aliases: ['me', 'user', 'profile', 'identity', '我', '用户', '个人资料', '自我介绍'],
  },
  {
    id: 'interface-theme',
    tabId: 'interface',
    titleKey: 'settings.appearance.theme',
    pathKeys: ['settings.tabs.interface'],
    aliases: ['theme', 'appearance', 'color', 'dark mode', 'paper', 'paper texture', '主题', '外观', '颜色', '深色', '浅色', '纸张纹理'],
  },
  {
    id: 'interface-font',
    tabId: 'interface',
    titleKey: 'settings.appearance.font',
    pathKeys: ['settings.tabs.interface'],
    aliases: ['font', 'serif', 'sans', 'typography', 'markdown font', 'reading width', 'document width', 'body width', 'chat width', 'chat body size', 'body size', '字体', '宋体', '黑体', '排版', 'Markdown 字体', '阅读宽度', '文档宽度', '正文宽度', '聊天宽度', '聊天字号', '正文字号'],
  },
  {
    id: 'interface-language',
    tabId: 'interface',
    titleKey: 'settings.locale.language',
    pathKeys: ['settings.tabs.interface'],
    aliases: ['language', 'locale', 'timezone', 'region', '语言', '界面语言', '时区', '地区'],
  },
  {
    id: 'interface-shortcuts',
    tabId: 'interface',
    titleKey: 'settings.interface.shortcuts',
    pathKeys: ['settings.tabs.interface'],
    aliases: ['shortcut', 'keyboard', 'voice shortcut', '快捷键', '键盘', '录音快捷键', '语音快捷键'],
  },
  {
    id: 'interface-sidebar',
    tabId: 'interface',
    titleKey: 'settings.interface.sidebar',
    pathKeys: ['settings.tabs.interface'],
    aliases: ['sidebar', 'session list', 'compact sessions', 'single line', 'density', '侧边栏', '会话列表', '单行', '紧凑', '密度'],
  },
  {
    id: 'general-startup',
    tabId: 'general',
    titleKey: 'settings.general.startup.title',
    pathKeys: ['settings.tabs.general'],
    aliases: ['startup', 'launch at login', 'keep awake', 'background', '开机', '自启', '后台', '锁屏', '保持运行'],
  },
  {
    id: 'general-quick-chat',
    tabId: 'general',
    titleKey: 'settings.general.quickChat.title',
    pathKeys: ['settings.tabs.general'],
    aliases: ['quick chat', 'mini chat', 'shortcut', 'reuse input', '快速聊天', '小窗', '快捷键', '保留输入框'],
  },
  {
    id: 'general-notifications',
    tabId: 'general',
    titleKey: 'settings.general.notifications.title',
    pathKeys: ['settings.tabs.general'],
    aliases: ['notification', 'chat completion', 'scheduled task', 'patrol', '通知', '聊天完成', '计划任务', '巡检', '完成提醒'],
  },
  {
    id: 'browser-cookies',
    tabId: 'browser',
    titleKey: 'settings.browser.cookiesTitle',
    pathKeys: ['settings.tabs.browser'],
    aliases: ['browser', 'cookies', 'site data', 'clear cookies', '浏览器', 'Cookie', '站点数据', '清除 Cookies'],
  },
  {
    id: 'browser-agent-behavior',
    tabId: 'browser',
    titleKey: 'settings.browser.agentTitle',
    pathKeys: ['settings.tabs.browser'],
    aliases: ['browser behavior', 'open page', 'new tab', 'current tab', '打开网页', '新标签页', '当前标签页'],
  },
  {
    id: 'work-home-folder',
    tabId: 'work',
    titleKey: 'settings.work.homeFolder',
    pathKeys: ['settings.tabs.work'],
    aliases: ['workspace', 'home folder', 'workbench', 'working directory', 'AGENTS.md', 'CLAUDE.md', '工作台', '工作目录', '项目目录', '说明注入'],
  },
  {
    id: 'work-heartbeat',
    tabId: 'work',
    titleKey: 'settings.work.heartbeatMaster',
    pathKeys: ['settings.tabs.work'],
    aliases: ['heartbeat', 'patrol', 'automation', 'background agent', '巡检', '后台任务', '自动化', '权限'],
  },
  {
    id: 'skills-management',
    tabId: 'skills',
    titleKey: 'settings.skills.title',
    pathKeys: ['settings.tabs.skills'],
    aliases: ['skills', 'capabilities', 'install skill', '技能', '能力', '安装技能'],
  },
  {
    id: 'bridge-platforms',
    tabId: 'bridge',
    titleKey: 'settings.tabs.bridge',
    pathKeys: ['settings.tabs.bridge'],
    aliases: ['bridge', 'wechat', 'telegram', 'social', 'phone', '社交平台', '微信', 'Telegram', '桥接', '手机'],
  },
  {
    id: 'providers-api-key',
    tabId: 'providers',
    titleKey: 'settings.api.apiKey',
    pathKeys: ['settings.tabs.providers'],
    aliases: ['api key', 'apikey', 'token', 'provider key', 'openai key', '模型 key', '供应商 key', '密钥', '令牌'],
  },
  {
    id: 'providers-models',
    tabId: 'providers',
    titleKey: 'settings.api.mainModelSection',
    pathKeys: ['settings.tabs.providers'],
    aliases: ['model', 'models', 'provider', 'base url', 'context length', 'reasoning effort', '模型', '供应商', 'Base URL', '上下文', '思考强度'],
  },
  {
    id: 'providers-search',
    tabId: 'providers',
    titleKey: 'settings.api.searchProvider',
    pathKeys: ['settings.tabs.providers'],
    aliases: ['search', 'search engine', 'tavily', 'brave', 'serper', 'anysearch', '搜索', '搜索引擎', '联网搜索', '搜索服务'],
  },
  {
    id: 'media-image-generation',
    tabId: 'media',
    titleKey: 'settings.media.imageGeneration',
    pathKeys: ['settings.tabs.media'],
    aliases: ['image generation', 'video generation', 'speech recognition', 'voice', '图片生成', '视频生成', '语音识别', '转录'],
  },
  {
    id: 'sharing-screenshot',
    tabId: 'sharing',
    titleKey: 'settings.tabs.sharing',
    pathKeys: ['settings.tabs.sharing'],
    aliases: ['share', 'screenshot', 'card', 'watermark', '分享', '截图', '卡片', '水印'],
  },
  {
    id: 'access-mobile',
    tabId: 'access',
    titleKey: 'settings.access.mobileAccess',
    pathKeys: ['settings.tabs.access'],
    aliases: ['access', 'mobile', 'pwa', 'lan', 'remote', 'port', 'qr code', '访问', '手机', '局域网', '远程', '端口', '二维码'],
  },
  {
    id: 'plugins-management',
    tabId: 'plugins',
    titleKey: 'settings.plugins.manageTitle',
    pathKeys: ['settings.tabs.plugins'],
    aliases: ['plugin', 'plugins', 'marketplace', 'dev tools', 'full access', '插件', '插件市场', '开发工具', '完全访问'],
  },
  {
    id: 'experiments-flags',
    tabId: 'experiments',
    titleKey: 'settings.tabs.experiments',
    pathKeys: ['settings.tabs.experiments'],
    aliases: ['experiment', 'beta', 'preview', 'computer use', '实验', '预览', '测试', '电脑使用'],
  },
  {
    id: 'security-sandbox',
    tabId: 'security',
    titleKey: 'settings.security.sandbox',
    pathKeys: ['settings.tabs.security'],
    aliases: ['sandbox', 'network sandbox', 'file backup', 'archived chats', 'proxy', 'security', '沙盒', '联网', '文件备份', '归档对话', '代理', '安全'],
  },
  {
    id: 'security-proxy',
    tabId: 'security',
    titleKey: 'settings.security.networkProxy',
    pathKeys: ['settings.tabs.security'],
    aliases: ['proxy', 'http proxy', 'socks', 'network', '代理', '出站代理', '网络代理', '直连'],
  },
  {
    id: 'about-updates',
    tabId: 'about',
    titleKey: 'settings.about.title',
    pathKeys: ['settings.tabs.about'],
    aliases: ['about', 'version', 'update', 'license', '关于', '版本', '更新', '许可证'],
  },
];

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function translated(entry: SettingsSearchEntry, translate: Translate): { title: string; path: string } {
  const title = entry.titleKey ? translate(entry.titleKey) : entry.title || '';
  const pathParts = entry.pathKeys?.length
    ? entry.pathKeys.map(key => translate(key))
    : entry.path || (title ? [title] : []);
  return {
    title,
    path: pathParts.filter(Boolean).join(' / '),
  };
}

function scoreCandidate(query: string, fields: string[]): number {
  const normalizedFields = fields.map(normalizeSearchText).filter(Boolean);
  if (normalizedFields.length === 0) return 0;

  let best = 0;
  for (const [index, field] of normalizedFields.entries()) {
    if (!field) continue;
    const fieldWeight = index === 0 ? 40 : index === 1 ? 24 : 12;
    if (field === query) best = Math.max(best, 120 + fieldWeight);
    if (field.startsWith(query)) best = Math.max(best, 92 + fieldWeight);
    if (field.includes(query)) best = Math.max(best, 68 + fieldWeight);
  }

  const tokens = query.split(' ').filter(Boolean);
  if (tokens.length > 1) {
    const haystack = normalizedFields.join(' ');
    if (tokens.every(token => haystack.includes(token))) {
      best = Math.max(best, 58 + tokens.length * 4);
    }
  }

  return best;
}

export function buildSettingsSearchEntries(navItems: SettingsSearchNavItem[]): SettingsSearchEntry[] {
  const navEntries = navItems.map(item => ({
    id: item.id,
    tabId: item.id,
    title: item.label,
    path: [item.label],
    aliases: [item.id],
  }));
  const builtInIds = new Set(BUILT_IN_SETTINGS_SEARCH_ENTRIES.map(entry => entry.id));
  return [
    ...BUILT_IN_SETTINGS_SEARCH_ENTRIES,
    ...navEntries.filter(entry => !builtInIds.has(entry.id)),
  ];
}

export function searchSettings(
  query: string,
  entries: SettingsSearchEntry[],
  translate: Translate,
  limit = 12,
): SettingsSearchResult[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];

  return entries
    .map(entry => {
      const { title, path } = translated(entry, translate);
      const fields = [title, path, ...(entry.aliases || [])];
      const score = scoreCandidate(normalizedQuery, fields);
      return { id: entry.id, tabId: entry.tabId, title, path, score };
    })
    .filter(result => result.score > 0)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit);
}
