import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';

const schema = JSON.parse(
  readFileSync(join(import.meta.dirname, 'skill-toggle.schema.json'), 'utf8'),
);
const validate = new Ajv({ allErrors: true }).compile(schema);

describe('skill-toggle.schema.json', () => {
  it.each([
    { onDemandSkills: [] },
    {
      $schema: './skill-toggle.schema.json',
      version: 1,
      onDemandSkills: ['tdd'],
      projects: { 'repo:github.com/acme/web': { onDemand: ['a'], autoDiscovered: [] } },
      rules: [{ repo: 'github.com/acme/*', onDemand: ['deploy-*'], autoDiscovered: ['tdd'] }],
    },
  ])('accepts a valid settings file: %j', (settings) => {
    expect(validate(settings)).toBe(true);
  });

  it.each([
    {},
    { onDemandSkills: [], version: 2 },
    { onDemandSkills: ['deploy-*'] },
    { onDemandSkills: [], projects: { key: { onDemand: ['a*'] } } },
    { onDemandSkills: [], rules: [{ onDemand: ['tdd'] }] },
    { onDemandSkills: [], rules: [{ repo: '' }] },
    { onDemandSkills: [], rules: [{ repo: '*', onDemnd: ['tdd'] }] },
  ])('rejects what the settings store rejects: %j', (settings) => {
    expect(validate(settings)).toBe(false);
  });
});
