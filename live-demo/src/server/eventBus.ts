import type { Response } from 'express';
import type { LiveEvent, LiveSnapshot } from '../shared/types.js';

export class EventBus {
  #clients = new Set<Response>();
  #events: LiveEvent[] = [];
  #nextId = 1;

  attach(response: Response) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    response.write('\n');
    this.#clients.add(response);
    for (const event of this.#events.slice(-50)) {
      response.write(`event: event\ndata: ${JSON.stringify(event)}\n\n`);
    }
    response.on('close', () => this.#clients.delete(response));
  }

  emit(kind: LiveEvent['kind'], message: string, extra: Partial<LiveEvent> = {}) {
    const event: LiveEvent = { id: this.#nextId++, timestamp: Date.now(), kind, message, ...extra };
    this.#events.push(event);
    if (this.#events.length > 250) this.#events.shift();
    this.#broadcast('event', event);
    return event;
  }

  snapshot(snapshot: LiveSnapshot) {
    this.#broadcast('snapshot', snapshot);
  }

  recentEvents() {
    return this.#events.slice(-100);
  }

  #broadcast(eventName: string, payload: unknown) {
    const encoded = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.#clients) client.write(encoded);
  }
}
