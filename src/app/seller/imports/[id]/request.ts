type ApiFailure = { code?: string; message?: string; details?: { field?: string } };

export class RequestFailed extends Error {
  constructor(readonly failure: ApiFailure) {
    super(failure.message ?? "Something went wrong. Try again.");
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { cache: "no-store", ...init });
  } catch {
    throw new RequestFailed({
      message: "The server did not answer. Check your connection and try again.",
    });
  }
  const body = (await response.json().catch(() => null)) as (T & { error?: ApiFailure }) | null;
  if (!response.ok) {
    throw new RequestFailed(body?.error ?? {});
  }
  return body as T;
}
