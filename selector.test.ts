import { describe, expect, it, vi } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import { createSkillSelector } from './selector.ts';

function harness(
  change = vi.fn().mockResolvedValue(undefined),
  matches?: (
    data: string,
    action:
      | 'tui.select.up'
      | 'tui.select.down'
      | 'tui.select.confirm'
      | 'tui.select.cancel',
  ) => boolean,
) {
  const row = {
    name: 'codebase-design',
    onDemand: false,
    globalOnDemand: false,
    tokens: 140,
    detail: '~140 tok · 2.9%',
    source: 'inherited',
    description: 'Test-driven development',
  };
  const rows = [row, { ...row, name: 'example-test' }];
  const close = vi.fn();
  const selector = createSkillSelector({
    project: 'repo:github.com/example/home-assistant',
    rows: () => rows,
    change: async (...args) => {
      await change(...args);
      const selected = rows.find((row) => row.name === args[0]);
      if (!selected) throw new Error('Unknown test skill');
      selected.onDemand = args[2] === 'on-demand';
      if (args[1] === 'global') selected.globalOnDemand = selected.onDemand;
    },
    theme: {
      fg: (_color, text) => text,
      bold: (text) => text,
      italic: (text) => text,
    },
    requestRender: vi.fn(),
    close,
    matches,
  });
  return { selector, change, close };
}

