import { fetchHltbData } from '../services/hltbApi';
import { log } from '../services/logger';
import { findModuleExport, replacePatch } from '@steambrew/client';
import { getSettings, subscribeSettings } from '../services/settings';

type SortMetric = 'comp_main' | 'comp_plus' | 'comp_100';
type SortDirection = 'asc';

interface SortChoice {
  metric: SortMetric;
  direction: SortDirection;
}

interface NativeGridTarget {
  type: 'collection' | 'showcase';
  value: any[];
}

const STORAGE_KEY = 'hltb-library-sort';
const attempted = new Set<number>();
const pending = new Set<number>();
const inFlightApps = new Set<number>();
const ready = new Map<number, { comp_main?: number | null; comp_plus?: number | null; comp_100?: number | null }>();

let documentRef: Document | null = null;
let installInterval: number | null = null;
let active = false;
let requestsInFlight = 0;
let nativeDropdownClass: any = null;
let nativeRenderPatch: any = null;
let nativeUpdatePatch: any = null;
const nativeDropdownInstances = new Set<any>();
let unsubscribeSettings: (() => void) | null = null;
let originalArraySort: typeof Array.prototype.sort | null = null;
let hltbArraySort: typeof Array.prototype.sort | null = null;
let appOverviewSortLogged = false;

function getChoice(): SortChoice | null {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (
      value &&
      ['comp_main', 'comp_plus', 'comp_100'].includes(value.metric) &&
      ['asc', 'desc'].includes(value.direction)
    ) {
      const normalizedChoice: SortChoice = {
        metric: value.metric,
        direction: 'asc',
      };
      if (value.direction !== 'asc') {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizedChoice));
      }
      const settings = getSettings();
      if (!settings.librarySortEnabled) return null;
      if (value.metric === 'comp_main' && !settings.sortByMainStory) return null;
      if (value.metric === 'comp_plus' && !settings.sortByMainPlusExtras) return null;
      if (value.metric === 'comp_100' && !settings.sortByCompletionist) return null;
      return normalizedChoice;
    }
  } catch {
    // Ignore invalid saved settings.
  }
  return null;
}

function emitChange(): void {
  refreshNativeViews();
}

