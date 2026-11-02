export async function fetchWithRetry(url: string, attempts = 3): Promise<Response> {
  // Retry transient server and throttling responses, but surface permanent client errors.
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await fetch(url);
    if (response.ok || response.status < 500 && response.status !== 429) return response;
    const delay = Number(response.headers.get('Retry-After') ?? 2 ** attempt);
    await new Promise(resolve => setTimeout(resolve, delay * 1000));
  }
  throw new Error('Request exhausted its retries');
}

export function appendQueryParameters(url: string, values: Record<string, string | undefined>): string {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(values)) if (value !== undefined) parsed.searchParams.set(key, value);
  return parsed.toString();
}

export function authorizationHeaders(token: string): Record<string, string> {
  return {'Authorization': `Bearer ${token}`, 'Accept': 'application/json'};
}
