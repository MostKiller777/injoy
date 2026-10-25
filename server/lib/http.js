const UA = 'injoy/1.0 (local node)';

export class HttpError extends Error {
  constructor(status, url, detail = '') {
    super(`HTTP ${status} for ${url}${detail ? ` — ${detail}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * JSON GET with hard timeout and bounded retries.
 * Retries 429/5xx/network; a 4xx is a caller error and returns immediately.
 */
export async function getJson(input, { timeout = 9000, headers = {}, retries = 1 } = {}) {
  const url = String(input);
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'user-agent': UA,
          accept: 'application/json',
          ...headers,
        },
      });

      if (res.ok) {
        return await res.json();
      }

      const detail = await res.text().catch(() => '');
      const err = new HttpError(res.status, url, detail.slice(0, 180));
      if (res.status !== 429 && res.status < 500) throw err;
      lastError = err;
    } catch (err) {
      if (err instanceof HttpError && err.status !== 429 && err.status < 500) throw err;
      lastError = err;
    } finally {
      clearTimeout(timer);
    }

    if (attempt < retries) await sleep(250 * (attempt + 1));
  }

  throw lastError ?? new Error(`request failed: ${url}`);
}

/** Fire-and-forget HEAD probe used by the source picker. Never throws. */
export async function probe(url, timeout = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': UA },
    });
    return { url, ok: res.ok, status: res.status };
  } catch (err) {
    return { url, ok: false, status: 0, error: err.name };
  } finally {
    clearTimeout(timer);
  }
}
