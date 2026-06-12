import { status, Metadata } from '@grpc/grpc-js';
import { ApiKeyStore } from './store';

function getToken(metadata: Metadata): string | null {
  const values = metadata.get('x-token');
  return values.length > 0 ? (values[0] as string) : null;
}

/** Wraps a unary handler to require valid x-token metadata */
export function requireAuth(store: ApiKeyStore, handler: any): any {
  return (call: any, callback: (...args: any[]) => void) => {
    const token = getToken(call.metadata);
    if (!token || !store.validate(token)) {
      callback({ code: status.UNAUTHENTICATED, message: 'Missing or invalid x-token' });
      return;
    }
    handler(call, callback);
  };
}

/** Wraps a bidirectional streaming handler to require valid x-token metadata */
export function requireAuthStream(store: ApiKeyStore, handler: any): any {
  return (call: any) => {
    const token = getToken(call.metadata);
    if (!token || !store.validate(token)) {
      call.emit('error', { code: status.UNAUTHENTICATED, message: 'Missing or invalid x-token', details: 'Unauthorized' });
      call.destroy();
      return;
    }
    handler(call);
  };
}
