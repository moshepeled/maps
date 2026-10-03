/** A scriptable WebSocket double for the realtime tests (test-only). */
import { SERVER_MESSAGE_EXAMPLES } from '@snapland/shared/testing';

import type { SocketLike } from '../realtime/RealtimeClient';

export interface SentMessage {
  type: string;
  ref?: string;
  data: Record<string, unknown>;
}

export class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: SentMessage[] = [];
  closedWith: number | null = null;
  /** Answers every ping with a pong when true. */
  answerPings = true;

  send(data: string): void {
    const message = JSON.parse(data) as SentMessage;
    this.sent.push(message);
    if (message.type === 'ping' && this.answerPings) {
      this.receive({ type: 'pong', data: { t: message.data['t'], serverTime: 1 } });
    }
  }

  close(code = 1000, reason = ''): void {
    if (this.closedWith !== null) return;
    this.closedWith = code;
    this.onclose?.({ code, reason });
  }

  open(): void {
    this.onopen?.();
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  receiveRaw(data: string): void {
    this.onmessage?.({ data });
  }

  welcome(): void {
    this.receive(welcomeMessage());
  }

  /** The server drops the connection. */
  drop(code = 1006): void {
    if (this.closedWith !== null) return;
    this.closedWith = code;
    this.onclose?.({ code, reason: '' });
  }

  sentOfType(type: string): SentMessage[] {
    return this.sent.filter((message) => message.type === type);
  }
}

export function welcomeMessage(): unknown {
  const welcome = SERVER_MESSAGE_EXAMPLES.find((message) => message.type === 'welcome');
  if (welcome === undefined) throw new Error('no welcome example');
  return welcome;
}
