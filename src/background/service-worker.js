// Phase 0 / P0-2：默认值、预设、版本号、迁移逻辑只在 settings-schema.js 定义一份。
importScripts('../shared/settings-schema.js');
const {
  CURRENT_SETTINGS_VERSION,
  DEFAULT_SETTINGS,
  deepMerge,
  migrateSettings,
  normalizeSettings,
} = globalThis.HDRSettings;

const MESSAGE_TYPES = {
  GET_SETTINGS: 'GET_SETTINGS',
  SET_SETTINGS: 'SET_SETTINGS',
  SETTINGS_UPDATED: 'SETTINGS_UPDATED',
};

const STORAGE_KEY = 'hdr_vision_global';

// 迁移逻辑统一在 settings-schema.js；这里只负责读写 storage 与广播。
async function getSettings() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const stored = result[STORAGE_KEY];

  if (stored && stored._version !== CURRENT_SETTINGS_VERSION) {
    console.log('[HDR Vision] Migrating settings', stored._version, '->', CURRENT_SETTINGS_VERSION);
    const migrated = migrateSettings(stored);
    if (typeof stored.enabled === 'boolean') migrated.enabled = stored.enabled;
    await chrome.storage.local.set({ [STORAGE_KEY]: migrated });
    // P2-10：所有出口都过一次 normalize，保证 deband/sharpen 等不变量成立
    return normalizeSettings(deepMerge(DEFAULT_SETTINGS, migrated));
  }

  if (stored) return normalizeSettings(deepMerge(DEFAULT_SETTINGS, stored));
  return normalizeSettings(DEFAULT_SETTINGS);
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ [STORAGE_KEY]: settings });
}

// P2-8：MV3 的 onMessage 对每个消息独立调用 handleMessage，两个 SET_SETTINGS
// 可能并发执行。这里把「写盘 + 广播」整体排队，保证到达顺序与落盘顺序一致；
// 读取也要等队列排空，避免读到旧值后广播出去。
let _settingsChain = Promise.resolve();

function enqueueSettingsUpdate(settings) {
  const job = _settingsChain.then(async () => {
    await saveSettings(settings);
    await notifyContentScripts(settings);
  });
  // 一次失败不能让后续消息永远排不上队
  _settingsChain = job.catch(() => {});
  return job;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // P0-4：任何异常都必须回传，否则 popup 只能等 2 秒超时并把失败误判为成功。
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((e) => {
      console.error('[HDR Vision] handleMessage failed:', e);
      sendResponse({ error: String(e && e.message ? e.message : e) });
    });
  return true;
});

async function handleMessage(message, sender) {
  const { type, data } = message;
  switch (type) {
    case MESSAGE_TYPES.GET_SETTINGS:
      // P2-8：读之前等写队列排空，避免读到写入前的旧配置
      await _settingsChain;
      return { settings: await getSettings() };
    case MESSAGE_TYPES.SET_SETTINGS: {
      const { settings } = data || {};
      if (!settings) return { error: 'Settings are required' };
      // 确保保存时带上版本号
      settings._version = CURRENT_SETTINGS_VERSION;
      await enqueueSettingsUpdate(settings);
      return { success: true };
    }
    default:
      return { error: 'Unknown message type' };
  }
}

// P1-5：失败计数限频，避免每个无接收方的标签都刷一条日志
let _notifyFailCount = 0;
async function notifyContentScripts(settings) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id == null) continue;
      // P1-5：内容脚本只注入 http/https 页面，跳过 chrome:// / about: 等无接收方的标签
      if (tab.url && !/^https?:\/\//i.test(tab.url)) continue;
      // ★ fire-and-forget：不 await，不阻塞
      // ★ frameId: 0 只发主 frame，避免 iframe 挂起
      chrome.tabs.sendMessage(
        tab.id,
        {
          type: MESSAGE_TYPES.SETTINGS_UPDATED,
          data: { settings },
        },
        { frameId: 0 }
      ).catch(() => {
        // "no receiver" 属正常（页面无内容脚本），仅限频记录以保留可观测性
        _notifyFailCount++;
        if (_notifyFailCount <= 3 || _notifyFailCount % 50 === 0) {
          console.warn('[HDR Vision] settings 广播无接收方（累计 ' + _notifyFailCount + ' 次）');
        }
      });
    }
  } catch (e) {
    console.error('Error notifying content scripts:', e);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) updateBadgeForActiveTab();
});

chrome.tabs.onActivated.addListener(() => updateBadgeForActiveTab());
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) updateBadgeForActiveTab();
});

async function updateBadgeForActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const settings = await getSettings();
    if (settings.enabled) {
      await chrome.action.setBadgeText({ text: '', tabId: tab.id });
    } else {
      await chrome.action.setBadgeText({ text: 'OFF', tabId: tab.id });
      await chrome.action.setBadgeBackgroundColor({ color: '#6b7280', tabId: tab.id });
    }
  } catch {}
}

updateBadgeForActiveTab();