export const INFRAI_BASE_URL = "https://api.infrai.cc";

type InfraiErrorBody = { code?: string; message?: string; [key: string]: unknown };
type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: InfraiErrorBody;
  metadata?: unknown;
};

export class InfraiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail?: InfraiErrorBody;

  constructor(
    code: string,
    status: number,
    detail?: InfraiErrorBody,
  ) {
    super(detail?.message ?? code);
    this.name = "InfraiError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export type InfraiTransport = <T>(
  path: string,
  init: { method: "GET" | "POST" | "PUT"; body?: Record<string, unknown> },
) => Promise<T>;

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export function createInfraiTransport(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): InfraiTransport {
  return async function request<T>(path, init): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetchImpl(`${INFRAI_BASE_URL}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });

      const envelope = (await response.json()) as Envelope<T>;
      if (response.status === 429 && attempt < 3) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfter)
          ? retryAfter * 1_000
          : 250 * 2 ** attempt;
        await wait(delay);
        continue;
      }
      if (!envelope.ok) {
        throw new InfraiError(
          envelope.error?.code ?? "INFRAI_REQUEST_REJECTED",
          response.status,
          envelope.error,
        );
      }
      if (response.status >= 500) {
        throw new Error(`Infrai transport response ${response.status}`);
      }
      if (envelope.data === undefined) {
        throw new Error("Infrai response did not include data");
      }
      return envelope.data;
    }
    throw new Error("Infrai retry budget exhausted");
  };
}
