import { Injectable, NgZone } from '@angular/core';
import { Subject } from 'rxjs';

export interface SSEEvent {
  type: string;
  lead?: any;
  bookmark?: any;
  id?: string;
  [key: string]: any;
}

@Injectable({ providedIn: 'root' })
export class RealtimeService {
  private eventSource: EventSource | null = null;
  private reconnectTimer: any;
  
  // Observable stream for the UI components to subscribe to
  public events$ = new Subject<SSEEvent>();

  constructor(private zone: NgZone) {}

  connect(companyCode: string, phone: string) {
    this.disconnect();

    const url = `http://localhost:4000/api/events?companyCode=${encodeURIComponent(companyCode)}&phone=${encodeURIComponent(phone)}`;
    this.eventSource = new EventSource(url);

    this.eventSource.onmessage = (event) => {
      this.zone.run(() => {
        try {
          const data = JSON.parse(event.data);
          this.events$.next(data);
        } catch (e) {
          console.error('[SSE parse error]', e);
        }
      });
    };

    this.eventSource.onerror = (error) => {
      console.warn('[SSE connection error] Reconnecting in 3s...', error);
      this.disconnect();
      this.reconnectTimer = setTimeout(() => this.connect(companyCode, phone), 3000);
    };
  }

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }
}
