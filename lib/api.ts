// Thin client-side fetch helpers shared by every useQuery/useMutation fn so error
// handling isn't re-hand-rolled per call site. Throw on non-2xx so React Query
// treats it as an error; the JSON `error` field is surfaced when present.

async function unwrap<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      (data && typeof data.error === "string" && data.error) ||
      `Request failed (${res.status})`;
    throw new Error(message);
  }
  return data as T;
}

export function getJson<T>(url: string): Promise<T> {
  return fetch(url).then((res) => unwrap<T>(res));
}

export function postJson<T>(url: string, body: unknown): Promise<T> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((res) => unwrap<T>(res));
}

export function postForm<T>(url: string, form: FormData): Promise<T> {
  return fetch(url, { method: "POST", body: form }).then((res) => unwrap<T>(res));
}
