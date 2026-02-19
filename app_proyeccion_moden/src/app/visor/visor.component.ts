import { Component, OnInit, OnDestroy, Inject, PLATFORM_ID, ChangeDetectorRef, NgZone, HostListener } from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { Title } from '@angular/platform-browser';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { interval, Subscription, switchMap, of, catchError, exhaustMap, startWith } from 'rxjs';
import { Mapper } from '../mapper/mapper';
import { environment } from '../../environments/environment';

interface MesaState {
  id: number;
  nombre: string;
  imagen_actual: number | null;
  image_url: string | null;
  mapper_enabled: boolean;
  current_image_index: number;
  calibration_json: any;
  blackout: boolean;
  locked: boolean;
  is_linked?: boolean;
}

interface PairingResponse {
  pairing_code: string;
  expires_at: string;
}

interface StatusResponse {
  status: 'WAITING' | 'PAIRED' | 'EXPIRED';
  device_token?: string;
  mesa_id?: number;
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
  mesaIdForPairing: number | null = null;

  currentIndex: number = 0;
  private previousIndex: number = 0;
  activeItem: any = null;
  images: any[] = [];
  loadingImages = false;

  get isSupervisor(): boolean {
    return !!this.mesaIdForPairing;
  }

  // Subscriptions
  private pairingPollSub: Subscription | null = null;
  private statePollSub: Subscription | null = null;
  private heartbeatSub: Subscription | null = null;
  private itemPollSub: Subscription | null = null;

  private apiUrl = `${environment.apiUrl}/device/`;
  private isBrowser: boolean;

  // Helper to get token storage key
  private getTokenKey(): string {
    return this.mesaIdForPairing ? `device_token_${this.mesaIdForPairing}` : 'device_token';
  }

  constructor(
    private route: ActivatedRoute,
    private http: HttpClient,
    private cdr: ChangeDetectorRef,
    private ngZone: NgZone,
    private titleService: Title,
    @Inject(PLATFORM_ID) platformId: Object
  ) {
    this.isBrowser = isPlatformBrowser(platformId);
  }

  ngOnInit(): void {
    if (!this.isBrowser) return;

    const idParam = this.route.snapshot.paramMap.get('id');
    if (idParam) {
      this.mesaIdForPairing = parseInt(idParam, 10);
    }

    this.deviceToken = localStorage.getItem(this.getTokenKey());

    if (this.mesaIdForPairing) {
      this.loadMesaDirectly(this.mesaIdForPairing);
    } else if (this.deviceToken) {
      this.enterProjectionMode();
    } else {
      this.requestPairingCode();
    }
  }

