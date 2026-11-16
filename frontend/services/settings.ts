import { callable } from '@steambrew/client';
import { log, logError } from './logger';

export type StorePosition = 'top' | 'achievements' | 'details' | 'bottom';

export interface PluginSettings {
  showInLibrary: boolean;
  showInStore: boolean;
  showViewDetails: boolean;
  alignRight: boolean;
  alignBottom: boolean;
  horizontalOffset: number;
  verticalOffset: number;
  storePosition: StorePosition;
  showStoreViewDetails: boolean;
  librarySortEnabled: boolean;
  sortByMainStory: boolean;
  sortByMainPlusExtras: boolean;
  sortByCompletionist: boolean;
}

interface SettingsResponse {
  success: boolean;
  error?: string;
  data?: PluginSettings;
}

const DEFAULT_SETTINGS: PluginSettings = {
  showInLibrary: true,
  showInStore: true,
  showViewDetails: true,
  alignRight: true,
  alignBottom: true,
  horizontalOffset: 0,
  verticalOffset: 0,
  storePosition: 'achievements' as StorePosition,
  showStoreViewDetails: true,
  librarySortEnabled: true,
  sortByMainStory: true,
  sortByMainPlusExtras: true,
  sortByCompletionist: true,
};

const GetSettingsRpc = callable<[], string>('GetSettings');
const SaveSettingsRpc = callable<[{ settings_json: string }], string>('SaveSettings');

let cachedSettings: PluginSettings = { ...DEFAULT_SETTINGS };
const settingsListeners = new Set<(settings: PluginSettings) => void>();

function notifySettingsChanged(): void {
  for (const listener of settingsListeners) {
    try {
      listener(cachedSettings);
    } catch (e) {
      logError('Settings listener failed:', e);
    }
  }
}

export function subscribeSettings(listener: (settings: PluginSettings) => void): () => void {
  settingsListeners.add(listener);
  return () => settingsListeners.delete(listener);
}

export async function initSettings(): Promise<void> {
  try {
    const resultJson = await GetSettingsRpc();
    if (!resultJson) return;

    const result: SettingsResponse = JSON.parse(resultJson);
    if (result.success && result.data) {
      cachedSettings = { ...DEFAULT_SETTINGS, ...result.data };
      notifySettingsChanged();
      log('Settings loaded from backend');
    }
  } catch (e) {
    logError('Failed to load settings:', e);
  }
}

export function getSettings(): PluginSettings {
  return cachedSettings;
}

export async function saveSettings(settings: PluginSettings): Promise<void> {
  const previous = cachedSettings;
  cachedSettings = settings;
  notifySettingsChanged();

  try {
    const resultJson = await SaveSettingsRpc({ settings_json: JSON.stringify(settings) });
    if (!resultJson) return;

    const result = JSON.parse(resultJson);
    if (!result.success) {
      logError('Failed to save settings:', result.error);
      cachedSettings = previous;
      notifySettingsChanged();
    }
  } catch (e) {
    logError('Failed to save settings:', e);
    cachedSettings = previous;
    notifySettingsChanged();
  }
}
