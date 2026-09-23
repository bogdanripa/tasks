export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
export const notFound = (what: string) => new HttpError(404, `${what} not found`);
export const forbidden = (why = 'Forbidden') => new HttpError(403, why);
export const badRequest = (why: string) => new HttpError(400, why);

/** fetch() rejects with a bare "fetch failed"; the useful part (ECONNREFUSED, DNS, TLS…) is in .cause. */
export function fetchError(e: unknown) {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  const cause = err.cause?.code ?? err.cause?.message;
  return cause ? `${err.message}: ${cause}` : err.message;
}