  private loadMesaDirectly(mesaId: number): void {
    this.mode = 'LOADING';
    this.http.get<MesaState>(`/api/mesas/${mesaId}/`, { headers: this.getUserAuthHeaders() }).subscribe({
      next: (mesa) => {
        this.mesaState = mesa;
        if (mesa.nombre) {
          this.titleService.setTitle(`Visor - ${mesa.nombre}`);
        }
        this.mode = 'PROJECTION';
        this.startStatePolling();
        this.cdr.detectChanges();
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
    if (this.eventSource) this.eventSource.close();
  }

  requestPairingCode(): void {
    this.mode = 'LOADING';
    const payload = this.mesaIdForPairing ? { mesa_id: this.mesaIdForPairing } : {};
    this.http.post<PairingResponse>(`${this.apiUrl}init/`, payload).subscribe({
      next: (res) => {
        this.pairingCode = res.pairing_code;
        this.mode = 'PAIRING';
        this.cdr.detectChanges();
        this.startPairingPolling();
      },
      error: (err) => {
        this.errorMessage = err.message || 'Error requesting pairing code';
        this.mode = 'ERROR';
      }
    });
  }

  startPairingPolling(): void {
    this.pairingPollSub = interval(3000).pipe(
      switchMap(() => this.http.get<StatusResponse>(`${this.apiUrl}status/?code=${this.pairingCode}`)),
      catchError(err => of({ status: 'WAITING' } as StatusResponse))
    ).subscribe({
      next: (res) => {
        if (res.status === 'PAIRED' && res.device_token) {
          this.deviceToken = res.device_token;
          localStorage.setItem(this.getTokenKey(), res.device_token);
          this.pairingPollSub?.unsubscribe();
          this.enterProjectionMode();
        } else if (res.status === 'EXPIRED') {
          this.pairingPollSub?.unsubscribe();
          this.requestPairingCode();
        }
      }
    });
  }

  enterProjectionMode(): void {
    this.ngZone.run(() => {
      this.mode = 'PROJECTION';
      this.cdr.detectChanges();
      this.startStatePolling();
      if (!this.isSupervisor) {
        this.startHeartbeat();
      }
    });
  }

  private getAuthHeaders(): HttpHeaders {
    let headers = new HttpHeaders();
    if (this.deviceToken) {
      headers = headers.set('Authorization', `Bearer ${this.deviceToken}`);
    }
    return headers;
  }

  private getUserAuthHeaders(): HttpHeaders {
    const token = localStorage.getItem('auth_token');
    let headers = new HttpHeaders();
    if (token) {
      headers = headers.set('Authorization', `Token ${token}`);
    }
    return headers;
  }

  private eventSource: EventSource | null = null;
  private lastSseErrorLogAt = 0;

  connectToSSE(): void {
    if (this.isSupervisor) {
      return;
    }

    if (this.eventSource) this.eventSource.close();

    // Fallback for supervisor: pass mesa_id if no token
    let url = '';
    if (this.deviceToken) {
      url = `${this.apiUrl}stream/?token=${this.deviceToken}`;
    } else if (this.mesaIdForPairing) {
      url = `${this.apiUrl}stream/?mesa_id=${this.mesaIdForPairing}`;
    } else {
      console.warn('[Visor] Skipping SSE connection (No Token/MesaId)');
      return;
    }

    this.eventSource = new EventSource(url);

    this.eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'calibration') {
          if (this.mesaState) {
            this.mesaState = {
              ...this.mesaState,
              calibration_json: payload.data.corners ? { corners: payload.data.corners } : this.mesaState.calibration_json,
              mapper_enabled: payload.data.mapper_enabled,
              current_image_index: payload.data.current_image_index
            };
          } else {
            this.mesaState = payload.data as any;
          }

          if (payload.data.current_image_index !== undefined && payload.data.current_image_index !== this.currentIndex) {
            this.currentIndex = payload.data.current_image_index;
          }
          this.cdr.detectChanges();
        }
      } catch (e) {
        console.error('[Visor] SSE Parse Error:', e);
      }
    };

    this.eventSource.onerror = () => {
      const now = Date.now();
      // EventSource reconnects automatically; keep logs throttled.
      if (now - this.lastSseErrorLogAt > 30000) {
        console.warn('[Visor] SSE disconnected/reconnecting...');
        this.lastSseErrorLogAt = now;
      }
    };
  }

  get projectedImage(): string | null {
    if (this.currentIndex === -1) return '/assets/calibration_grid.jpg';
    if (this.currentIndex === -2) return '/assets/calibration_grid_with_x.jpg';
    if (this.images.length > 0 && this.currentIndex >= 0 && this.currentIndex < this.images.length) {
      return this.images[this.currentIndex].url || this.images[this.currentIndex].src || this.images[this.currentIndex];
    }
    return this.mesaState?.image_url ?? null;
  }

  get showOverlay(): boolean {
    return !!this.activeItem && this.currentIndex >= 0;
  }

  get isCalibrationActive(): boolean {
    return this.isSupervisor && this.currentIndex < 0;
  }

  @HostListener('window:keydown', ['$event'])
  handleKeyboardEvent(event: KeyboardEvent) {
    if (this.mode !== 'PROJECTION') return;
    const key = event.key.toLowerCase();
    if (key === 'c') {
      this.toggleCalibration(-1);
    } else if (key === 'g') {
      this.toggleCalibration(-2);
    } else if (key === 'arrowright') {
      // Don't navigate if in calibration mode (index < 0)
      if (this.currentIndex >= 0) {
        this.nextImage();
      }
    } else if (key === 'arrowleft') {
      if (this.currentIndex >= 0) {
        this.prevImage();
      }
    }
  }

