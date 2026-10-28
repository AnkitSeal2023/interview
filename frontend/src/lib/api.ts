export const api = {
  async get<T = unknown>(path: string): Promise<T> {
    const r = await fetch(`/api${path}`);
    if (!r.ok) throw await toErr(r);
    return r.json() as Promise<T>;
  },
  async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    const r = await fetch(`/api${path}`, {
      method: "POST",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw await toErr(r);
    return r.json() as Promise<T>;
  },
  async upload<T = unknown>(path: string, form: FormData): Promise<T> {
    const r = await fetch(`/api${path}`, { method: "POST", body: form });
    if (!r.ok) throw await toErr(r);
    return r.json() as Promise<T>;
  },
  async del<T = unknown>(path: string): Promise<T> {
    const r = await fetch(`/api${path}`, { method: "DELETE" });
    if (!r.ok) throw await toErr(r);
    return r.json() as Promise<T>;
  },
};

async function toErr(r: Response): Promise<Error> {
  let detail = `${r.status}`;
  try {
    const j = await r.json();
    detail = j.detail ?? JSON.stringify(j);
  } catch {
    /* non-JSON error */
  }
  return new Error(detail);
}
