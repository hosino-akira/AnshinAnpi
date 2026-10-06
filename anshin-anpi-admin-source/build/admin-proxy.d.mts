import type { IncomingMessage, ServerResponse } from 'node:http';
export function proxyAdmin(request: Request, backendUrl: string, fetchImpl?: typeof fetch): Promise<Response | null>;
export function createAdminMiddleware(options: { backendUrl: string; fetchImpl?: typeof fetch }): (request: IncomingMessage, response: ServerResponse, next: () => void) => Promise<void>;