  toggleCalibration(targetIndex: number): void {
    if (this.currentIndex >= 0) {
      // Enter calibration from normal mode
      this.previousIndex = this.currentIndex;
      this.currentIndex = targetIndex;
    } else if (this.currentIndex === targetIndex) {
      // Toggle off if already in this specific calibration mode
      this.currentIndex = this.previousIndex;
    } else {
      // Switch between calibration modes (e.g. -1 to -2)
      this.currentIndex = targetIndex;
    }
    this.updateProjectedImage();
  }

  nextImage(): void {
    if (this.currentIndex < 0) return;

    if (this.currentIndex < this.images.length - 1) {
      this.currentIndex++;
      this.updateProjectedImage();
    } else if (this.images.length > 0) {
      this.finishActiveItem();
    }
  }

  prevImage(): void {
    if (this.currentIndex < 0) return;

    if (this.currentIndex > 0) {
      this.currentIndex--;
      this.updateProjectedImage();
    }
  }

  updateProjectedImage(): void {
    if (this.isSupervisor) {
      this.cdr.detectChanges();
      return;
    }

    const mesaId = this.mesaIdForPairing || this.mesaState?.id;
    if (!mesaId) return;

    this.http.post(`${this.apiUrl}set_index/`, { mesa_id: mesaId, index: this.currentIndex }, { headers: this.getAuthHeaders() })
      .subscribe({
        next: () => this.cdr.detectChanges(),
        error: (err) => console.error('[Visor] Error syncing index:', err)
      });
  }

  finishActiveItem(): void {
    if (!this.activeItem) return;
    if (this.isSupervisor) {
      this.http.post(`/api/mesa-queue-items/${this.activeItem.id}/marcar_hecho/`, {}, { headers: this.getUserAuthHeaders() })
        .subscribe({
          next: () => {
            this.activeItem = null;
            this.images = [];
            this.currentIndex = 0;
            this.cdr.detectChanges();
            this.checkActiveItem();
          },
          error: (err) => console.error('[Visor] Error finishing item:', err)
        });
      return;
    }

    this.http.post(`${this.apiUrl}mark_done/`, {}, { headers: this.getAuthHeaders() })
      .subscribe({
        next: () => {
          this.activeItem = null;
          this.images = [];
          this.currentIndex = 0;
          this.cdr.detectChanges();
          this.checkActiveItem();
        },
        error: (err) => console.error('[Visor] Error finishing item (device):', err)
      });
  }

  startStatePolling(): void {
    if (this.isSupervisor) {
      this.fetchMesaStateFromApi();
    } else {
      this.fetchMesaState();
      this.connectToSSE();
    }

    const itemPollMs = this.isSupervisor ? 2000 : 5000;
    this.itemPollSub = interval(itemPollMs).pipe(
      startWith(0),
      exhaustMap(() => {
        if (this.isSupervisor) {
          const id = this.mesaIdForPairing || this.mesaState?.id;
          if (!id) return of(null);
          return this.http.get<any>(`/api/mesas/${id}/current_item/`, { headers: this.getUserAuthHeaders() }).pipe(
            catchError(() => of(null))
          );
        }
        return this.http.get<any>(`${this.apiUrl}current_item/`, { headers: this.getAuthHeaders() }).pipe(
          catchError((err) => {
            if (err.status === 401) this.handleUnauthorized('CurrentItemPolling');
            return of(null);
          })
        );
      })
    ).subscribe(item => this.handleActiveItemUpdate(item));
  }

  checkActiveItem(): void {
    if (this.isSupervisor) {
      const id = this.mesaIdForPairing || this.mesaState?.id;
      if (!id) return;
      this.http.get<any>(`/api/mesas/${id}/current_item/`, { headers: this.getUserAuthHeaders() })
        .pipe(catchError(() => of(null)))
        .subscribe(item => this.handleActiveItemUpdate(item));
      return;
    }

    this.http.get<any>(`${this.apiUrl}current_item/`, { headers: this.getAuthHeaders() })
      .pipe(catchError((err) => {
        if (err.status === 401) this.handleUnauthorized('CurrentItemCheck');
        return of(null);
      }))
      .subscribe(item => this.handleActiveItemUpdate(item));
  }

