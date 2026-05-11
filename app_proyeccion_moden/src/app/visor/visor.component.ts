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
  capture_service_online?: boolean | null;
  camera_sharpness?: 'ok' | 'warning' | 'blurry' | 'unknown' | null;
  check_overlay?: 'success' | 'error' | 'no_camera' | null;
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

  // Photo capture
  private captureServiceUrl = 'http://127.0.0.1:5555';
  private capturingPhoto = false;
  private captureMode: 'foto' | 'check' = 'foto';
  captureStatus: 'idle' | 'capturing' | 'uploading' | 'done' | 'error' = 'idle';

  // Local capture-service health (null = unknown, true = ok, false = down)
  captureServiceOnline: boolean | null = null;
  // Daily lens sharpness status (unknown | ok | warning | blurry)
  cameraSharpness: 'unknown' | 'ok' | 'warning' | 'blurry' = 'unknown';
  private captureHealthSub: Subscription | null = null;

  // White screen (blank projection for photo capture or manual pause)
  whiteScreen = false;

  // Color-check overlay: shown after a '_check' photo is validated.
  // The source of truth is mesa.check_overlay on the backend, mirrored
  // by the state polling so player and visor see the same thing. We
  // also set it locally for instant feedback (optimistic update); the
  // poll then either confirms or corrects it.
  checkOverlay: 'none' | 'success' | 'error' | 'no_camera' = 'none';
  // Local-only debug snapshot of the latest check (cards expected vs.
  // detected, missing colours). Set on the mini-PC after upload_foto
  // when the backend is in COLOR_CHECK_DEBUG mode. Only displayed in
  // the player view -- the supervisor sees just the ✓/✗ overlay and
  // can open the annotated image on Drive for the rest.
  checkDebugInfo: {
    expected_counts?: Record<string, number>;
    cards_per_color?: Record<string, number>;
    missing?: Record<string, number>;
  } | null = null;
  // Status of the round-trip backend->visor->capture_service->Drive.
  // Surfaces in the same debug panel so we can see from AnyDesk
  // whether the bytes ever leave Chrome (kiosk blocks F12).
  checkMirrorStatus: string | null = null;
  private checkBlock = false;
  private checkSuccessTimer: any = null;
  // While a clear request is in flight, ignore the polling so we
  // don't briefly re-paint a state we just told the backend to drop.
  private clearingOverlay = false;

  // Retry budget for the local capture service when a _check photo
  // can't be taken. Three attempts spaced by 1 s gives the cable /
  // service ~3 s to recover before we surface the failure.
  private static readonly CAPTURE_MAX_ATTEMPTS = 3;
  private static readonly CAPTURE_RETRY_MS = 1000;
  // True only from the second capture attempt onwards -- used to
  // decide whether to project the 'waiting for camera' slide. On the
  // first attempt we keep the original _check.jpg blueprint on screen
  // so the operator doesn't see a flash of 'waiting' every time the
  // camera is healthy.
  private cameraRetrying = false;

  // 5-second lock between slides so the operator reads the caption before
  // moving on (many consecutive slides only change the title text).
  private static readonly SLIDE_LOCK_MS = 5000;
  private slideLockUntil = 0;

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
  private assetBase = '/';

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

    const baseHref = (document.querySelector('base')?.getAttribute('href') || '/').trim();
    this.assetBase = baseHref.endsWith('/') ? baseHref : `${baseHref}/`;

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

    // The local capture service only exists on the mini-PC. In
    // supervisor mode (visor opened from another computer) the camera
    // health is read from the mesa state, which the mini-PC reports to
    // the backend via heartbeat — see startStatePolling().
    if (!this.isSupervisor) {
      this.startCaptureHealthPolling();
    }
  }

  private startCaptureHealthPolling(): void {
    // Poll /stats so we pick up both health + daily sharpness status
    // in the same request. Immediately on load, then every 30 s.
    this.captureHealthSub = interval(30000).pipe(
      startWith(0),
      switchMap(() =>
        this.http.get<any>(`${this.captureServiceUrl}/stats`)
          .pipe(catchError(() => of(null)))
      )
    ).subscribe(stats => {
      if (stats === null) {
        this.captureServiceOnline = false;
      } else {
        this.captureServiceOnline = true;
        const status = stats?.sharpness_status;
        if (status === 'ok' || status === 'warning' || status === 'blurry' || status === 'unknown') {
          this.cameraSharpness = status;
        }
      }
      this.cdr.detectChanges();
    });
  }

  private loadMesaDirectly(mesaId: number): void {
    this.mode = 'LOADING';
    this.http.get<MesaState>(`/api/mesas/${mesaId}/`, { headers: this.getUserAuthHeaders() }).subscribe({
      next: (mesa) => {
        this.mesaState = mesa;
        if (typeof mesa.current_image_index === 'number') {
          this.currentIndex = mesa.current_image_index;
        }
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
    this.captureHealthSub?.unsubscribe();
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
    if (this.currentIndex === -1) return `${this.assetBase}assets/calibration_grid.jpg`;
    if (this.currentIndex === -2) return `${this.assetBase}assets/calibration_grid_with_x.jpg`;

    // Color-check states: project a dedicated slide through the same
    // perspective transform as the blueprint, so the operator at the
    // mesa sees the result aligned to the table without any HTML
    // overlay on top.
    if (this.checkOverlay === 'no_camera') return `${this.assetBase}assets/check/check_no_camera.jpg`;
    if (this.checkOverlay === 'error')     return `${this.assetBase}assets/check/check_error.jpg`;
    if (this.checkOverlay === 'success')   return `${this.assetBase}assets/check/check_success.jpg`;
    // Show the 'waiting for camera' slide only once we're past the
    // first capture attempt -- if the camera answers fast on attempt
    // 1 the operator never sees it. Keeps the _check.jpg blueprint
    // visible while everything is healthy.
    if (this.cameraRetrying) {
      return `${this.assetBase}assets/check/check_waiting.jpg`;
    }

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

    // A failed color check blocks navigation until the operator
    // acknowledges it with space. SPACE clears the red overlay AND
    // advances to the next slide -- the operator should not have to
    // press two keys to recover. Calibration toggles still work.
    if (this.checkBlock) {
      if (key === ' ' || key === 'spacebar' || key === 'space') {
        event.preventDefault();
        this.clearCheckOverlay();
        // Bypass the 5 s read-lock: the operator already waited blocked
        // on the failed check, no need to make them wait again.
        this.slideLockUntil = 0;
        this.nextImage();
        return;
      }
      if (key === 'arrowright' || key === 'arrowleft') {
        return;
      }
    }

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
    } else if (key === 'p') {
      // Manual photo capture trigger (for testing)
      this.triggerPhotoCapture('foto');
    } else if (key === 'w') {
      // Toggle white screen (manual pause)
      this.whiteScreen = !this.whiteScreen;
      this.cdr.detectChanges();
    }
  }

  private clearCheckOverlay(): void {
    if (this.checkOverlay === 'none' && !this.checkBlock) return;
    this.checkOverlay = 'none';
    this.checkBlock = false;
    this.checkDebugInfo = null;
    this.checkMirrorStatus = null;
    if (this.checkSuccessTimer) {
      clearTimeout(this.checkSuccessTimer);
      this.checkSuccessTimer = null;
    }
    this.cdr.detectChanges();

    // Tell the backend so the other view (player or visor) clears too.
    this.clearingOverlay = true;
    const url = `${this.apiUrl}clear_check_overlay/`;
    const { headers, body } = this.deviceOrSupervisorRequest();
    this.http.post(url, body, { headers }).subscribe({
      next: () => { this.clearingOverlay = false; },
      error: (err) => {
        console.error('[Visor] clear_check_overlay failed:', err);
        this.clearingOverlay = false;
      }
    });
  }

  private notifyNoCamera(): void {
    const url = `${this.apiUrl}notify_no_camera/`;
    const { headers, body } = this.deviceOrSupervisorRequest();
    this.http.post(url, body, { headers }).subscribe({
      next: () => {},
      error: (err) => console.error('[Visor] notify_no_camera failed:', err),
    });
  }

  private deviceOrSupervisorRequest(): { headers: HttpHeaders; body: any } {
    const body: any = {};
    let headers: HttpHeaders;
    if (this.isSupervisor) {
      headers = this.getUserAuthHeaders();
      const mesaId = this.mesaIdForPairing || this.mesaState?.id;
      if (mesaId) body['mesa_id'] = mesaId;
    } else {
      headers = this.getAuthHeaders();
    }
    return { headers, body };
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
    if (Date.now() < this.slideLockUntil) return;
    // While a _check capture is in flight, freeze the navigation: the
    // 5 s read-lock can run out before the round-trip
    // camera + backend finishes, and we must not let the operator skip
    // a verification step.
    if (this.capturingPhoto && this.captureMode === 'check') return;

    // After a successful auto check, advance TWO slides in one press:
    // by convention the slide right after a _check is the manual
    // visual-revision step, only relevant when the auto check failed.
    // SPACE-cleared overlays (error / no_camera) advance just one,
    // landing on that visual revision exactly when needed.
    const step = this.checkOverlay === 'success' ? 2 : 1;

    if (this.currentIndex < this.images.length - step) {
      // Clear any lingering overlay from the previous slide.
      if (this.checkOverlay !== 'none') this.clearCheckOverlay();
      this.currentIndex += step;
      this.updateProjectedImage();
      this.slideLockUntil = Date.now() + VisorComponent.SLIDE_LOCK_MS;
      this.checkPhotoTrigger();
    } else if (this.images.length > 0) {
      this.finishActiveItem();
    }
  }

  prevImage(): void {
    if (this.currentIndex < 0) return;
    if (this.capturingPhoto && this.captureMode === 'check') return;
    // Going backwards is a review pass: no 5 s read-lock and no
    // capture/check retriggering. The operator is scrubbing back to
    // inspect something. Skip past _foto / _check slides on the way
    // -- when they go forward again, those same slides fire normally
    // and we re-capture / re-validate as if it were the first time.

    if (this.currentIndex > 0) {
      if (this.checkOverlay !== 'none') this.clearCheckOverlay();
      let target = this.currentIndex - 1;
      while (target > 0 && this.isCaptureSlide(target)) {
        target--;
      }
      this.currentIndex = target;
      this.updateProjectedImage();
    }
  }

  private isCaptureSlide(index: number): boolean {
    const img = this.images[index];
    if (!img) return false;
    const url: string = img.url || img.src || '';
    const filename = (url.split('/').pop() || '').toLowerCase();
    return filename.includes('_foto')
      || filename.includes('_photo')
      || filename.includes('_check');
  }

  updateProjectedImage(): void {
    if (this.isSupervisor) {
      const mesaId = this.mesaIdForPairing || this.mesaState?.id;
      if (!mesaId) return;
      this.http.post(`/api/mesas/${mesaId}/set_index/`, { index: this.currentIndex }, { headers: this.getUserAuthHeaders() })
        .subscribe({
          next: () => this.cdr.detectChanges(),
          error: (err) => console.error('[Visor] Error syncing index (supervisor):', err)
        });
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

  // =========================================================================
  // PHOTO CAPTURE
  // =========================================================================
  private checkPhotoTrigger(): void {
    if (this.isSupervisor || this.capturingPhoto) return;
    if (this.currentIndex < 0 || !this.images.length) return;

    const currentImage = this.images[this.currentIndex];
    if (!currentImage) return;

    const imageUrl: string = currentImage.url || currentImage.src || '';
    const filename = (imageUrl.split('/').pop() || '').toLowerCase();

    // '_check' triggers capture + color validation (blocks advance on
    // failure). '_foto' / '_photo' only capture evidence, no block.
    if (filename.includes('_check')) {
      this.triggerPhotoCapture('check');
    } else if (filename.includes('_foto') || filename.includes('_photo')) {
      this.triggerPhotoCapture('foto');
    }
  }

  triggerPhotoCapture(mode: 'foto' | 'check' = 'foto'): void {
    if (this.capturingPhoto || !this.activeItem) return;
    this.capturingPhoto = true;
    this.captureMode = mode;
    this.captureStatus = 'capturing';
    this.cdr.detectChanges();

    // Wait ~500 ms for the projector to actually show the current
    // slide (the operator may have just navigated here) before asking
    // the camera to capture, otherwise we risk photographing the
    // previous slide.
    setTimeout(() => this.attemptCapture(1), 500);
  }

  private attemptCapture(attempt: number): void {
    // From the 2nd attempt onwards we know the camera didn't answer
    // the first time, so the operator deserves the 'waiting' slide.
    if (attempt > 1 && this.captureMode === 'check' && !this.cameraRetrying) {
      this.cameraRetrying = true;
      this.cdr.detectChanges();
    }
    this.http.post(
      `${this.captureServiceUrl}/capture`, {},
      { responseType: 'blob' }
    ).subscribe({
      next: (blob: Blob) => {
        this.cameraRetrying = false;
        this.captureStatus = 'uploading';
        // A successful capture means the service is alive right now.
        this.captureServiceOnline = true;
        this.cdr.detectChanges();
        this.compressAndUpload(blob);
      },
      error: (err) => {
        console.warn(
          `[Visor] Camera capture failed (attempt ${attempt}/${VisorComponent.CAPTURE_MAX_ATTEMPTS}):`,
          err
        );
        if (attempt < VisorComponent.CAPTURE_MAX_ATTEMPTS) {
          setTimeout(
            () => this.attemptCapture(attempt + 1),
            VisorComponent.CAPTURE_RETRY_MS
          );
          return;
        }
        // Final failure: surface it.
        console.error('[Visor] Camera capture exhausted retries.');
        this.cameraRetrying = false;
        this.captureStatus = 'error';
        this.capturingPhoto = false;
        this.captureServiceOnline = false;
        this.cdr.detectChanges();
        if (this.captureMode === 'check') {
          // No photo means we cannot validate -- block the operator
          // with a 'camera unavailable' message instead of letting
          // them silently skip a verification step. Mirror it on the
          // backend so the supervisor visor sees the same block.
          this.applyCheckResult(false, 'no_camera');
          this.notifyNoCamera();
        }
        setTimeout(() => {
          this.captureStatus = 'idle';
          this.cdr.detectChanges();
        }, 3000);
      }
    });
  }

  private compressAndUpload(blob: Blob): void {
    const MAX_SIZE = 700 * 1024; // 700KB - safe margin under Railway's ~850KB limit

    if (blob.size <= MAX_SIZE) {
      this.uploadPhoto(blob);
      return;
    }

    console.log(`[Visor] Compressing photo: ${(blob.size / 1024).toFixed(0)}KB → target <700KB`);
    const img = new Image();
    const url = URL.createObjectURL(blob);

    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');

      // Scale down if very large (keep max 2048px on longest side)
      let { width, height } = img;
      const MAX_DIM = 2048;
      if (width > MAX_DIM || height > MAX_DIM) {
        const scale = MAX_DIM / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, width, height);

      // Try decreasing quality until under limit
      let quality = 0.7;
      const tryCompress = () => {
        canvas.toBlob((result) => {
          if (!result) {
            console.warn('[Visor] Compression failed, uploading original');
            this.uploadPhoto(blob);
            return;
          }
          if (result.size > MAX_SIZE && quality > 0.2) {
            quality -= 0.1;
            tryCompress();
          } else {
            console.log(`[Visor] Compressed: ${(blob.size / 1024).toFixed(0)}KB → ${(result.size / 1024).toFixed(0)}KB (q=${quality.toFixed(1)})`);
            this.uploadPhoto(result);
          }
        }, 'image/jpeg', quality);
      };
      tryCompress();
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      console.warn('[Visor] Could not load image for compression, uploading original');
      this.uploadPhoto(blob);
    };
    img.src = url;
  }

  private uploadPhoto(blob: Blob): void {
    const mode = this.captureMode;
    const formData = new FormData();
    formData.append('foto', blob, 'capture.jpg');
    formData.append('modulo_id', String(this.activeItem.modulo));
    formData.append('fase', this.activeItem.fase);
    formData.append('paso', String(this.currentIndex));
    if (mode === 'check') {
      formData.append('check', 'true');
    }

    const currentImage = this.images[this.currentIndex];
    if (currentImage?.id) {
      formData.append('imagen_id', String(currentImage.id));
    }

    // Supervisor mode (/visor/:id) always uses user Token auth.
    // Device mode uses Bearer device token.
    let headers: HttpHeaders;
    if (this.isSupervisor) {
      headers = this.getUserAuthHeaders();
      const mesaId = this.mesaIdForPairing || this.mesaState?.id;
      if (mesaId) {
        formData.append('mesa_id', String(mesaId));
      }
    } else if (this.deviceToken) {
      headers = this.getAuthHeaders();
    } else {
      // Fallback: try user Token auth if no device token
      headers = this.getUserAuthHeaders();
      const mesaId = this.mesaState?.id;
      if (mesaId) {
        formData.append('mesa_id', String(mesaId));
      }
    }

    this.http.post<any>(
      `${this.apiUrl}upload_foto/`, formData,
      { headers }
    ).subscribe({
      next: (res: any) => {
        this.captureStatus = 'done';
        this.capturingPhoto = false;
        if (mode === 'check') {
          const detail = res?.check_detail;
          this.applyCheckResult(res?.check_result, 'check', detail);
          // In debug mode the backend renders the annotated overlay
          // in memory and ships the bytes back as base64 (it does NOT
          // persist them on Railway). Mirror them to Drive via the
          // local capture service -- Drive is the only place these
          // annotated images live.
          const hasB64 = !!res?.annotated_jpeg_b64;
          const hasName = !!res?.annotated_filename;
          if (this.isSupervisor) {
            this.checkMirrorStatus = 'modo supervisor (no se hace mirror)';
          } else if (!hasB64 || !hasName) {
            this.checkMirrorStatus = `sin datos (b64=${hasB64} name=${hasName})`;
          } else {
            this.checkMirrorStatus = `enviando (${Math.round(res.annotated_jpeg_b64.length / 1024)} KB)…`;
            this.mirrorAnnotatedToDrive(
              res.annotated_jpeg_b64,
              res.annotated_filename,
            );
          }
        }
        this.cdr.detectChanges();
        setTimeout(() => {
          this.captureStatus = 'idle';
          this.cdr.detectChanges();
        }, 2000);
      },
      error: (err) => {
        console.error('[Visor] Photo upload failed:', err);
        this.captureStatus = 'error';
        this.capturingPhoto = false;
        if (mode === 'check') {
          // Treat upload failure on a check step as a failed check: we
          // don't want the operator to blow past a missing validation.
          this.applyCheckResult(false);
        }
        this.cdr.detectChanges();
        setTimeout(() => {
          this.captureStatus = 'idle';
          this.cdr.detectChanges();
        }, 3000);
      }
    });
  }

  private applyCheckResult(
    valid: boolean | null | undefined,
    reason: 'check' | 'no_camera' = 'check',
    detail?: any,
  ): void {
    if (this.checkSuccessTimer) {
      clearTimeout(this.checkSuccessTimer);
      this.checkSuccessTimer = null;
    }
    if (valid === true) {
      // Stays visible until the operator navigates away.
      this.checkOverlay = 'success';
      this.checkBlock = false;
    } else {
      this.checkOverlay = reason === 'no_camera' ? 'no_camera' : 'error';
      this.checkBlock = true;
    }
    if (detail && (detail.expected_counts || detail.cards_per_color || detail.missing)) {
      this.checkDebugInfo = {
        expected_counts: detail.expected_counts,
        cards_per_color: detail.cards_per_color,
        missing: detail.missing,
      };
    } else {
      this.checkDebugInfo = null;
    }
  }

  // Template helpers for the debug panel.
  formatCountMap(map: Record<string, number> | undefined | null): string {
    if (!map) return '';
    return Object.entries(map)
      .map(([color, n]) => `${color}×${n}`)
      .join(', ');
  }

  objectKeys(obj: object | undefined | null): string[] {
    return obj ? Object.keys(obj) : [];
  }

  private mirrorAnnotatedToDrive(jpegB64: string, filename: string): void {
    let blob: Blob;
    try {
      const binary = atob(jpegB64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      blob = new Blob([bytes], { type: 'image/jpeg' });
    } catch (err: any) {
      this.checkMirrorStatus = `decode error: ${err?.message || err}`;
      this.cdr.detectChanges();
      return;
    }

    const headers = new HttpHeaders({
      'Content-Type': 'image/jpeg',
      'X-Filename': filename,
    });
    this.http.post(
      `${this.captureServiceUrl}/save_debug_image`,
      blob,
      { headers, responseType: 'json' as const }
    ).subscribe({
      next: () => {
        this.checkMirrorStatus = `OK (${filename})`;
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        const code = err?.status ?? '?';
        const msg = err?.statusText || err?.message || 'desconocido';
        this.checkMirrorStatus = `error ${code}: ${msg}`;
        this.cdr.detectChanges();
      },
    });
  }

  startStatePolling(): void {
    this.statePollSub?.unsubscribe();
    this.itemPollSub?.unsubscribe();
    this.statePollSub = interval(1000).pipe(
      startWith(0),
      exhaustMap(() => {
        if (this.isSupervisor) {
          const id = this.mesaIdForPairing || this.mesaState?.id;
          if (!id) return of(null);
          return this.http.get<MesaState>(`/api/mesas/${id}/`, { headers: this.getUserAuthHeaders() }).pipe(
            catchError(err => {
              if (err.status === 401) {
                this.errorMessage = 'Sesion expirada. Vuelve a iniciar sesion en el dashboard.';
                this.mode = 'ERROR';
                this.cdr.detectChanges();
              }
              return of(null);
            })
          );
        }

        const mesaId = this.mesaIdForPairing || this.mesaState?.id;
        const params: Record<string, string> = {};
        if (mesaId) {
          params['mesa_id'] = mesaId.toString();
        }
        return this.http.get<MesaState>(`${this.apiUrl}state/`, { headers: this.getAuthHeaders(), params }).pipe(
          catchError(err => {
            if (err.status === 401) this.handleUnauthorized('StatePolling');
            return of(null);
          })
        );
      })
    ).subscribe((state: MesaState | null) => {
      if (!state) return;
      this.mesaState = state;
      if (state.nombre) {
        this.titleService.setTitle(`Visor - ${state.nombre}`);
      }
      if (typeof state.current_image_index === 'number') {
        this.currentIndex = state.current_image_index;
      }
      // In supervisor mode the camera lives on the mini-PC, not on
      // localhost, so we mirror what the mini-PC last reported.
      if (this.isSupervisor) {
        if (state.capture_service_online !== undefined) {
          this.captureServiceOnline = state.capture_service_online ?? null;
        }
        const sharp = state.camera_sharpness;
        if (sharp === 'ok' || sharp === 'warning' || sharp === 'blurry' || sharp === 'unknown') {
          this.cameraSharpness = sharp;
        }
      }

      // Mesa-wide check overlay (success/error/no_camera) is the
      // source of truth for both the player and the supervisor visor:
      // whoever runs the _check sets it on the backend and both views
      // pick it up on the next poll. We skip while a clear request is
      // in flight to avoid briefly re-painting the state we just told
      // the backend to drop.
      if (!this.clearingOverlay) {
        const remote: 'none' | 'success' | 'error' | 'no_camera' =
          (state.check_overlay as any) ?? 'none';
        if (remote !== this.checkOverlay) {
          this.checkOverlay = remote;
          this.checkBlock = remote === 'error' || remote === 'no_camera';
          if (remote === 'none' && this.checkSuccessTimer) {
            clearTimeout(this.checkSuccessTimer);
            this.checkSuccessTimer = null;
          }
        }
      }
      this.cdr.detectChanges();
    });

    if (!this.isSupervisor && environment.enableDeviceSSE) {
      this.connectToSSE();
    }

    const itemPollMs = 2000;
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
      // New module/phase started: restart local counter (UI shows currentIndex + 1 => starts at 1).
      if (this.currentIndex >= 0) {
        this.currentIndex = 0;
      }
      if (Array.isArray(item.images)) {
        this.images = item.images;
        if (this.currentIndex >= 0 && this.currentIndex >= this.images.length) {
          this.currentIndex = 0;
        }
        this.loadingImages = false;
        this.cdr.detectChanges();
        this.checkPhotoTrigger();
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
        // Keep calibration mode (-1/-2) while images are refreshed.
        if (this.currentIndex >= 0) {
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

  startHeartbeat(): void {
    this.heartbeatSub = interval(30000).pipe(
      switchMap(() => {
        const mesaId = this.mesaIdForPairing || this.mesaState?.id;
        const payload: Record<string, any> = mesaId ? { mesa_id: mesaId } : {};
        // Pipe the local capture service state to the backend so the
        // dashboard can surface 'camera offline' / 'camera dirty'
        // warnings on the mesa card.
        if (this.captureServiceOnline !== null) {
          payload['capture_service_online'] = this.captureServiceOnline;
        }
        // Always report the current value, even 'unknown', so a
        // mini-PC that swapped out (or removed) its camera overwrites
        // the stale 'blurry' / 'warning' the backend may have kept
        // from a previous deployment of this rol.
        if (this.cameraSharpness) {
          payload['camera_sharpness'] = this.cameraSharpness;
        }
        return this.http.post(`${this.apiUrl}heartbeat/`, payload, { headers: this.getAuthHeaders() });
      }),
      catchError((err) => {
        if (err.status === 401) this.handleUnauthorized('Heartbeat');
        return of(null);
      })
    ).subscribe();
  }

  handleUnauthorized(source: string = 'Unknown'): void {
    if (this.isSupervisor) {
      this.errorMessage = 'Sesion expirada. Vuelve a iniciar sesion en el dashboard.';
      this.mode = 'ERROR';
      this.cdr.detectChanges();
      return;
    }

    // Guard against re-entry: while we're already falling back to
    // pairing mode, later 401s from in-flight polls must NOT trigger
    // another requestPairingCode or the visor keeps minting new codes
    // every couple of seconds.
    if (this.mode === 'LOADING' || this.mode === 'PAIRING') {
      return;
    }

    console.warn(`[Visor] Unauthorized access detected from ${source}.`);

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    localStorage.removeItem(this.getTokenKey());
    this.deviceToken = null;
    this.mesaState = null;
    this.statePollSub?.unsubscribe();
    this.itemPollSub?.unsubscribe();
    this.heartbeatSub?.unsubscribe();
    this.pairingPollSub?.unsubscribe();
    this.requestPairingCode();
  }
}
