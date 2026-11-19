/** Browser-side JSON fetch. Same-origin requests carry the Origin header the server checks. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? "GET",
      headers: init.body === undefined ? undefined : { "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, "NETWORK", "No connection. Check your network and try again.");
  }
  const data = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } } & Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(res.status, data.error?.code ?? "ERROR", data.error?.message ?? "Something went wrong.", data.error ?? {});
  }
  return data as T;
}
