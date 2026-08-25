import { CHANNEL_SELECTORS } from './selectors';

export type ChannelPageState = 'login' | 'extract' | 'entry-form' | 'unknown';

export function detectChannelPage(document: Document): ChannelPageState {
  const loginForm = document.querySelector(CHANNEL_SELECTORS.loginForm);
  if (loginForm?.querySelector(CHANNEL_SELECTORS.password)) return 'login';
  if (document.querySelector(CHANNEL_SELECTORS.entryForm)) return 'entry-form';
  if (
    document.querySelector(CHANNEL_SELECTORS.pageSize) ||
    document.querySelector(CHANNEL_SELECTORS.includeEntry) ||
    document.querySelector(CHANNEL_SELECTORS.extractRows)
  ) {
    return 'extract';
  }
  return 'unknown';
}
