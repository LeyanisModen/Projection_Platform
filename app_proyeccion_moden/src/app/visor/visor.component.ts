import { Component, OnInit, OnDestroy, Inject, PLATFORM_ID, ChangeDetectorRef, NgZone, HostListener } from '@angular/core';
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

  // Helper to get token storage key (mesa-specific when ID is present)
  private getTokenKey(): string {
    return this.mesaIdForPairing ? `device_token_${this.mesaIdForPairing}` : 'device_token';
  }

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

    // SUPERVISOR MODE: /visor/:id - Load mesa directly by ID
    // Check if we have a token for this mesa first!
    if (this.mesaIdForPairing) {
      this.deviceToken = localStorage.getItem(this.getTokenKey()); // Try load token
      this.loadMesaDirectly(this.mesaIdForPairing);
      return;
    }

    // PLAYER MODE: /player - Use device token for pairing
    this.deviceToken = localStorage.getItem(this.getTokenKey());

    if (this.deviceToken) {
      this.enterProjectionMode();
    } else {
      this.requestPairingCode();
    }
  }

  // Load mesa directly by ID (for supervisor mode)
  private loadMesaDirectly(mesaId: number): void {
    this.mode = 'LOADING';
    this.http.get<MesaState>(`/api/mesas/${mesaId}/`).subscribe({
      next: (mesa) => {
        this.mesaState = mesa;
        console.log('[Visor Debug] Mesa loaded:', mesa);
        this.mode = 'PROJECTION';
        this.cdr.detectChanges();
        this.startStatePolling();
        this.startStatePolling(); // Ensure polling starts!
      },
      error: (err) => {
        console.error('[Visor] Error loading mesa:', err);
        this.errorMessage = 'No se pudo cargar la mesa';
        this.mode = 'ERROR';
      }
    });
  }

  ngOnDestroy(): void {
    this.pairingPollSub?.unsubscribe();
    this.statePollSub?.unsubscribe();
    this.heartbeatSub?.unsubscribe();
    this.itemPollSub?.unsubscribe();
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
          localStorage.setItem(this.getTokenKey(), res.device_token);
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

    if (!this.deviceToken) {
      console.warn('[Visor] Skipping SSE connection (No Token)');
      return;
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

  // Player Logic State
  activeItem: any | null = null;
  images: any[] = [];
  currentIndex: number = 0;
  loadingImages = false;
  private itemPollSub: Subscription | null = null;

  get projectedImage(): string | null {
    if (this.images && this.images.length > 0 && this.images[this.currentIndex]) {
      return this.images[this.currentIndex].url;
    }
    return this.mesaState?.image_url ?? null;
  }

  get showOverlay(): boolean {
    // Show overlay if we have an item (even if loading or empty, so we can debug)
    return !!this.activeItem;
  }

  get isCalibrationActive(): boolean {
    // Enable calibration if supervisor AND (no image projected OR mapper explicitly enabled)
    return this.isSupervisor && (!this.projectedImage || !!this.mesaState?.mapper_enabled);
  }

  @HostListener('window:keydown', ['$event'])
  handleKeyboardEvent(event: KeyboardEvent) {
    if (this.mode !== 'PROJECTION' || !this.images.length) return;

    if (event.key === 'ArrowRight') {
      this.nextImage();
    } else if (event.key === 'ArrowLeft') {
      this.prevImage();
    }
  }

  nextImage(): void {
    if (this.currentIndex < this.images.length - 1) {
      this.currentIndex++;
      this.updateProjectedImage();
    } else {
      // End of list -> Complete Item
      this.finishActiveItem();
    }
  }

  prevImage(): void {
    if (this.currentIndex > 0) {
      this.currentIndex--;
      this.updateProjectedImage();
    }
  }

  // Optional: Update local mesa state visually if needed (though we just show the image)
  updateProjectedImage(): void {
    // We could locally allow "previewing" next image, 
    // but the requirement implies we just navigate LOCALLY in the player 
    // and only update backend when finished?
    // "dado una lista permitía cambiar de imagen utilizando las teclas"
    // So yes, local navigation. 
    this.cdr.detectChanges();
  }

  finishActiveItem(): void {
    if (!this.activeItem) return;

    console.log('[Visor] Finishing item:', this.activeItem.id);
    this.http.post(`/api/mesa-queue-items/${this.activeItem.id}/marcar_hecho/`, {})
      .subscribe({
        next: () => {
          console.log('[Visor] Item finished');
          // Clear current state and wait for next poll to pick up new item
          this.activeItem = null;
          this.images = [];
          this.currentIndex = 0;
          this.cdr.detectChanges();
          // Force immediate poll
          this.checkActiveItem();
        },
        error: (err) => console.error('[Visor] Error finishing item:', err)
      });
  }

  startStatePolling(): void {
    // 1. Fetch initial Mesa State (Name, ID)
    this.fetchMesaState();

    // 2. Connect to SSE for Calibration
    this.connectToSSE();

    // 3. Start Polling for Active Work Item (Content)
    this.itemPollSub = interval(2000).pipe(
      startWith(0),
      switchMap(() => {
        if (!this.mesaState?.id) return of(null);
        return this.http.get<any>(`/api/mesas/${this.mesaState.id}/current_item/`).pipe(
          catchError(err => of(null)) // 404 if no item showing
        );
      })
    ).subscribe(item => {
      console.log('[Visor Debug] Poll Item found:', item);
      this.handleActiveItemUpdate(item);
    });
  }

  checkActiveItem(): void {
    if (!this.mesaState?.id) return;
    this.http.get<any>(`/api/mesas/${this.mesaState.id}/current_item/`)
      .pipe(catchError(() => of(null)))
      .subscribe(item => this.handleActiveItemUpdate(item));
  }

  handleActiveItemUpdate(item: any): void {
    // If no item showing
    if (!item) {
      if (this.activeItem) {
        // We had an item, now gone
        this.activeItem = null;
        this.images = [];
        this.cdr.detectChanges();
      }
      return;
    }

    // If new item detected
    if (!this.activeItem || this.activeItem.id !== item.id) {
      console.log('[Visor] New active item:', item);
      this.activeItem = item;
      this.loadImagesForActiveItem();
    }
  }

  loadImagesForActiveItem(): void {
    if (!this.activeItem) return;

    this.loadingImages = true;
    // Fetch images for Module + Fase
    // Query: /api/imagenes/?modulo=X&fase=Y
    const url = `/api/imagenes/?modulo=${this.activeItem.modulo}&fase=${this.activeItem.fase}`;

    this.http.get<any[]>(url).subscribe({
      next: (imgs) => {
        console.log(`[Visor Debug] Images API Response:`, imgs);
        if (!Array.isArray(imgs)) {
          console.error('[Visor Debug] Expected array of images, got:', typeof imgs);
          this.images = [];
        } else {
          console.log(`[Visor Debug] Loaded ${imgs.length} images for item`, this.activeItem);
          this.images = imgs;
        }
        this.currentIndex = 0;
        this.loadingImages = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('[Visor] Error loading images:', err);
        this.loadingImages = false;
      }
    });
  }


  fetchMesaState(): void {
    this.http.get<MesaState>(`${this.apiUrl}state/`, { headers: this.getAuthHeaders() })
      .pipe(catchError(err => {
        console.error('[Visor Debug] State Fetch Error:', err.status, err);
        if (err.status === 401) this.handleUnauthorized('StatePolling');
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

  private authRetries = 0;

  handleUnauthorized(source: string = 'Unknown'): void {
    this.authRetries++;
    console.warn(`[Visor] Unauthorized (401) from ${source}. Retry count: ${this.authRetries}`);

    if (this.authRetries > 3) {
      console.error('[Visor] Max auth retries exceeded. Resetting session.');
      if (this.eventSource) {
        this.eventSource.close();
        this.eventSource = null;
      }
      localStorage.removeItem(this.getTokenKey());
      this.deviceToken = null;
      this.mesaState = null;
      this.statePollSub?.unsubscribe();
      this.heartbeatSub?.unsubscribe();
      this.requestPairingCode();
    }
  }
}