  handleActiveItemUpdate(item: any): void {
    if (!item) {
      if (this.activeItem) {
        this.activeItem = null;
        this.images = [];
        this.cdr.detectChanges();
      }
      return;
    }

    if (!this.activeItem || this.activeItem.id !== item.id) {
      this.activeItem = item;
      if (Array.isArray(item.images)) {
        this.images = item.images;
        if (this.currentIndex >= this.images.length || this.currentIndex < 0) {
          this.currentIndex = 0;
        }
        this.loadingImages = false;
        this.cdr.detectChanges();
      } else {
        this.loadImagesForActiveItem();
      }
    }
  }

  loadImagesForActiveItem(): void {
    if (!this.activeItem) return;
    this.loadingImages = true;
    const url = `/api/imagenes/?modulo=${this.activeItem.modulo}&fase=${this.activeItem.fase}`;
    this.http.get<any[]>(url, { headers: this.getUserAuthHeaders() }).subscribe({
      next: (imgs) => {
        this.images = Array.isArray(imgs) ? imgs : [];
        // Only reset index if we are NOT in calibration mode
        if (this.currentIndex !== -1) {
          this.currentIndex = 0;
        }
        this.loadingImages = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('[Visor] Error loading images:', err);
        this.loadingImages = false;
      }
    });
  }

  fetchMesaStateFromApi(): void {
    const mesaId = this.mesaIdForPairing || this.mesaState?.id;
    if (!mesaId) return;

    this.http.get<MesaState>(`/api/mesas/${mesaId}/`, { headers: this.getUserAuthHeaders() })
      .pipe(catchError(err => {
        if (err.status === 401) {
          this.errorMessage = 'Sesion expirada. Vuelve a iniciar sesion en el dashboard.';
          this.mode = 'ERROR';
          this.cdr.detectChanges();
        }
        return of(null);
      }))
      .subscribe((state: MesaState | null) => {
        if (state) {
          this.mesaState = state;
          if (state.nombre) {
            this.titleService.setTitle(`Visor - ${state.nombre}`);
          }
          this.cdr.detectChanges();
        }
      });
  }

  fetchMesaState(): void {
    const mesaId = this.mesaIdForPairing || this.mesaState?.id;
    const params: Record<string, string> = {};
    if (mesaId) {
      params['mesa_id'] = mesaId.toString();
    }
    const options = { headers: this.getAuthHeaders(), params };

    this.http.get<MesaState>(`${this.apiUrl}state/`, options)
      .pipe(catchError(err => {
        if (err.status === 401) this.handleUnauthorized('StatePolling');
        return of(null);
      }))
      .subscribe((state: MesaState | null) => {
        if (state) {
          this.mesaState = state;
          if (state.nombre) {
            this.titleService.setTitle(`Visor - ${state.nombre}`);
          }
          if (state.current_image_index !== undefined && this.currentIndex !== -1) {
            this.currentIndex = state.current_image_index;
          }
          if (!this.eventSource) this.connectToSSE();
        }
      });
  }

  startHeartbeat(): void {
    this.heartbeatSub = interval(30000).pipe(
      switchMap(() => {
        const mesaId = this.mesaIdForPairing || this.mesaState?.id;
        const payload = mesaId ? { mesa_id: mesaId } : {};
        return this.http.post(`${this.apiUrl}heartbeat/`, payload, { headers: this.getAuthHeaders() });
      }),
      catchError((err) => {
        if (err.status === 401) this.handleUnauthorized('Heartbeat');
        return of(null);
      })
    ).subscribe();
  }

  private authRetries = 0;
  handleUnauthorized(source: string = 'Unknown'): void {
    if (this.isSupervisor) {
      this.errorMessage = 'Sesion expirada. Vuelve a iniciar sesion en el dashboard.';
      this.mode = 'ERROR';
      this.cdr.detectChanges();
      return;
    }

    console.warn(`[Visor] Unauthorized access detected from ${source}. Retries: ${this.authRetries}`);
    this.authRetries++;
    // If token is invalid, it's usually permanent (unlinked). Fail fast.
    if (this.authRetries >= 1) {
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
      this.authRetries = 0; // Reset counter
    }
  }
}
