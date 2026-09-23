export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
export const notFound = (what: string) => new HttpError(404, `${what} not found`);
export const forbidden = (why = 'Forbidden') => new HttpError(403, why);
export const badRequest = (why: string) => new HttpError(400, why);
