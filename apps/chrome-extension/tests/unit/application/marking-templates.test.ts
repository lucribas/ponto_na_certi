import { describe, expect, it } from 'vitest';

import {
  applyMarkingTemplate,
  automaticTemplateApplication,
  createMarkingTemplate,
  describeTemplateRule,
  matchesTemplateRule,
  TemplateOverflowError,
} from '../../../src/application/marking-templates';
import type {
  MarkingTemplate,
  TemplateApplicationRule,
} from '../../../src/application/settings';
import { civilDate } from '../../../src/domain';

const balancedTemplate: MarkingTemplate = {
  id: 'balanced',
  name: 'Projeto e reuniões',
  sourceDurationMinutes: 480,
  createdAt: '2026-08-24T12:00:00.000Z',
  entries: [
    {
      id: 'balanced::1',
      tagId: 'project',
      percentage: 75,
      durationMinutes: 360,
    },
    {
      id: 'balanced::2',
      tagId: 'meetings',
      percentage: 25,
      durationMinutes: 120,
    },
  ],
};

describe('templates de marcações', () => {
  it('salva simultaneamente a proporção e a duração original de cada marcação', () => {
    const template = createMarkingTemplate(
      'saved',
      '  Sexta padrão  ',
      '08:00',
      [
        {
          id: 'one',
          mode: 'duration',
          value: '06:00',
          durationMinutes: 360,
          duration: '06:00',
          tagId: 'project',
          isRemainder: false,
        },
        {
          id: 'two',
          mode: 'duration',
          value: '02:00',
          durationMinutes: 120,
          duration: '02:00',
          ragCatalogId: 'meetings',
          ragItemId: 'planning',
          isRemainder: true,
        },
      ],
      '2026-08-24T12:00:00.000Z',
    );

    expect(template).toMatchObject({
      name: 'Sexta padrão',
      sourceDurationMinutes: 480,
      entries: [
        { percentage: 75, durationMinutes: 360, tagId: 'project' },
        {
          percentage: 25,
          durationMinutes: 120,
          ragCatalogId: 'meetings',
          ragItemId: 'planning',
        },
      ],
    });
  });

  it('escala por percentual para dias maiores preservando destinos e o total exato', () => {
    const allocations = applyMarkingTemplate(
      balancedTemplate,
      600,
      'percentage',
      'reject',
      'default',
    );

    expect(allocations).toMatchObject([
      { duration: '07:30', value: '75', tagId: 'project' },
      {
        duration: '02:30',
        value: '25',
        tagId: 'meetings',
        isRemainder: true,
      },
    ]);
    expect(
      allocations.reduce((total, item) => total + item.durationMinutes, 0),
    ).toBe(600);
  });

  it('mantém horas originais e cria saldo para um dia maior', () => {
    const allocations = applyMarkingTemplate(
      balancedTemplate,
      540,
      'duration',
      'reject',
      'default',
    );

    expect(allocations).toMatchObject([
      { duration: '06:00', tagId: 'project', isRemainder: false },
      { duration: '02:00', tagId: 'meetings', isRemainder: false },
      { duration: '01:00', tagId: 'default', isRemainder: true },
    ]);
  });

  it('expõe o estouro antes de ajustar proporcionalmente as horas ao dia menor', () => {
    expect(() =>
      applyMarkingTemplate(
        balancedTemplate,
        420,
        'duration',
        'reject',
        'default',
      ),
    ).toThrow(TemplateOverflowError);

    const adjusted = applyMarkingTemplate(
      balancedTemplate,
      420,
      'duration',
      'scale',
      'default',
    );
    expect(adjusted).toMatchObject([
      { duration: '05:15', tagId: 'project' },
      { duration: '01:45', tagId: 'meetings', isRemainder: true },
    ]);
  });
});

describe('regras semanais de aplicação', () => {
  const rule: TemplateApplicationRule = {
    id: 'weekly',
    name: 'Segundas e sextas',
    enabled: true,
    repeatEveryWeeks: 2,
    weekdays: [1, 5],
    startsOn: civilDate('2026-08-24'),
    ends: { kind: 'after', occurrences: 4 },
    templates: [{ templateId: 'balanced', percentage: 100 }],
  };

  it('segue intervalo, dias da semana e término após ocorrências', () => {
    expect(matchesTemplateRule(rule, civilDate('2026-08-24'))).toBe(true);
    expect(matchesTemplateRule(rule, civilDate('2026-08-28'))).toBe(true);
    expect(matchesTemplateRule(rule, civilDate('2026-08-31'))).toBe(false);
    expect(matchesTemplateRule(rule, civilDate('2026-09-07'))).toBe(true);
    expect(matchesTemplateRule(rule, civilDate('2026-09-11'))).toBe(true);
    expect(matchesTemplateRule(rule, civilDate('2026-09-21'))).toBe(false);
    expect(describeTemplateRule(rule)).toContain(
      'A cada 2 semanas, em seg., sex.',
    );
  });

  it('mistura mais de um template pela participação definida e fecha o total', () => {
    const focused: MarkingTemplate = {
      id: 'focused',
      name: 'Foco',
      sourceDurationMinutes: 480,
      createdAt: '2026-08-24T12:00:00.000Z',
      entries: [
        {
          id: 'focused::1',
          tagId: 'focus',
          percentage: 100,
          durationMinutes: 480,
        },
      ],
    };
    const mixedRule: TemplateApplicationRule = {
      ...rule,
      repeatEveryWeeks: 1,
      ends: { kind: 'never' },
      templates: [
        { templateId: 'balanced', percentage: 40 },
        { templateId: 'focused', percentage: 60 },
      ],
    };
    const application = automaticTemplateApplication(
      [mixedRule],
      [balancedTemplate, focused],
      civilDate('2026-08-24'),
      480,
      'default',
    );

    expect(application?.allocations).toMatchObject([
      { durationMinutes: 144, tagId: 'project' },
      { durationMinutes: 48, tagId: 'meetings' },
      { durationMinutes: 288, tagId: 'focus' },
    ]);
    expect(
      application?.allocations.reduce(
        (total, item) => total + item.durationMinutes,
        0,
      ),
    ).toBe(480);
  });
});
