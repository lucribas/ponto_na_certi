interface SoundMessage {
  readonly type: 'PLAY_PUNCH_ALERT_SOUND';
}

chrome.runtime.onMessage.addListener((candidate: unknown) => {
  if (!isSoundMessage(candidate)) return false;
  void playAlertSound().catch((error: unknown) => {
    console.warn('[PontoNaCerti][PunchAlertSound]', {
      status: 'failed',
      reason: error instanceof Error ? error.message : 'unknown-error',
    });
  });
  return false;
});

async function playAlertSound(): Promise<void> {
  const context = new AudioContext();
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.22, context.currentTime + 0.025);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.7);
  gain.connect(context.destination);

  const first = context.createOscillator();
  first.type = 'sine';
  first.frequency.value = 880;
  first.connect(gain);
  first.start(context.currentTime);
  first.stop(context.currentTime + 0.2);

  const second = context.createOscillator();
  second.type = 'sine';
  second.frequency.value = 660;
  second.connect(gain);
  second.start(context.currentTime + 0.28);
  second.stop(context.currentTime + 0.65);

  await new Promise((resolve) => globalThis.setTimeout(resolve, 800));
  await context.close();
}

function isSoundMessage(value: unknown): value is SoundMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>).type === 'PLAY_PUNCH_ALERT_SOUND'
  );
}
