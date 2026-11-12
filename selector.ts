import {
  fuzzyFilter,
  Input,
  matchesKey,
  type SelectItem,
  SelectList,
  truncateToWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import { SKILL_ACTIONS, type SkillAction, type SkillScope } from './modes.ts';

export type SkillRow = {
  name: string;
  owner?: string;
  onDemand: boolean;
  globalOnDemand: boolean;
  source: string;
  tokens: number;
  detail: string;
  description?: string;
};

export type SelectorOptions = {
  project: string;
  rows(): SkillRow[];
  change(name: string, scope: SkillScope, action: SkillAction): Promise<void>;
  theme: {
    fg(
      color:
        | 'accent'
        | 'dim'
        | 'text'
        | 'success'
        | 'warning'
        | 'error'
        | 'muted',
      text: string,
    ): string;
    bold(text: string): string;
    italic(text: string): string;
  };
  maxVisibleRows?: number;
  requestRender(): void;
  close(): void;
  matches?: (
    data: string,
    action:
      | 'tui.select.up'
      | 'tui.select.down'
      | 'tui.select.confirm'
      | 'tui.select.cancel',
  ) => boolean;
};

export function createSkillSelector(options: SelectorOptions) {
  const { theme } = options;
  const search = new Input();
  let scope: SkillScope = 'project';
  let saving = false;
  let closeRequested = false;
  let status = 'Changes save immediately. off = on-demand, not disabled.';

  let filteredItems: SelectItem[] = [];

  function isOnDemand(row: SkillRow): boolean {
    return scope === 'global' ? row.globalOnDemand : row.onDemand;
  }

  function modeColor(row: SkillRow | undefined) {
    return row && isOnDemand(row) ? 'warning' : 'success';
  }

  function filteredRows(): SkillRow[] {
    return fuzzyFilter(options.rows(), search.getValue(), (row) => row.name)
      .sort((left, right) =>
        Number(isOnDemand(left)) - Number(isOnDemand(right)) ||
        left.name.localeCompare(right.name)
      );
  }

  function createList(selectedName?: string) {
    filteredItems = filteredRows().map((row) => ({
      value: row.name,
      label: row.name,
      // Color from row data; SelectList passes only rendered text to its theme.
      description: theme.fg(
        modeColor(row),
        `${isOnDemand(row) ? 'off' : 'on'} · ${row.owner ?? 'Unknown'}`,
      ),
    }));
    const nextList = new SelectList(
      filteredItems,
      options.maxVisibleRows ?? 10,
      {
        selectedPrefix: (text) => theme.fg('accent', text),
        selectedText: (text) => theme.fg(modeColor(selectedRow()), text),
        description: (text) => text,
        scrollInfo: (text) => theme.fg('dim', text),
        noMatch: () => theme.fg('muted', 'No matching skills'),
      },
    );
    const selectedIndex = filteredItems.findIndex((item) =>
      item.value === selectedName
    );
    if (selectedIndex >= 0) nextList.setSelectedIndex(selectedIndex);
    return nextList;
  }
  let list = createList();

  function rebuildList(): void {
    list = createList(list.getSelectedItem()?.value);
  }

  function selectedRow(): SkillRow | undefined {
    const name = list.getSelectedItem()?.value;
    return options.rows().find((row) => row.name === name);
  }

  function moveSelection(offset: -1 | 1): void {
    if (filteredItems.length === 0) return;
    const selectedName = list.getSelectedItem()?.value;
    const selectedIndex = Math.max(
      0,
      filteredItems.findIndex((item) => item.value === selectedName),
    );
    list.setSelectedIndex(
      (selectedIndex + offset + filteredItems.length) % filteredItems.length,
    );
  }

  async function save(
    rows: SkillRow[],
    mode: SkillAction,
    saved: string,
  ): Promise<void> {
    if (rows.length === 0) return;
    saving = true;
    status = 'Saving…';
    options.requestRender();
    try {
      for (const row of rows) await options.change(row.name, scope, mode);
      status = `Saved ${saved}. Applies on the next prompt in other sessions.`;
    } catch (error) {
      status = `Not saved: ${
        error instanceof Error ? error.message : String(error)
      }`;
      closeRequested = false;
    } finally {
      saving = false;
    }
    rebuildList();
    // Finish state cleanup before disposing the picker; never render a disposed component.
    if (closeRequested) options.close();
    else options.requestRender();
  }

  async function saveSelected(action: 'toggle' | 'clear'): Promise<void> {
    const row = selectedRow();
    if (!row || (action === 'clear' && scope !== 'project')) return;
    const mode = action === 'clear'
      ? SKILL_ACTIONS.reset
      : isOnDemand(row)
      ? SKILL_ACTIONS.on
      : SKILL_ACTIONS.off;
    await save([row], mode, row.name);
  }

  async function saveFiltered(): Promise<void> {
    const rows = filteredRows();
    const on = rows.filter((row) => !isOnDemand(row));
    const [targets, mode]: [SkillRow[], SkillAction] = on.length > 0
      ? [on, SKILL_ACTIONS.off]
      : [rows, SKILL_ACTIONS.on];
    await save(
      targets,
      mode,
      targets.length === 1 ? targets[0].name : `${targets.length} skills`,
    );
  }

  function totals(): string {
    const rows = options.rows();
    const on = rows.filter((row) => !isOnDemand(row));
    const sum = (list: SkillRow[]) =>
      list.reduce((total, row) => total + row.tokens, 0);
    return `${on.length} of ${rows.length} on · ~${sum(on)} tok · ~${
      sum(rows) - sum(on)
    } tok saved`;
  }

  return {
    get focused() {
      return search.focused;
    },
    set focused(value: boolean) {
      search.focused = value;
    },
    render(width: number): string[] {
      const row = selectedRow();
      const modeDetail = row
        ? `${row.onDemand ? 'off' : 'on'} here · ${row.source}`
        : undefined;
      const details = row
        ? [
          ...row.detail.split('\n'),
          ...wrapTextWithAnsi(row.description ?? '', Math.max(1, width)).slice(
            0,
            2,
          ),
        ]
        : [];
      return [
        theme.fg(
          'accent',
          theme.bold(
            `Skill discovery · ${
              scope === 'project' ? 'Repository' : 'Global (all repos)'
            }`,
          ),
        ),
        theme.fg('text', totals()),
        theme.fg('dim', options.project),
        ...search.render(Math.max(1, width)),
        '',
        ...list.render(Math.max(1, width)),
        '',
        ...(modeDetail
          ? [
            theme.fg(row?.onDemand ? 'warning' : 'success', modeDetail),
            ...details.map((line) => theme.fg('muted', line)),
          ]
          : []),
        theme.fg(
          'dim',
          'Type to search · ↑↓ move · Space/Enter toggle · Esc close',
        ),
        theme.fg(
          'dim',
          'Tab scope · Ctrl+A toggle all shown · Ctrl+R inherit global/default (repository scope)',
        ),
        theme.fg(status.startsWith('Not saved:') ? 'error' : 'muted', status),
      ].map((line) => theme.italic(truncateToWidth(line, Math.max(0, width))));
    },
    invalidate() {
      search.invalidate();
      list.invalidate();
    },
    async handleInput(data: string): Promise<void> {
      const cancel = options.matches?.(data, 'tui.select.cancel') ||
        matchesKey(data, 'escape');
      if (saving) {
        if (cancel) closeRequested = true;
        return;
      }
      if (cancel) {
        options.close();
        return;
      }
      if (matchesKey(data, 'tab')) {
        scope = scope === 'project' ? 'global' : 'project';
        rebuildList();
      } else if (matchesKey(data, 'ctrl+a')) {
        await saveFiltered();
        return;
      } else if (matchesKey(data, 'ctrl+r')) {
        await saveSelected('clear');
        return;
      } else if (
        matchesKey(data, 'space') || matchesKey(data, 'enter') ||
        options.matches?.(data, 'tui.select.confirm')
      ) {
        await saveSelected('toggle');
        return;
      } else if (
        matchesKey(data, 'up') || options.matches?.(data, 'tui.select.up')
      ) {
        moveSelection(-1);
      } else if (
        matchesKey(data, 'down') || options.matches?.(data, 'tui.select.down')
      ) {
        moveSelection(1);
      } else {
        const before = search.getValue();
        search.handleInput(data);
        if (search.getValue() !== before) rebuildList();
      }
      options.requestRender();
    },
  };
}
