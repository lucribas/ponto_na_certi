import { describe, expect, it } from 'vitest';

import {
  assertContentSender,
  assertCurrentOperation,
  assertExtensionSender,
  isIncomingMessage,
} from '../../../src/messaging/validation';

describe('message boundary validation', () => {
  it('accepts each small approved command shape', () => {
    expect(
      isIncomingMessage({ type: 'START_OPERATION', operationId: 'op-1' }),
    ).toBe(true);
    expect(
      isIncomingMessage({ type: 'CHECK_LOGIN_STATUS', operationId: 'op-1' }),
    ).toBe(true);
    expect(
      isIncomingMessage({ type: 'DISCOVER_OPEN_TABS', operationId: 'op-1' }),
    ).toBe(true);
    expect(
      isIncomingMessage({
        type: 'TEST_PUNCH_ALERT',
        operationId: 'op-1',
        checkAt: '2026-08-25T14:00:00.000Z',
      }),
    ).toBe(true);
    expect(
      isIncomingMessage({
        type: 'OPEN_LOGIN_PAGES',
        operationId: 'op-1',
        autoSubmit: true,
      }),
    ).toBe(true);
    expect(
      isIncomingMessage({
        type: 'APPLY_MARKING_TEMPLATE',
        operationId: 'op-1',
        itemId: '2026-08-20',
        basis: 'percentage',
        overflowStrategy: 'reject',
        template: {
          id: 'template-1',
          name: 'Padrão',
          sourceDurationMinutes: 480,
          entries: [],
          createdAt: '2026-08-24T00:00:00.000Z',
        },
      }),
    ).toBe(true);
    expect(
      isIncomingMessage({
        type: 'SET_ALLOCATION_RAG',
        operationId: 'op-1',
        itemId: '2026-08-20',
        allocationId: '2026-08-20::2',
        catalogId: 'reunioes-rag',
        ragItemId: 'reunioes-rag:029:lightning-talk',
      }),
    ).toBe(true);
    expect(
      isIncomingMessage({
        type: 'DELETE_CHANNEL_MARKING',
        operationId: 'op-1',
        itemId: '2026-08-20',
        markingId: '12345',
      }),
    ).toBe(true);
    expect(
      isIncomingMessage({
        type: 'EDIT_DIVERGENT_ITEM',
        operationId: 'op-1',
        itemId: '2026-08-20',
      }),
    ).toBe(true);
    expect(
      isIncomingMessage({
        type: 'APPLY_ITEM',
        operationId: 'op-1',
        itemId: '2026-08-20',
      }),
    ).toBe(true);
    expect(
      isIncomingMessage({
        type: 'STOP_CURRENT_ACTION',
        operationId: 'op-1',
        action: 'capture',
      }),
    ).toBe(true);
    expect(
      isIncomingMessage({
        type: 'REGISTER_ACTIVE_TAB',
        operationId: 'op-1',
        role: 'source',
      }),
    ).toBe(true);
    expect(
      isIncomingMessage({
        type: 'SHOW_PREVIEW',
        operationId: 'op-1',
        dryRun: true,
      }),
    ).toBe(true);
    expect(
      isIncomingMessage({
        type: 'UPDATE_ALLOCATION',
        operationId: 'op-1',
        itemId: '2026-08-20',
        allocationId: '2026-08-20::2',
        mode: 'duration',
        value: '03:00',
      }),
    ).toBe(true);
  });

  it('rejects unknown, malformed, or stale messages', () => {
    expect(isIncomingMessage(null)).toBe(false);
    expect(
      isIncomingMessage({ type: 'START_OPERATION', operationId: '' }),
    ).toBe(false);
    expect(
      isIncomingMessage({
        type: 'OPEN_LOGIN_PAGES',
        operationId: 'op-1',
        autoSubmit: 'yes',
      }),
    ).toBe(false);
    expect(
      isIncomingMessage({
        type: 'TEST_PUNCH_ALERT',
        operationId: 'op-1',
        checkAt: 'amanhã às duas',
      }),
    ).toBe(false);
    expect(
      isIncomingMessage({
        type: 'APPLY_MARKING_TEMPLATE',
        operationId: 'op-1',
        itemId: '2026-08-20',
        basis: 'hours',
        overflowStrategy: 'force',
        template: { id: 'template-1', name: 'Padrão', entries: [] },
      }),
    ).toBe(false);
    expect(
      isIncomingMessage({
        type: 'DELETE_CHANNEL_MARKING',
        operationId: 'op-1',
        itemId: '2026-08-20',
        markingId: '',
      }),
    ).toBe(false);
    expect(
      isIncomingMessage({
        type: 'APPLY_ITEM',
        operationId: 'op-1',
        itemId: '',
      }),
    ).toBe(false);
    expect(
      isIncomingMessage({
        type: 'STOP_CURRENT_ACTION',
        operationId: 'op-1',
        action: 'everything',
      }),
    ).toBe(false);
    expect(
      isIncomingMessage({
        type: 'UPDATE_ALLOCATION',
        operationId: 'op-1',
        itemId: '2026-08-20',
        allocationId: '2026-08-20::2',
        mode: 'hours',
        value: '03:00',
      }),
    ).toBe(false);
    expect(
      isIncomingMessage({
        type: 'REGISTER_ACTIVE_TAB',
        operationId: 'op-1',
        role: 'both',
      }),
    ).toBe(false);
    expect(
      isIncomingMessage({
        type: 'SHOW_PREVIEW',
        operationId: 'op-1',
        dryRun: 'yes',
      }),
    ).toBe(false);
    expect(() =>
      assertCurrentOperation(
        { type: 'CAPTURE_SOURCE', operationId: 'old-operation' },
        'current-operation',
      ),
    ).toThrow(/antiga/);
  });

  it('requires the expected tab, frame, and exact origin at content boundaries', () => {
    const expected = {
      tabId: 17,
      frameId: 0,
      origin: 'https://synthetic-source.invalid',
    };
    const validSender: chrome.runtime.MessageSender = {
      frameId: 0,
      tab: { id: 17 } as chrome.tabs.Tab,
      url: 'https://synthetic-source.invalid/mirror',
    };

    expect(() => assertContentSender(validSender, expected)).not.toThrow();
    expect(() =>
      assertContentSender(
        { ...validSender, frameId: 2 },
        { ...expected, frameId: 2 },
      ),
    ).not.toThrow();
    expect(() =>
      assertContentSender({ ...validSender, frameId: 2 }, expected),
    ).toThrow(/Remetente/);
    expect(() =>
      assertContentSender(
        { ...validSender, url: 'https://other.invalid/mirror' },
        expected,
      ),
    ).toThrow(/Origem/);
    expect(() =>
      assertContentSender(
        { ...validSender, tab: { id: 18 } as chrome.tabs.Tab },
        expected,
      ),
    ).toThrow(/Remetente/);
  });

  it('accepts only this extension own pages for UI commands', () => {
    const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
    const sender: chrome.runtime.MessageSender = {
      id: extensionId,
      url: `chrome-extension://${extensionId}/src/ui/side-panel.html`,
    };

    expect(() => assertExtensionSender(sender, extensionId)).not.toThrow();
    expect(() =>
      assertExtensionSender({ id: extensionId }, extensionId),
    ).not.toThrow();
    expect(() =>
      assertExtensionSender(
        { ...sender, id: 'different-extension' },
        extensionId,
      ),
    ).toThrow(/Remetente/);
    expect(() =>
      assertExtensionSender(
        { ...sender, url: 'https://synthetic.invalid/' },
        extensionId,
      ),
    ).toThrow(/Origem/);
    expect(() =>
      assertExtensionSender(
        { ...sender, tab: { id: 1 } as chrome.tabs.Tab },
        extensionId,
      ),
    ).not.toThrow();
  });
});
