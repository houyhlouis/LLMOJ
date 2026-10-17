import { AsyncLocalStorage } from "async_hooks";

/** The HTTP request being handled, carried through its async calls (set by AuthMiddleware). */
export const requestContext = new AsyncLocalStorage<unknown>();
