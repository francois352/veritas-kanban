import {
  API_BASE,
  createApiClient as createSharedApiClient,
  type ApiClientOptions,
} from '@veritas-kanban/shared';
import { signKanbanRequest } from './kanban-signature.js';

export { API_BASE };

export function createApiClient(baseUrl = API_BASE, options: ApiClientOptions = {}) {
  return createSharedApiClient(baseUrl, {
    ...options,
    async prepareRequest(path, requestOptions) {
      const prepared = options.prepareRequest
        ? await options.prepareRequest(path, requestOptions)
        : requestOptions;
      return signKanbanRequest(path, prepared);
    },
  });
}

export const api = createApiClient(API_BASE);
