import type {
  InjectedChannelFillInput,
  InjectedChannelFillResult,
  InjectedChannelCatalogResult,
  InjectedChannelDeleteInput,
  InjectedChannelDeleteResult,
  InjectedChannelReadInput,
  InjectedChannelReadResult,
} from './injected';
import {
  runInjectedChannelApiRead,
  runInjectedChannelApiWrite,
  runInjectedChannelCatalog,
  runInjectedChannelApiDelete,
} from './api-injected';

export async function executeChannelCatalog(
  tabId: number,
): Promise<InjectedChannelCatalogResult> {
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: runInjectedChannelCatalog,
    args: [{ timeoutMs: 30_000 }],
  });
  const result = execution?.result ?? {
    ok: false as const,
    code: 'missing-execution-result',
  };
  console.info('[PontoNaCerti][ChannelCatalogRunner]', {
    status: result.ok ? 'ok' : 'failed',
    tabId,
    projectCount: result.ok ? result.projects.length : undefined,
    code: result.ok ? undefined : result.code,
  });
  return result;
}

export async function executeChannelRead(
  tabId: number,
  input: InjectedChannelReadInput,
): Promise<InjectedChannelReadResult> {
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: runInjectedChannelApiRead,
    args: [{ ...input, timeoutMs: input.timeoutMs ?? 30_000 }],
  });
  const result = execution?.result ?? {
    ok: false as const,
    code: 'missing-execution-result',
  };
  console.info('[PontoNaCerti][ChannelApiReadRunner]', {
    status: result.ok ? 'ok' : 'failed',
    tabId,
    hasExecution: execution !== undefined,
    code: result.ok ? undefined : result.code,
    rowCount: result.ok ? result.rows.length : undefined,
    invalidRowCount: result.ok ? result.errors.length : undefined,
  });
  return result;
}

export async function executeChannelDelete(
  tabId: number,
  input: InjectedChannelDeleteInput,
): Promise<InjectedChannelDeleteResult> {
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: runInjectedChannelApiDelete,
    args: [{ ...input, timeoutMs: input.timeoutMs ?? 30_000 }],
  });
  const result = execution?.result ?? {
    ok: false as const,
    code: 'missing-execution-result',
  };
  console.info('[PontoNaCerti][ChannelApiDeleteRunner]', {
    status: result.ok ? 'ok' : 'failed',
    code: result.ok ? undefined : result.code,
    tabId,
    hasExecution: execution !== undefined,
  });
  return result;
}

export async function executeChannelFill(
  tabId: number,
  input: InjectedChannelFillInput,
): Promise<InjectedChannelFillResult> {
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: runInjectedChannelApiWrite,
    args: [{ ...input, timeoutMs: input.timeoutMs ?? 30_000, commit: true }],
  });
  const result = execution?.result ?? {
    date: input.date,
    requestedMinutes: input.durationMinutes,
    status: 'failed',
    code: 'missing-execution-result',
  };
  console.info('[PontoNaCerti][ChannelApiWriteRunner]', {
    status: result.status,
    code: result.code,
    tabId,
    hasExecution: execution !== undefined,
  });
  return result;
}