describe('skill toggle keyboard picker', () => {
  it('saves on Space without closing and closes on Escape', async () => {
    const { selector, change, close } = harness();

    await selector.handleInput(' ');

    expect(change).toHaveBeenCalledWith('codebase-design', 'project', 'on-demand');
    expect(close).not.toHaveBeenCalled();
    expect(selector.render(100).join('\n')).toContain('off · Unknown');
    await selector.handleInput('\u001b');
    expect(close).toHaveBeenCalledOnce();
  });

  it('switches scope with Tab and clears repository overrides with Ctrl+R', async () => {
    const { selector, change } = harness();

    await selector.handleInput('\t');
    await selector.handleInput(' ');
    await selector.handleInput('\t');
    await selector.handleInput('\u0012');

    expect(change.mock.calls).toEqual([
      ['codebase-design', 'global', 'on-demand'],
      ['codebase-design', 'project', 'clear'],
    ]);
  });

  it('toggles and clears the filtered skill without changing another row', async () => {
    const { selector, change } = harness();

    await selector.handleInput('test');
    await selector.handleInput(' ');
    await selector.handleInput('\u0012');

    expect(change.mock.calls).toEqual([
      ['example-test', 'project', 'on-demand'],
      ['example-test', 'project', 'clear'],
    ]);
  });

  it('keeps the selected row when switching scope and saving', async () => {
    const { selector, change } = harness();

    await selector.handleInput('\u001b[B');
    await selector.handleInput('\t');
    await selector.handleInput(' ');
    await selector.handleInput('\t');
    await selector.handleInput('\u0012');

    expect(change.mock.calls).toEqual([
      ['example-test', 'global', 'on-demand'],
      ['example-test', 'project', 'clear'],
    ]);
  });

  it('sorts on skills before off skills and alphabetizes each group', () => {
    const rows = [
      {
        name: 'z-off',
        onDemand: true,
        globalOnDemand: true,
        source: 'repository override',
        tokens: 0,
      detail: '',
      },
      {
        name: 'z-on',
        onDemand: false,
        globalOnDemand: false,
        source: 'default',
        tokens: 0,
      detail: '',
      },
      {
        name: 'a-off',
        onDemand: true,
        globalOnDemand: true,
        source: 'repository override',
        tokens: 0,
      detail: '',
      },
      {
        name: 'a-on',
        onDemand: false,
        globalOnDemand: false,
        source: 'default',
        tokens: 0,
      detail: '',
      },
    ];
    const selector = createSkillSelector({
      project: 'repo:github.com/example/project',
      rows: () => rows,
      change: vi.fn().mockResolvedValue(undefined),
      theme: {
        fg: (_color, text) => text,
        bold: (text) => text,
        italic: (text) => text,
      },
      requestRender: vi.fn(),
      close: vi.fn(),
    });

    const rendered = selector.render(100).join('\n');

    expect(rendered.indexOf('a-on')).toBeLessThan(rendered.indexOf('z-on'));
    expect(rendered.indexOf('z-on')).toBeLessThan(rendered.indexOf('a-off'));
    expect(rendered.indexOf('a-off')).toBeLessThan(rendered.indexOf('z-off'));
  });

  it('colors on and off modes differently', () => {
    const row = {
      name: 'enabled-skill',
      onDemand: false,
      globalOnDemand: false,
      source: 'default',
      tokens: 0,
      detail: '',
    };
    const selector = createSkillSelector({
      project: 'repo:github.com/example/project',
      rows: () => [row, { ...row, name: 'on-demand-skill', onDemand: true }],
      change: vi.fn().mockResolvedValue(undefined),
      theme: {
        fg: (color, text) => `<${color}>${text}</${color}>`,
        bold: (text) => text,
        italic: (text) => text,
      },
      requestRender: vi.fn(),
      close: vi.fn(),
    });

    const rendered = selector.render(100).join('\n');

    expect(rendered).toMatch(/<success>[^<]*on · Unknown<\/success>/);
    expect(rendered).toMatch(/<warning>[^<]*off · Unknown<\/warning>/);
    expect(rendered).toContain('on here · default');
    expect(rendered).toContain('off = on-demand, not disabled');
    expect(rendered).not.toMatch(/\bO(N|FF)\b|auto-discovered/);
  });

  it('keeps the same skill selected when toggling moves it between groups', async () => {
    const { selector, change } = harness();

    await selector.handleInput(' ');
    await selector.handleInput(' ');

    expect(change.mock.calls).toEqual([
      ['codebase-design', 'project', 'on-demand'],
      ['codebase-design', 'project', 'auto-discovered'],
    ]);
  });

  it('uses injected selection keybindings instead of assuming arrow keys', async () => {
    const { selector, change } = harness(
      undefined,
      (data, action) => data === 'custom-down' && action === 'tui.select.down',
    );

    await selector.handleInput('custom-down');
    await selector.handleInput(' ');

    expect(change).toHaveBeenCalledWith('example-test', 'project', 'on-demand');
  });

  it('does not save when search has no matches', async () => {
    const { selector, change } = harness();

    await selector.handleInput('nonexistent');
    await selector.handleInput(' ');
    await selector.handleInput('\u0012');

    expect(change).not.toHaveBeenCalled();
    expect(selector.render(100).join('\n')).toContain('No matching skills');
  });

  it('keeps failed changes visible as errors without claiming they were saved', async () => {
    const { selector, close } = harness(
      vi.fn().mockRejectedValue(new Error('Read-only config')),
    );

    await selector.handleInput(' ');

    expect(selector.render(100).join('\n')).toContain(
      'Not saved: Read-only config',
    );
    expect(selector.render(100).join('\n')).toContain('on · Unknown');
    expect(close).not.toHaveBeenCalled();
  });

  it('handles a save callback that throws before returning a promise', async () => {
    const selector = createSkillSelector({
      project: 'repo:github.com/example/project',
      rows: () => [{
        name: 'codebase-design',
        onDemand: false,
        globalOnDemand: false,
        source: 'default',
        tokens: 0,
      detail: '',
      }],
      change: () => {
        throw new Error('Save failed synchronously');
      },
      theme: {
        fg: (_color, text) => text,
        bold: (text) => text,
        italic: (text) => text,
      },
      requestRender: vi.fn(),
      close: vi.fn(),
    });

    await expect(selector.handleInput(' ')).resolves.toBeUndefined();

    expect(selector.render(100).join('\n')).toContain(
      'Not saved: Save failed synchronously',
    );
  });

  it('waits for an in-flight save before closing', async () => {
    let finish!: () => void;
    const { selector, close } = harness(
      vi.fn(() =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
      ),
    );
    const saving = selector.handleInput(' ');

    await selector.handleInput('\u001b');
    expect(close).not.toHaveBeenCalled();
    finish();
    await saving;

    expect(close).toHaveBeenCalledOnce();
  });

  it('uses the terminal italic face without replacing the theme colors', () => {
    const theme = {
      fg: (_color: string, text: string) => `\u001b[36m${text}\u001b[39m`,
      bold: (text: string) => text,
      italic: (text: string) => `\u001b[3m${text}\u001b[23m`,
    };
    const selector = createSkillSelector({
      project: 'repo:github.com/example/project',
      rows: () => [{
        name: 'codebase-design',
        onDemand: false,
        globalOnDemand: false,
        source: 'default',
        tokens: 0,
      detail: '',
      }],
      change: vi.fn().mockResolvedValue(undefined),
      theme,
      requestRender: vi.fn(),
      close: vi.fn(),
    });

    const lines = selector.render(80);

    expect(
      lines.every((line) =>
        line.startsWith('\u001b[3m') && line.endsWith('\u001b[23m')
      ),
    ).toBe(true);
    expect(lines[0]).toContain('\u001b[36m');
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  it('shows skills on, their tokens, and tokens saved for the current scope', async () => {
    const rows = [
      { name: 'a-on', onDemand: false, globalOnDemand: true, tokens: 100 },
      { name: 'b-off', onDemand: true, globalOnDemand: false, tokens: 40 },
      { name: 'c-on', onDemand: false, globalOnDemand: false, tokens: 25 },
    ].map((row) => ({ ...row, source: 'default', detail: '' }));
    const selector = createSkillSelector({
      project: 'repo:github.com/example/project',
      rows: () => rows,
      change: vi.fn().mockResolvedValue(undefined),
      theme: {
        fg: (_color, text) => text,
        bold: (text) => text,
        italic: (text) => text,
      },
      requestRender: vi.fn(),
      close: vi.fn(),
    });

    expect(selector.render(100)[1]).toBe(
      '2 of 3 on · ~125 tok · ~40 tok saved',
    );
    await selector.handleInput('\t');
    expect(selector.render(100)[1]).toBe(
      '2 of 3 on · ~65 tok · ~100 tok saved',
    );
  });

  it('turns off all filtered skills with Ctrl+A, then on again, per scope', async () => {
    const { selector, change } = harness();

    await selector.handleInput('test');
    await selector.handleInput('\u0001');
    expect(selector.render(100)[1]).toBe('1 of 2 on · ~140 tok · ~140 tok saved');
    await selector.handleInput('\u0001');
    await selector.handleInput('\t');
    await selector.handleInput('\u0001');

    expect(change.mock.calls).toEqual([
      ['example-test', 'project', 'on-demand'],
      ['example-test', 'project', 'auto-discovered'],
      ['example-test', 'global', 'on-demand'],
    ]);
  });

  it('turns on all filtered skills with Ctrl+A only when all are off', async () => {
    const { selector, change } = harness();

    await selector.handleInput(' ');
    change.mockClear();
    await selector.handleInput('\u0001');
    expect(change.mock.calls).toEqual([
      ['example-test', 'project', 'on-demand'],
    ]);
    await selector.handleInput('\u0001');

    expect(change.mock.calls.slice(1)).toEqual([
      ['codebase-design', 'project', 'auto-discovered'],
      ['example-test', 'project', 'auto-discovered'],
    ]);
    expect(selector.render(100).join('\n')).toContain('Saved 2 skills.');
  });

  it('lists the bulk toggle key in the footer help', () => {
    const { selector } = harness();

    expect(selector.render(120).join('\n')).toContain('Ctrl+A toggle all shown');
  });

  it('preserves token details and fits narrow terminals', () => {
    const { selector } = harness();

    expect(selector.render(100).join('\n')).toContain(
      '~140 tok · 2.9%',
    );
    for (const width of [1, 20, 40, 100]) {
      expect(
        selector.render(width).every((line) => visibleWidth(line) <= width),
      ).toBe(true);
    }
  });
});
