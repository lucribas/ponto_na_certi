import { crx } from '@crxjs/vite-plugin';
import { defineConfig, loadEnv } from 'vite';

import manifest from './manifest.json' with { type: 'json' };

export default defineConfig(({ command, mode }) => {
  const environment = loadEnv(mode, process.cwd(), '');
  const googleOAuthClientId = environment.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const chromeExtensionPublicKey =
    environment.CHROME_EXTENSION_PUBLIC_KEY?.trim();
  const resolvedManifest = {
    ...manifest,
    ...(chromeExtensionPublicKey ? { key: chromeExtensionPublicKey } : {}),
    ...(googleOAuthClientId
      ? {
          oauth2: {
            client_id: googleOAuthClientId,
            scopes: [
              'https://www.googleapis.com/auth/calendar.events.readonly',
              'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
            ],
          },
        }
      : {}),
  };

  return {
    plugins: [crx({ manifest: resolvedManifest })],
    build: {
      assetsInlineLimit: 0,
      emptyOutDir: true,
      outDir: command === 'serve' ? 'dist-dev' : 'dist',
      rollupOptions: {
        input: ['src/offscreen/audio.html'],
      },
      sourcemap: false,
    },
  };
});
