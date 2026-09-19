import { CommonModule } from '@angular/common';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { Subscription, catchError, exhaustMap, interval, of, startWith } from 'rxjs';
import { environment } from '../../environments/environment';

interface MonitorMesaState {
  id: number;
  nombre?: string | null;
  image_url: string | null;
  current_image_index: number;
  blackout: boolean;
  locked: boolean;
  check_overlay?: 'success' | 'error' | 'no_camera' | 'none' | null;
}

interface MonitorItem {
  id: number;
  modulo_nombre?: string;
  fase?: string;
  images?: { url?: string; src?: string }[];
}

/**
 * Second screen of a mini-PC (/monitor): a read-only mirror of what the player
 * is projecting, meant for a monitor at operator height.
 *
 * It is deliberately separate from VisorComponent. The player owns the mesa:
 * pairing, heartbeat, photo checks and keyboard. This view never writes
 * anything (no POST, no token storage); it only reads the token the player
 * already keeps in the local capture service and polls the same read-only
 * device endpoints.
 */
@Component({
  selector: 'app-monitor',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './monitor.component.html',
  styleUrl: './monitor.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MonitorComponent implements OnInit, OnDestroy {
  private static readonly TOKEN_RETRY_MS = 5000;
  private static readonly STATE_POLL_MS = 2000;
  private static readonly ITEM_POLL_MS = 5000;

  private readonly http = inject(HttpClient);
  private readonly captureServiceUrl = 'http://127.0.0.1:5555';
  private readonly apiUrl = `${environment.apiUrl}/device/`;

  private token: string | null = null;
  private tokenSub: Subscription | null = null;
  private stateSub: Subscription | null = null;
  private itemSub: Subscription | null = null;

  readonly waiting = signal(true);
  readonly state = signal<MonitorMesaState | null>(null);
  readonly item = signal<MonitorItem | null>(null);

  readonly images = computed(() => this.item()?.images ?? []);
  readonly index = computed(() => this.state()?.current_image_index ?? 0);
  /** Negative indexes are the player's calibration / projector-setup slides. */
  readonly adjusting = computed(() => this.index() < 0);
  readonly imageUrl = computed<string | null>(() => {
    if (this.adjusting()) return null;
    const images = this.images();
    const index = this.index();
    if (index < images.length) {
      const image = images[index];
      return image?.url || image?.src || null;
    }
    return this.state()?.image_url ?? null;
  });
  readonly stepLabel = computed(() => {
    const total = this.images().length;
    return total && !this.adjusting() ? `${Math.min(this.index() + 1, total)} / ${total}` : '';
  });
  readonly check = computed(() => this.state()?.check_overlay ?? 'none');

  ngOnInit(): void {
    this.startTokenLookup();
  }

  ngOnDestroy(): void {
    this.tokenSub?.unsubscribe();
    this.stopPolling();
  }

  /** The player is the only one that pairs; here we just wait for its token. */
  private startTokenLookup(): void {
    this.stopPolling();
    this.token = null;
    this.waiting.set(true);
    this.tokenSub?.unsubscribe();
    this.tokenSub = interval(MonitorComponent.TOKEN_RETRY_MS).pipe(
      startWith(0),
      exhaustMap(() => this.http.get<{ device_token: string }>(`${this.captureServiceUrl}/device_token`)
        .pipe(catchError(() => of(null)))),
    ).subscribe(response => {
      const token = (response?.device_token || '').trim();
      if (!token) return;
      this.token = token;
      this.tokenSub?.unsubscribe();
      this.tokenSub = null;
      this.startPolling();
    });
  }

  private startPolling(): void {
    this.stateSub = interval(MonitorComponent.STATE_POLL_MS).pipe(
      startWith(0),
      exhaustMap(() => this.http.get<MonitorMesaState>(`${this.apiUrl}state/`, { headers: this.headers() })
        .pipe(catchError(error => of(this.onRequestError(error))))),
    ).subscribe(state => {
      if (!state) return;
      this.state.set(state);
      this.waiting.set(false);
    });

    this.itemSub = interval(MonitorComponent.ITEM_POLL_MS).pipe(
      startWith(0),
      exhaustMap(() => this.http.get<MonitorItem | null>(`${this.apiUrl}current_item/`, { headers: this.headers() })
        .pipe(catchError(error => of(this.onRequestError(error, true))))),
    ).subscribe(item => {
      if (item === undefined) return;
      this.item.set(item);
    });
  }

  private stopPolling(): void {
    this.stateSub?.unsubscribe();
    this.itemSub?.unsubscribe();
    this.stateSub = this.itemSub = null;
  }

  /**
   * 401 means the player re-paired and the token on disk changed: go back to
   * reading it. Any other failure (factory network) keeps the last picture.
   */
  private onRequestError(error: { status?: number }, keepItem = false): null | undefined {
    if (error?.status === 401) this.startTokenLookup();
    return keepItem ? undefined : null;
  }

  private headers(): HttpHeaders {
    return new HttpHeaders({ Authorization: `Bearer ${this.token}` });
  }
}
