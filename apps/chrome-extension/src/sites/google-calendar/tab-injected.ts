export type GoogleCalendarExportResult =
  | {
      readonly ok: true;
      readonly archiveBase64: string;
      readonly byteLength: number;
    }
  | {
      readonly ok: false;
      readonly code:
        | 'invalid-calendar-origin'
        | 'login-required'
        | 'export-forbidden'
        | 'export-too-large'
        | 'invalid-export'
        | 'network-error';
    };

/**
 * Executada em MAIN na aba do Calendar. Mantém cookies/tokens fora da extensão:
 * somente o ZIP retornado pelo GET autenticado atravessa a fronteira da página.
 */
export async function fetchGoogleCalendarExport(): Promise<GoogleCalendarExportResult> {
  const maxExportBytes = 32 * 1024 * 1024;
  if (location.origin !== 'https://calendar.google.com')
    return { ok: false, code: 'invalid-calendar-origin' };

  const authUser = /^\/calendar\/u\/(\d+)(?:\/|$)/.exec(location.pathname)?.[1];
  const endpoint = new URL('/calendar/exporticalzip', location.origin);
  if (authUser) endpoint.searchParams.set('authuser', authUser);

  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      credentials: 'include',
      redirect: 'follow',
      headers: { Accept: 'application/zip, application/octet-stream' },
    });
    if (response.status === 401) return { ok: false, code: 'login-required' };
    if (response.status === 403) return { ok: false, code: 'export-forbidden' };
    if (!response.ok) return { ok: false, code: 'network-error' };

    const declaredSize = Number(response.headers.get('content-length') ?? '0');
    if (declaredSize > maxExportBytes)
      return { ok: false, code: 'export-too-large' };
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxExportBytes)
      return { ok: false, code: 'export-too-large' };
    // Todo ZIP começa com PK; HTML de login também pode responder 200.
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b)
      return {
        ok: false,
        code: response.url.includes('accounts.google.com')
          ? 'login-required'
          : 'invalid-export',
      };

    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return {
      ok: true,
      archiveBase64: btoa(binary),
      byteLength: bytes.byteLength,
    };
  } catch {
    return { ok: false, code: 'network-error' };
  }
}