function getAppId(value: unknown, depth = 0): number | null {
  if (!value || typeof value !== 'object' || depth > 8) return null;
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = getAppId(child, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const obj = value as Record<string, unknown>;

  for (const key of ['appid', 'appId', 'unAppID', 'nAppID', 'm_unAppID']) {
    const id = Number(obj[key]);
    if (Number.isInteger(id) && id > 0) return id;
  }

  for (const key of ['item', 'app', 'overview', 'm_overview', 'data', 'props', 'children', 'childElements']) {
    const found = getAppId(obj[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function getGameName(appId: number): string | undefined {
  try {
    return (window as any).appStore?.GetAppOverviewByAppID(appId)?.display_name;
  } catch {
    return undefined;
  }
}

function requestGameData(appId: number): void {
  if (attempted.has(appId) || pending.has(appId) || inFlightApps.has(appId)) return;
  pending.add(appId);
  void pumpRequests();
}

async function pumpRequests(): Promise<void> {
  while (requestsInFlight < 3 && pending.size > 0) {
    const appId = pending.values().next().value as number;
    pending.delete(appId);
    inFlightApps.add(appId);
    requestsInFlight += 1;
    void fetchHltbData(appId, getGameName(appId))
      .then(({ data }) => {
        if (data?.game_id) {
          ready.set(appId, {
            comp_main: data.comp_main,
            comp_plus: data.comp_plus,
            comp_100: data.comp_100,
          });
        }
      })
      .catch((error) => log('Library sort data fetch failed:', appId, error))
      .finally(() => {
        attempted.add(appId);
        inFlightApps.delete(appId);
        requestsInFlight -= 1;
        emitChange();
        void pumpRequests();
      });
  }
}

function getFiber(instance: any): any {
  return instance?._reactInternals?.return ?? instance?._reactInternalFiber?.return ?? null;
}

function findNativeGridTarget(instance: any): NativeGridTarget | null {
  const extractShowcaseElements = (sibling: any): any[] | null => {
    const rawProps = sibling?.pendingProps ?? sibling?.memoizedProps;
    const children = Array.isArray(rawProps) ? rawProps : rawProps?.children;
    if (!Array.isArray(children)) return null;
    for (const element of children) {
      if (Array.isArray(element?.props?.childElements)) return element.props.childElements;
    }
    return null;
  };

  let fiber = getFiber(instance);
  let fallbackSections: any[] | null = null;
  let fallbackShowcase: any[] | null = null;
  for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) {
    const sectionsA = fiber.sibling?.pendingProps?.childSections;
    const sectionsB = fiber.alternate?.sibling?.pendingProps?.childSections;
    if (Array.isArray(sectionsA)) {
      if (!(sectionsA as any).__hltbProcessed) return { type: 'collection', value: sectionsA };
      fallbackSections = fallbackSections ?? sectionsA;
    }
    if (Array.isArray(sectionsB)) {
      if (!(sectionsB as any).__hltbProcessed) return { type: 'collection', value: sectionsB };
      fallbackSections = fallbackSections ?? sectionsB;
    }

    const showcase = fiber.pendingProps?.showcase ?? fiber.memoizedProps?.showcase;
    if (showcase) {
      const elementsA = extractShowcaseElements(fiber.sibling);
      const elementsB = extractShowcaseElements(fiber.alternate?.sibling);
      if (elementsA && !(elementsA as any).__hltbProcessed) return { type: 'showcase', value: elementsA };
      if (elementsB && !(elementsB as any).__hltbProcessed) return { type: 'showcase', value: elementsB };
      fallbackShowcase = fallbackShowcase ?? elementsA ?? elementsB;
    }
  }
  if (fallbackSections) return { type: 'collection', value: fallbackSections };
  if (fallbackShowcase) return { type: 'showcase', value: fallbackShowcase };
  return null;
}

function sortNativeItems(items: any[], choice: SortChoice): any[] {
  const indexed = items.map((item, index) => ({ item, index, appId: getAppId(item) }));
  for (const row of indexed) {
    if (row.appId) requestGameData(row.appId);
  }

  indexed.sort((a, b) => {
    const aTime = a.appId ? ready.get(a.appId)?.[choice.metric] : null;
    const bTime = b.appId ? ready.get(b.appId)?.[choice.metric] : null;
    const aKnown = typeof aTime === 'number' && Number.isFinite(aTime) && aTime > 0;
    const bKnown = typeof bTime === 'number' && Number.isFinite(bTime) && bTime > 0;
    if (aKnown !== bKnown) return aKnown ? -1 : 1;
    if (!aKnown || !bKnown) return a.index - b.index;
    const delta = (aTime! - bTime!) * (choice.direction === 'asc' ? 1 : -1);
    return delta || a.index - b.index;
  });

  return indexed.map(({ item }) => item);
}

function refreshNativeViews(): void {
  for (const instance of nativeDropdownInstances) {
    try {
      let fiber = getFiber(instance);
      let passedGridController = false;
      let updated = false;
      for (let depth = 0; fiber && depth < 30; depth += 1, fiber = fiber.return) {
        if (Array.isArray(fiber.memoizedProps?.appOverviews) || Boolean(fiber.memoizedProps?.showcase)) {
          passedGridController = true;
        }
        if (passedGridController && typeof fiber.stateNode?.forceUpdate === 'function') {
          fiber.stateNode.forceUpdate();
          updated = true;
        }
      }
      if (!updated) instance.forceUpdate?.();
    } catch {
      nativeDropdownInstances.delete(instance);
    }
  }
}

function isSteamAppOverviewArray(value: unknown): value is Record<string, any>[] {
  try {
    return Array.isArray(value) &&
      value.length > 1 &&
      value.every((item) =>
        item &&
        typeof item === 'object' &&
        Number.isInteger(Number(item.appid)) &&
        Number(item.appid) > 0 &&
        (typeof item.sort_as === 'string' || typeof item.display_name === 'string'),
      );
  } catch {
    return false;
  }
}

function installAppOverviewSortPatch(): boolean {
  if (hltbArraySort) return Array.prototype.sort === hltbArraySort;

  originalArraySort = Array.prototype.sort;
  const steamSort = originalArraySort;
  const patchedSort = function<T>(
    this: T[],
    compareFn?: (a: T, b: T) => number,
  ): T[] {
    const isNativeAppSort =
      typeof compareFn === 'function' &&
      compareFn.toString().includes('CompareSortAs') &&
      isSteamAppOverviewArray(this);

    const choice = active && isNativeAppSort ? getChoice() : null;
    if (!choice || !isNativeAppSort) {
      return steamSort.call(this, compareFn);
    }

    const apps = this as unknown as Record<string, any>[];
    for (const app of apps) requestGameData(Number(app.appid));
    if (!appOverviewSortLogged) {
      appOverviewSortLogged = true;
      log('Intercepted Steam app-overview sort for HLTB ordering', {
        metric: choice.metric,
        direction: choice.direction,
        appCount: apps.length,
      });
    }

    return steamSort.call(this, (a: T, b: T) => {
      const aApp = a as Record<string, any>;
      const bApp = b as Record<string, any>;
      const aTime = ready.get(Number(aApp.appid))?.[choice.metric];
      const bTime = ready.get(Number(bApp.appid))?.[choice.metric];
      const aKnown = typeof aTime === 'number' && Number.isFinite(aTime) && aTime > 0;
      const bKnown = typeof bTime === 'number' && Number.isFinite(bTime) && bTime > 0;

      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      if (aKnown && bKnown) {
        const delta = aTime! - bTime!;
        if (delta) return delta;
      }
      return compareFn!(a, b);
    });
  } as typeof Array.prototype.sort;

  originalArraySort = steamSort;
  hltbArraySort = patchedSort;
  Array.prototype.sort = patchedSort;
  log('Installed Steam app-overview sort hook');
  return true;
}

function uninstallAppOverviewSortPatch(): void {
  if (hltbArraySort && originalArraySort && Array.prototype.sort === hltbArraySort) {
    Array.prototype.sort = originalArraySort;
  }
  originalArraySort = null;
  hltbArraySort = null;
  appOverviewSortLogged = false;
}

const NATIVE_HLTB_OPTIONS = [
  { label: 'HLTB: Main Story', data: 'comp_main:asc' },
  { label: 'HLTB: Main + Extras', data: 'comp_plus:asc' },
  { label: 'HLTB: Completionist', data: 'comp_100:asc' },
];

function getEnabledNativeSortOptions(): typeof NATIVE_HLTB_OPTIONS {
  const settings = getSettings();
  if (!settings.librarySortEnabled) return [];
  return NATIVE_HLTB_OPTIONS.filter((option) => {
    if (option.data.startsWith('comp_main:')) return settings.sortByMainStory;
    if (option.data.startsWith('comp_plus:')) return settings.sortByMainPlusExtras;
    return settings.sortByCompletionist;
  });
}

function transformNativeDropdown(instance: any, vdom: any): any {
  const target = findNativeGridTarget(instance);
  const children = vdom?.props?.children;
  const dropdown = Array.isArray(children)
    ? children[1]?.props?.rgOptions
      ? children[1]
      : children.find((child: any) => Array.isArray(child?.props?.rgOptions))
    : null;
  if (!target || !Array.isArray(dropdown?.props?.rgOptions)) {
    if (!(instance.__hltbDetectionLogged)) {
      instance.__hltbDetectionLogged = true;
      log('Native Sort By render did not match expected collection/dropdown shape', {
        targetFound: Boolean(target),
        childrenArray: Array.isArray(children),
        childCount: Array.isArray(children) ? children.length : null,
      });
    }
    nativeDropdownInstances.delete(instance);
    return vdom;
  }

  nativeDropdownInstances.add(instance);

  const props = dropdown.props;
  const baseOptions = props.__hltbBaseOptions ?? props.rgOptions.filter(
    (option: any) => !NATIVE_HLTB_OPTIONS.some((custom) => custom.data === option?.data),
  );
  const originalOnChange = props.__hltbOriginalOnChange ?? props.onChange;
  const baseSelectedOption = props.__hltbBaseSelectedOption ?? props.selectedOption;
  const choice = getChoice();
  props.__hltbBaseOptions = baseOptions;
  props.__hltbOriginalOnChange = originalOnChange;
  props.__hltbBaseSelectedOption = baseSelectedOption;
  const enabledOptions = getEnabledNativeSortOptions();
  props.rgOptions = [...baseOptions, ...enabledOptions];
  props.selectedOption = choice
    ? `${choice.metric}:${choice.direction}`
    : baseSelectedOption;
  props.onChange = (option: any, ...args: any[]) => {
    const selection = String(option?.data ?? '');
    if (enabledOptions.some((item) => item.data === selection)) {
      const [metric, direction] = selection.split(':');
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ metric, direction }));
      // Steam's state change triggers a grid render; the app-overview sort hook
      // replaces its native comparator before that render reaches the grid.
      originalOnChange?.({ ...option, data: 1 }, ...args);
    } else {
      localStorage.removeItem(STORAGE_KEY);
      originalOnChange?.(option, ...args);
    }
    refreshNativeViews();
  };
  if (!instance.__hltbDetectionLogged) {
    instance.__hltbDetectionLogged = true;
    log('Native Sort By HLTB options injected', {
      nativeOptionCount: baseOptions.length,
      hltbOptionCount: enabledOptions.length,
    });
  }
  return vdom;
}

function installNativeSortPatch(): boolean {
  if (nativeRenderPatch) return true;
  nativeDropdownClass = findModuleExport((value: any) =>
    typeof value === 'function' &&
    typeof value.prototype?.OnChange === 'function' &&
    value.toString().includes('onSortChangeCallback'),
  );
  if (!nativeDropdownClass?.prototype) return false;
  if (typeof nativeDropdownClass.prototype.render !== 'function') return false;

  if (typeof nativeDropdownClass.prototype.shouldComponentUpdate === 'function') {
    nativeUpdatePatch = replacePatch(
      nativeDropdownClass.prototype,
      'shouldComponentUpdate',
      () => true,
    );
  }

  let patch: any;
  patch = replacePatch(
    nativeDropdownClass.prototype,
    'render',
    function(this: any, args: any[]) {
      nativeDropdownInstances.add(this);
      if (!this.__hltbMobxRender) {
        const instance = this;
        const defineProperty = Object.defineProperty;
        Object.defineProperty = function(target: any, property: PropertyKey, descriptor: PropertyDescriptor) {
          if (
            target === instance &&
            property === 'render' &&
            typeof descriptor.value === 'function'
          ) {
            instance.__hltbMobxRender = descriptor.value;
            return target;
          }
          return defineProperty.call(Object, target, property, descriptor);
        } as typeof Object.defineProperty;

        try {
          const result = patch.original.apply(this, args);
          if (!this.__hltbNativeRefreshQueued && !this.__hltbNativeRefreshDone) {
            this.__hltbNativeRefreshQueued = true;
            setTimeout(() => {
              this.__hltbNativeRefreshQueued = false;
              this.__hltbNativeRefreshDone = true;
              this.forceUpdate?.();
            }, 0);
          }
          return this.__hltbMobxRender
            ? result
            : transformNativeDropdown(this, result);
        } finally {
          Object.defineProperty = defineProperty;
        }
      }
      return transformNativeDropdown(this, this.__hltbMobxRender.apply(this, args));
    },
  );
  nativeRenderPatch = patch;
  log('Installed native Steam Sort By menu integration');
  return true;
}

export function setupLibrarySort(doc: Document): void {
  if (documentRef === doc && active) return;
  disconnectLibrarySort();
  documentRef = doc;
  active = true;
  unsubscribeSettings = subscribeSettings(() => {
    emitChange();
  });

  const tryInstall = () => {
    if (!active) return;
    installNativeSortPatch();
    installAppOverviewSortPatch();
  };
  tryInstall();
  installInterval = window.setInterval(tryInstall, 2000);
}

export function disconnectLibrarySort(): void {
  active = false;
  if (installInterval !== null) {
    window.clearInterval(installInterval);
    installInterval = null;
  }
  nativeRenderPatch?.unpatch?.();
  nativeUpdatePatch?.unpatch?.();
  nativeRenderPatch = null;
  nativeUpdatePatch = null;
  nativeDropdownClass = null;
  nativeDropdownInstances.clear();
  uninstallAppOverviewSortPatch();
  unsubscribeSettings?.();
  unsubscribeSettings = null;
  documentRef = null;
}
