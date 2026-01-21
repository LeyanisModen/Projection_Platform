import { Component, OnInit, OnDestroy, Inject, PLATFORM_ID, ChangeDetectorRef, NgZone } from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { interval, Subscription, switchMap, of, catchError, exhaustMap, startWith } from 'rxjs';
import { Mapper } from '../mapper/mapper';

interface MesaState {
  id: number;
  nombre: string;
  imagen_actual: number | null;
  image_url: string | null;
  mapper_enabled: boolean;
  calibration_json: any;
  blackout: boolean;
  locked: boolean;
}

interface PairingResponse {
  pairing_code: string;
  expires_at: string;
}

interface StatusResponse {
  status: 'WAITING' | 'PAIRED' | 'EXPIRED';
  device_token?: string;
}

@Component({
  selector: 'app-visor',
  standalone: true,
  imports: [CommonModule, Mapper],
  templateUrl: './visor.component.html',
  styleUrl: './visor.component.css'
})
export class VisorComponent implements OnInit, OnDestroy {
  // State
  mode: 'LOADING' | 'PAIRING' | 'PROJECTION' | 'ERROR' = 'LOADING';
  pairingCode: string = '';
  errorMessage: string = '';
  deviceToken: string | null = null;
  mesaState: MesaState | null = null;
  mesaIdForPairing: number | null = null; // Can be null for generic player mode

  get isSupervisor(): boolean {
    return !!this.mesaIdForPairing;
  }

  // Subscriptions
  private pairingPollSub: Subscription | null = null;
  private statePollSub: Subscription | null = null;
  private heartbeatSub: Subscription | null = null;

  private apiUrl = '/api/device/';
  private isBrowser: boolean;

  constructor(
    private route: ActivatedRoute,
    private http: HttpClient,
    private cdr: ChangeDetectorRef,
    private ngZone: NgZone,
    @Inject(PLATFORM_ID) platformId: Object
  ) {
    this.isBrowser = isPlatformBrowser(platformId);
  }

  ngOnInit(): void {
    if (!this.isBrowser) return;

    // Check for mesa ID in route (optional)
    const idParam = this.route.snapshot.paramMap.get('id');
    if (idParam) {
      this.mesaIdForPairing = parseInt(idParam, 10);
    }

    // Check localStorage for existing token
    this.deviceToken = localStorage.getItem('device_token');

    if (this.deviceToken) {
      this.enterProjectionMode();
    } else {
      this.requestPairingCode();
    }
  }

  ngOnDestroy(): void {
    this.pairingPollSub?.unsubscribe();
    this.statePollSub?.unsubscribe();
    this.heartbeatSub?.unsubscribe();
  }

  // =========================================================================
  // PAIRING MODE
  // =========================================================================
  requestPairingCode(): void {
    this.mode = 'LOADING';
    console.log('[Visor] Requesting pairing code. Mesa ID:', this.mesaIdForPairing);
    console.log('[Visor] API URL:', `${this.apiUrl}init/`);

    // Payload depends on whether we have a specific mesa ID or not
    const payload = this.mesaIdForPairing ? { mesa_id: this.mesaIdForPairing } : {};

    this.http.post<PairingResponse>(`${this.apiUrl}init/`, payload)
      .subscribe({
        next: (res) => {
          console.log('[Visor] Received pairing code:', res);
          this.pairingCode = res.pairing_code;
          this.mode = 'PAIRING';
          this.cdr.detectChanges(); // Force UI update
          this.startPairingPolling();
        },
        error: (err) => {
          console.error('[Visor] Error requesting pairing code:', err);
          this.errorMessage = err.message || 'Error requesting pairing code';
          this.mode = 'ERROR';
        }
      });
  }

  startPairingPolling(): void {
    // Poll every 3 seconds
    this.pairingPollSub = interval(3000).pipe(
      switchMap(() => this.http.get<StatusResponse>(`${this.apiUrl}status/?code=${this.pairingCode}`)),
      catchError(err => {
        console.error('Pairing poll error:', err);
        return of({ status: 'WAITING' } as StatusResponse);
      })
    ).subscribe({
      next: (res) => {
        if (res.status === 'PAIRED' && res.device_token) {
          // Save token and switch mode
          this.deviceToken = res.device_token;
          localStorage.setItem('device_token', res.device_token);
          this.pairingPollSub?.unsubscribe();
          this.enterProjectionMode();
        } else if (res.status === 'EXPIRED') {
          // Request a new code
          this.pairingPollSub?.unsubscribe();
          this.requestPairingCode();
        }
      }
    });
  }

  // =========================================================================
  // PROJECTION MODE
  // =========================================================================
  enterProjectionMode(): void {
    this.ngZone.run(() => {
      console.log('[Visor] Entering Projection Mode (Zone aware)');
      this.mode = 'PROJECTION';
      this.cdr.detectChanges(); // Double safety
      this.startStatePolling();
      this.startHeartbeat();
    });
  }

  // ... (unchanged methods) ...



  private getAuthHeaders(): HttpHeaders {
    return new HttpHeaders({
      'Authorization': `Bearer ${this.deviceToken}`
    });
  }

  private eventSource: EventSource | null = null;
  private reconnectTimer: any = null;

  connectToSSE(): void {
    if (this.eventSource) {
      this.eventSource.close();
    }

    const url = `${this.apiUrl}stream/?token=${this.deviceToken}`;
    console.log('[Visor] Connecting to SSE:', url);

    this.eventSource = new EventSource(url);

    this.eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'calibration') {
          console.log('[Visor] SSE Calibration received:', payload.data);
          // If we receive data, construct a partial MesaState to update calibration
          if (this.mesaState) {
            this.mesaState = { ...this.mesaState, calibration_json: payload.data };
          } else {
            // Initial state if null
            this.mesaState = { calibration_json: payload.data } as any;
          }
          this.cdr.detectChanges();
        }
      } catch (e) {
        console.error('[Visor] SSE Parse Error:', e);
      }
    };

    this.eventSource.onerror = (err) => {
      console.error('[Visor] SSE Error:', err);
      this.eventSource?.close();
      this.eventSource = null;

      // Reconnect after 3 seconds
      if (!this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.connectToSSE();
        }, 3000);
      }
    };
  }

  startStatePolling(): void {
    // Legacy polling replaced by SSE
    // But we still fetch initial state once to get full data (name, etc)
    this.fetchMesaState();
    this.connectToSSE();
  }

  fetchMesaState(): void {
    this.http.get<MesaState>(`${this.apiUrl}state/`, { headers: this.getAuthHeaders() })
      .pipe(catchError(err => {
        if (err.status === 401) this.handleUnauthorized();
        return of(null);
      }))
      .subscribe(state => {
        if (state) {
          this.mesaState = state;
          // After fetching state, ensure we are connected to stream
          if (!this.eventSource) this.connectToSSE();
        }
      });
  }

  startHeartbeat(): void {
    // Send heartbeat every 30 seconds
    this.heartbeatSub = interval(30000).pipe(
      switchMap(() => this.http.post(`${this.apiUrl}heartbeat/`, {}, { headers: this.getAuthHeaders() })),
      catchError(err => of(null))
    ).subscribe();
  }

  handleUnauthorized(): void {
    // Clear token and return to pairing
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    localStorage.removeItem('device_token');
    this.deviceToken = null;
    this.mesaState = null;
    this.statePollSub?.unsubscribe();
    this.heartbeatSub?.unsubscribe();
    this.requestPairingCode();
  }
}
