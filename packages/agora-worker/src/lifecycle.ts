import { createHmac } from 'node:crypto';
import type { LifecycleEvent } from '@quarry-systems/agora-core';

export class LifecycleEmitter {
  constructor(private readonly opts: {
    callbackUrl?: string;
    hmacKey?: string;
    fetchImpl?: typeof fetch;
  }) {}

  async emit(event: LifecycleEvent): Promise<void> {
    if (!this.opts.callbackUrl || !this.opts.hmacKey) return;

    const fetchFn = this.opts.fetchImpl ?? fetch;
    const timestamp = new Date().toISOString();
    const payload = JSON.stringify(event);
    const signature = createHmac('sha256', this.opts.hmacKey)
      .update(`${event.dispatchId}.${timestamp}.${payload}`)
      .digest('hex');

    await fetchFn(this.opts.callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agora-Signature': `sha256=${signature}`,
        'X-Agora-Dispatch-Id': event.dispatchId,
        'X-Agora-Timestamp': timestamp,
      },
      body: payload,
    });
  }
}
