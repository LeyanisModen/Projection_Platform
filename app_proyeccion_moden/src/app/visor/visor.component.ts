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
  private static readonly CALIBRATION_GRID_INDEX = -1;
  private static readonly CALIBRATION_GRID_WITH_X_INDEX = -2;
  private static readonly COVERAGE_BACKGROUND_INDEX = -3;
  private static readonly BED_15_INDEX = -4;
  private static readonly BED_20_INDEX = -5;
  // State
  mode: 'LOADING' | 'PAIRING' | 'PROJECTION' | 'ERROR' = 'LOADING';
  pairingCode: string = '';
  // Hand-bumped on every push that touches the visor flow. The pairing
  // screen prints it small at the bottom so we can confirm from
  // AnyDesk whether the kiosk is actually running the latest bundle
  // or a cached one. F12 is blocked in kiosk; this is the simplest
  // version probe we can offer the operator on screen.
  readonly buildTag = '2026-08-24_projection-settle';
  // Surfaces what's happening inside recoverTokenOrPair on the
  // LOADING screen so we can diagnose from AnyDesk without DevTools.
  loadingMessage: string = 'Conectando…';
  recoveryDebug: string | null = null;
  errorMessage: string = '';
  deviceToken: string | null = null;
  private diskTokenSyncedFor: string | null = null;
  private diskTokenPersistInFlightFor: string | null = null;
  private diskTokenPersistGeneration = 0;
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
  private captureTargetIndex: number | null = null;
  private captureTargetItemId: number | string | null = null;
  private captureProjectionUrl: string | null = null;
  private lastRenderedProjectionUrl: string | null = null;
  private captureStartTimer: any = null;
  private captureLoadTimeoutTimer: any = null;
  private captureScheduleGeneration = 0;
  private captureStartScheduled = false;
  captureStatus: 'idle' | 'capturing' | 'uploading' | 'done' | 'error' = 'idle';
  captureErrorMessage: string | null = null;

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
  private static readonly PROJECTOR_SETTLE_AFTER_RENDER_MS = 1000;
  private static readonly PROJECTION_LOAD_TIMEOUT_MS = 12000;
  // True only from the second capture attempt onwards -- used to
  // decide whether to project the 'waiting for camera' slide. On the
  // first attempt we keep the original _check.jpg blueprint on screen
  // so the operator doesn't see a flash of 'waiting' every time the
  // camera is healthy.
  private cameraRetrying = false;

  // 5-second lock between slides so the operator reads the caption before
  // moving on (many consecutive slides only change the title text).
  private static readonly SLIDE_LOCK_MS = 5000;
  // After a local next/prev/calibration toggle we briefly treat the local
  // index as authoritative so a poll already in flight can't paint the
  // previous slide back on screen for a split second.
  private static readonly INDEX_SYNC_GRACE_MS = 1500;
  private slideLockUntil = 0;
  slideLockRemainingMs = 0;
  readonly slideLockDots = [0, 1, 2, 3, 4];
  private slideLockTimer: any = null;
  // A single 401 is not enough evidence that the token is dead. On
  // cold boots or backend rollouts we may see a transient auth miss;
  // only after repeated 401s do we discard the persisted token and
  // fall back to pairing.
  private static readonly AUTH_REVALIDATION_MAX_401 = 3;
  private static readonly AUTH_REVALIDATION_RETRY_MS = 5000;
  private authRecoveryTimer: any = null;
  private authRecovery401Count = 0;
  private authRecoverySource: string | null = null;
  private pendingIndexSync: { index: number; expiresAt: number } | null = null;
  browserCloseStatus: 'confirm' | 'closing' | 'error' | null = null;
  private browserCloseConfirmUntil = 0;
  private browserCloseStatusTimer: any = null;

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

    const browserToken = localStorage.getItem(this.getTokenKey());
    this.deviceToken = browserToken;

    if (this.mesaIdForPairing) {
      this.recoveryDebug = `Modo supervisor (mesa=${this.mesaIdForPairing}).`;
      this.loadMesaDirectly(this.mesaIdForPairing);
    } else {
      // Always prefer the disk token kept by the local capture service.
      // Chrome localStorage can survive with an old token and must never
      // overwrite C:\moden\capture_service\device_token.txt on boot.
      this.recoveryDebug = browserToken
        ? `Token en Chrome (${browserToken.slice(0, 8)}...). Comprobando token local del mini-PC.`
        : `Chrome sin token. Intentando recuperar del capture service.`;
      this.cdr.detectChanges();
      this.recoverTokenOrPair(1, browserToken);
    }

    // The local capture service only exists on the mini-PC. In
    // supervisor mode (visor opened from another computer) the camera
    // health is read from the mesa state, which the mini-PC reports to
    // the backend via heartbeat — see startStatePolling().
    if (!this.isSupervisor) {
      this.startCaptureHealthPolling();
    }
  }

  // Ask the local capture service for a previously persisted pairing
  // token. If it has one, restore it; otherwise fall back to the
  // pairing flow. Used when localStorage is empty (cleared Chrome
  // profile, Storage Sense wiped site data, etc.) -- the token is
  // physical on disk in C:\moden\capture_service\device_token.txt and
  // shouldn't need to be re-paired manually.
  //
  // Retries are critical here because start-player.bat launches Chrome
  // and the Python service in parallel. Chrome opens the page before
  // OpenCV has finished importing and the HTTP server has bound 5555.
  // Without the retries the first GET fails connection-refused and we
  // fall to the pairing screen on every cold boot.
  private static readonly TOKEN_RECOVERY_MAX_ATTEMPTS = 15;
  private static readonly TOKEN_RECOVERY_RETRY_MS = 2000;

  private recoverTokenOrPair(attempt: number = 1, browserFallbackToken: string | null = null): void {
    this.loadingMessage = 'Recuperando sesion guardada...';
    this.recoveryDebug = `Intento ${attempt}/${VisorComponent.TOKEN_RECOVERY_MAX_ATTEMPTS} -> GET ${this.captureServiceUrl}/device_token`;
    this.cdr.detectChanges();

    let httpError: string | null = null;
    this.http.get<{ device_token: string }>(
      `${this.captureServiceUrl}/device_token`
    ).pipe(catchError((err: any) => {
      const status = err?.status ?? '?';
      const msg = err?.statusText || err?.message || 'unknown';
      httpError = `${status} ${msg}`;
      return of(null);
    })).subscribe((res) => {
      const recovered = (res?.device_token || '').trim();
      if (recovered) {
        this.recoveryDebug = `OK token local=${recovered.slice(0, 8)}... (intento ${attempt})`;
        this.cdr.detectChanges();
        this.deviceToken = recovered;
        this.diskTokenSyncedFor = recovered;
        localStorage.setItem(this.getTokenKey(), recovered);
        // tiny delay so the success message is readable
        setTimeout(() => this.enterProjectionMode(), 400);
        return;
      }
      const reason = httpError
        ? `error HTTP ${httpError}`
        : (res === null ? 'sin conexion' : 'token vacio');
      if (attempt < VisorComponent.TOKEN_RECOVERY_MAX_ATTEMPTS) {
        this.recoveryDebug = `Intento ${attempt}: ${reason}. Reintentando...`;
        this.cdr.detectChanges();
        setTimeout(
          () => this.recoverTokenOrPair(attempt + 1, browserFallbackToken),
          VisorComponent.TOKEN_RECOVERY_RETRY_MS,
        );
        return;
      }
      const fallback = (browserFallbackToken || '').trim();
      if (fallback) {
        this.recoveryDebug = `Sin token local tras ${VisorComponent.TOKEN_RECOVERY_MAX_ATTEMPTS} intentos (${reason}). Probando token de Chrome sin escribirlo en disco.`;
        this.cdr.detectChanges();
        this.deviceToken = fallback;
        localStorage.setItem(this.getTokenKey(), fallback);
        setTimeout(() => this.enterProjectionMode(), 400);
        return;
      }
      this.recoveryDebug = `Agotados ${VisorComponent.TOKEN_RECOVERY_MAX_ATTEMPTS} intentos (${reason}). Pidiendo vinculacion.`;
      this.cdr.detectChanges();
      setTimeout(() => this.requestPairingCode(), 1500);
    });
  }

  // Mirror the pairing token to the local capture service so it
  // survives a Chrome profile reset. Called whenever a fresh token is
  // obtained (pairing flow) and after the backend accepts a browser
  // fallback token. An empty string clears the
  // file (used after a 401 so the next cold boot doesn't restore an
  // invalid token).
  //
  // We retry: just like recoverTokenOrPair, the capture service may
  // still be booting when the request goes out, and silently dropping
  // the token from disk is exactly the failure mode that pushed the
  // operator into endless re-pairing loops.
  private static readonly TOKEN_PERSIST_MAX_ATTEMPTS = 15;
  private static readonly TOKEN_PERSIST_RETRY_MS = 2000;

  private persistTokenLocally(token: string, attempt: number = 1, generation?: number): void {
    if (this.isSupervisor) return;
    const marker = token || '__clear__';
    if (attempt === 1) {
      if (this.diskTokenPersistInFlightFor === marker) return;
      this.diskTokenPersistInFlightFor = marker;
      generation = ++this.diskTokenPersistGeneration;
    } else if (
      generation !== this.diskTokenPersistGeneration ||
      this.diskTokenPersistInFlightFor !== marker
    ) {
      return;
    }

    const requestGeneration = generation ?? this.diskTokenPersistGeneration;
    this.http.post(
      `${this.captureServiceUrl}/device_token`,
      token,
      {
        headers: new HttpHeaders({ 'Content-Type': 'text/plain' }),
        responseType: 'text' as const,
      }
    ).subscribe({
      next: () => {
        if (requestGeneration !== this.diskTokenPersistGeneration) return;
        const op = token ? 'persisted' : 'cleared';
        this.diskTokenSyncedFor = token || null;
        this.diskTokenPersistInFlightFor = null;
        console.log(`[Visor] Pairing token ${op} on capture service (attempt ${attempt})`);
      },
      error: (err) => {
        if (requestGeneration !== this.diskTokenPersistGeneration) return;
        console.warn(
          `[Visor] persist token attempt ${attempt} failed:`,
          err?.status, err?.message || err?.statusText,
        );
        if (attempt < VisorComponent.TOKEN_PERSIST_MAX_ATTEMPTS) {
          setTimeout(
            () => this.persistTokenLocally(token, attempt + 1, requestGeneration),
            VisorComponent.TOKEN_PERSIST_RETRY_MS,
          );
        } else {
          this.diskTokenPersistInFlightFor = null;
          console.error('[Visor] persist token exhausted retries; disk copy may be stale');
        }
      },
    });
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
        this.captureServiceOnline = stats?.camera_available === false ? false : true;
        const status = stats?.sharpness_status;
        if (status === 'ok' || status === 'warning' || status === 'blurry' || status === 'unknown') {
          this.cameraSharpness = status;
        }
        if (stats?.camera_available === false) {
          this.cameraSharpness = 'unknown';
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
          this.pendingIndexSync = null;
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
    this.clearAuthRecoveryTimer();
    this.clearSlideLockIndicator();
    this.clearBrowserCloseStatus();
    this.clearCaptureSchedule();
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
    let pollCount = 0;
    this.pairingPollSub = interval(3000).pipe(
      switchMap(() => this.http.get<StatusResponse>(`${this.apiUrl}status/?code=${this.pairingCode}`).pipe(
        catchError((err: any) => {
          const code = err?.status ?? '?';
          this.recoveryDebug = `Poll ${++pollCount}: ERROR HTTP ${code} ${err?.statusText || err?.message || ''}`;
          this.cdr.detectChanges();
          return of({ status: 'WAITING' } as StatusResponse);
        })
      )),
    ).subscribe({
      next: (res) => {
        pollCount++;
        const tokenPreview = res.device_token ? `${res.device_token.slice(0, 8)}…` : 'sin token';
        this.recoveryDebug = `Poll ${pollCount}: status=${res.status} ${tokenPreview}`;
        this.cdr.detectChanges();
        if (res.status === 'PAIRED' && res.device_token) {
          this.deviceToken = res.device_token;
          localStorage.setItem(this.getTokenKey(), res.device_token);
          // Mirror the token to the capture service so it survives
          // browser storage wipes.
          this.persistTokenLocally(res.device_token);
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
      this.clearAuthRecoveryTimer();
      this.authRecovery401Count = 0;
      this.authRecoverySource = null;
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
          const syncedIndex = this.reconcileRemoteIndex(payload.data.current_image_index);
          if (this.mesaState) {
            this.mesaState = {
              ...this.mesaState,
              calibration_json: payload.data.corners ? { corners: payload.data.corners } : this.mesaState.calibration_json,
              mapper_enabled: payload.data.mapper_enabled,
              current_image_index: syncedIndex ?? this.mesaState.current_image_index
            };
          } else {
            this.mesaState = payload.data as any;
          }

          const previousIndex = this.currentIndex;
          if (syncedIndex !== null && syncedIndex !== this.currentIndex) {
            this.currentIndex = syncedIndex;
          }
          this.cdr.detectChanges();
          if (!this.isSupervisor && syncedIndex !== null && syncedIndex !== previousIndex) {
            this.checkPhotoTrigger();
          }
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
    if (this.currentIndex === VisorComponent.CALIBRATION_GRID_INDEX) return `${this.assetBase}assets/calibration_grid.jpg`;
    if (this.currentIndex === VisorComponent.CALIBRATION_GRID_WITH_X_INDEX) return `${this.assetBase}assets/calibration_grid_with_x.jpg`;
    if (this.currentIndex === VisorComponent.COVERAGE_BACKGROUND_INDEX) return `${this.assetBase}assets/projection_coverage_background.jpg`;
    if (this.currentIndex === VisorComponent.BED_15_INDEX) return `${this.assetBase}assets/projection_bed_15.jpg`;
    if (this.currentIndex === VisorComponent.BED_20_INDEX) return `${this.assetBase}assets/projection_bed_20.jpg`;
    if (this.isWarningSlideActive) return `${this.assetBase}assets/warning_projection.webp`;

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
    return this.isSupervisor && (
      this.currentIndex === VisorComponent.CALIBRATION_GRID_INDEX
      || this.currentIndex === VisorComponent.CALIBRATION_GRID_WITH_X_INDEX
    );
  }

  get isCoverageBackgroundActive(): boolean {
    return this.currentIndex === VisorComponent.COVERAGE_BACKGROUND_INDEX;
  }

  get isBed15Active(): boolean {
    return this.currentIndex === VisorComponent.BED_15_INDEX;
  }

  get isBed20Active(): boolean {
    return this.currentIndex === VisorComponent.BED_20_INDEX;
  }

  get isWarningSlideActive(): boolean {
    return this.currentIndex >= 0 && this.isWarningSlide(this.currentIndex);
  }

  get showCaptureLockIndicator(): boolean {
    return this.captureMode === 'check'
      && (this.capturingPhoto || this.captureStatus === 'capturing' || this.captureStatus === 'uploading');
  }

  get captureLockLabel(): string {
    if (this.cameraRetrying) return 'Esperando cámara';
    if (this.captureStatus === 'uploading') return 'Comprobando colores';
    return 'Accediendo a cámara';
  }

  get calibrationShortcutHint(): string {
    return this.isCalibrationActive ? 'Para cerrar calibración' : 'Para calibrar';
  }

  get coverageShortcutHint(): string {
    return this.isCoverageBackgroundActive ? 'Para quitar fondo de cobertura' : 'Para mostrar fondo de cobertura';
  }

  get bed15ShortcutHint(): string {
    return this.isBed15Active ? 'Para quitar cama de 15' : 'Para mostrar cama de 15';
  }

  get bed20ShortcutHint(): string {
    return this.isBed20Active ? 'Para quitar cama de 20' : 'Para mostrar cama de 20';
  }

  get showSlideLockIndicator(): boolean {
    return this.shouldApplySlideLock() && this.slideLockRemainingMs > 0;
  }

  get slideLockDotsRemaining(): number {
    return Math.ceil(this.slideLockRemainingMs / 1000);
  }

  private shouldApplySlideLock(): boolean {
    return !this.isSupervisor;
  }

  private updateSlideLockIndicator(): void {
    const remaining = Math.max(0, this.slideLockUntil - Date.now());
    this.slideLockRemainingMs = remaining;

    if (remaining <= 0) {
      this.clearSlideLockIndicator();
      return;
    }

    this.cdr.detectChanges();
  }

  private startSlideLockIndicator(): void {
    this.clearSlideLockIndicator();
    this.updateSlideLockIndicator();
    this.slideLockTimer = setInterval(() => this.updateSlideLockIndicator(), 200);
  }

  private clearSlideLockIndicator(): void {
    if (this.slideLockTimer) {
      clearInterval(this.slideLockTimer);
      this.slideLockTimer = null;
    }
    if (this.slideLockRemainingMs !== 0) {
      this.slideLockRemainingMs = 0;
      this.cdr.detectChanges();
    }
  }

  private async forceAppReload(): Promise<void> {
    if (!this.isBrowser) return;

    try {
      if ('caches' in window) {
        const cacheKeys = await caches.keys();
        await Promise.all(cacheKeys.map((key) => caches.delete(key)));
      }

      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((reg) => reg.unregister()));
      }
    } catch (err) {
      console.warn('[Visor] Force reload cleanup failed:', err);
    }

    const url = new URL(window.location.href);
    url.searchParams.set('_reload', Date.now().toString());
    window.location.replace(url.toString());
  }

  private markPendingIndexSync(index: number): void {
    this.pendingIndexSync = {
      index,
      expiresAt: Date.now() + VisorComponent.INDEX_SYNC_GRACE_MS,
    };
    if (this.mesaState) {
      this.mesaState = {
        ...this.mesaState,
        current_image_index: index,
      };
    }
  }

  private reconcileRemoteIndex(remoteIndex: unknown): number | null {
    if (typeof remoteIndex !== 'number') return null;

    const guard = this.pendingIndexSync;
    if (!guard) return remoteIndex;

    if (remoteIndex === guard.index) {
      this.pendingIndexSync = null;
      return remoteIndex;
    }

    if (Date.now() <= guard.expiresAt) {
      return this.currentIndex;
    }

    this.pendingIndexSync = null;
    return remoteIndex;
  }

  @HostListener('window:keydown', ['$event'])
  handleKeyboardEvent(event: KeyboardEvent) {
    if (this.mode !== 'PROJECTION') return;
    const key = event.key.toLowerCase();

    if (key === 'r') {
      event.preventDefault();
      this.forceAppReload();
      return;
    }
    if (key === 'q') {
      event.preventDefault();
      this.requestBrowserClose();
      return;
    }

    // A failed color check blocks navigation until the operator
    // acknowledges it with space. SPACE clears the red overlay AND
    // advances to the next slide (the visual-revision step). The
    // operator should not have to press two keys to recover.
    // Calibration toggles still work.
    if (this.checkBlock) {
      if (key === ' ' || key === 'spacebar' || key === 'space') {
        event.preventDefault();
        this.clearCheckOverlay();
        // Bypass the 5 s read-lock: the operator already waited
        // blocked on the failed check.
        this.slideLockUntil = 0;
        this.nextImage();
        return;
      }
      if (key === 'arrowright' || key === 'arrowleft') {
        return;
      }
    }

    if (key === 'c') {
      this.toggleCalibration(VisorComponent.CALIBRATION_GRID_INDEX);
    } else if (key === 'g') {
      this.toggleCalibration(VisorComponent.CALIBRATION_GRID_WITH_X_INDEX);
    } else if (key === 'b') {
      this.toggleCoverageBackground();
    } else if (key === 'v') {
      this.toggleAuxiliaryProjection(VisorComponent.BED_15_INDEX);
    } else if (key === 'w') {
      this.toggleAuxiliaryProjection(VisorComponent.BED_20_INDEX);
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
    }
  }

  private requestBrowserClose(): void {
    const now = Date.now();
    if (now < this.browserCloseConfirmUntil) {
      this.closeBrowserFromMiniPc();
      return;
    }

    this.browserCloseConfirmUntil = now + 3000;
    this.browserCloseStatus = 'confirm';
    this.cdr.detectChanges();
    this.scheduleBrowserCloseStatusClear(3000);
  }

  private closeBrowserFromMiniPc(): void {
    this.browserCloseConfirmUntil = 0;
    this.browserCloseStatus = 'closing';
    this.cdr.detectChanges();

    const headers = new HttpHeaders({ 'X-Moden-Action': 'close-browser' });
    this.http.post(
      `${this.captureServiceUrl}/close_browser`,
      {},
      { headers },
    ).subscribe({
      next: () => {
        // The local service closes Chrome after sending the response.
        this.browserCloseStatus = 'closing';
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('[Visor] close_browser failed:', err);
        this.browserCloseStatus = 'error';
        this.cdr.detectChanges();
        this.scheduleBrowserCloseStatusClear(4000);
      },
    });
  }

  private scheduleBrowserCloseStatusClear(delayMs: number): void {
    this.clearBrowserCloseStatusTimer();
    this.browserCloseStatusTimer = setTimeout(() => {
      if (this.browserCloseStatus === 'closing') return;
      this.browserCloseStatus = null;
      this.browserCloseConfirmUntil = 0;
      this.cdr.detectChanges();
    }, delayMs);
  }

  private clearBrowserCloseStatusTimer(): void {
    if (this.browserCloseStatusTimer) {
      clearTimeout(this.browserCloseStatusTimer);
      this.browserCloseStatusTimer = null;
    }
  }

  private clearBrowserCloseStatus(): void {
    this.clearBrowserCloseStatusTimer();
    this.browserCloseStatus = null;
    this.browserCloseConfirmUntil = 0;
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
    this.slideLockUntil = 0;
    this.clearSlideLockIndicator();
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

  toggleCoverageBackground(): void {
    this.toggleAuxiliaryProjection(VisorComponent.COVERAGE_BACKGROUND_INDEX);
  }

  private toggleAuxiliaryProjection(targetIndex: number): void {
    this.slideLockUntil = 0;
    this.clearSlideLockIndicator();
    if (this.currentIndex === targetIndex) {
      this.currentIndex = this.previousIndex;
    } else {
      if (this.currentIndex >= 0) {
        this.previousIndex = this.currentIndex;
      }
      this.currentIndex = targetIndex;
    }
    this.updateProjectedImage();
  }

  nextImage(): void {
    if (this.currentIndex < 0) return;
    const continuingAfterPhotoError = this.hasSimplePhotoCaptureError();
    if (continuingAfterPhotoError) {
      this.clearSimplePhotoCaptureError();
    }
    if (!continuingAfterPhotoError && this.shouldApplySlideLock() && Date.now() < this.slideLockUntil) {
      this.updateSlideLockIndicator();
      return;
    }
    // While a _check capture is in flight, freeze the navigation: the
    // 5 s read-lock can run out before the round-trip
    // camera + backend finishes, and we must not let the operator skip
    // a verification step.
    if (this.capturingPhoto && this.captureMode === 'check') return;

    // Capture the overlay state BEFORE we clear it, so we know whether
    // we should auto-skip the manual visual-revision slide.
    const autoCheckPassed = this.checkOverlay === 'success';

    if (this.currentIndex >= this.images.length - 1) {
      if (this.images.length > 0) this.finishActiveItem();
      return;
    }

    if (this.checkOverlay !== 'none') this.clearCheckOverlay();
    this.currentIndex += 1;

    // Auto-skip the manual visual-revision slide (its filename
    // contains '_visual') only when the auto check passed -- failed
    // / no_camera checks must land on it so the operator can verify
    // by eye. We check the filename explicitly instead of jumping a
    // fixed step, so we don't accidentally skip an unrelated slide
    // if the team's convention changes.
    if (autoCheckPassed
        && this.currentIndex < this.images.length - 1
        && this.isVisualSlide(this.currentIndex)) {
      this.currentIndex += 1;
    }

    this.updateProjectedImage();
    if (this.shouldApplySlideLock()) {
      this.slideLockUntil = Date.now() + VisorComponent.SLIDE_LOCK_MS;
      this.startSlideLockIndicator();
    } else {
      this.slideLockUntil = 0;
      this.clearSlideLockIndicator();
    }
    this.checkPhotoTrigger();
  }

  private isVisualSlide(index: number): boolean {
    const img = this.images[index];
    if (!img) return false;
    const url: string = img.url || img.src || '';
    const filename = (url.split('/').pop() || '').toLowerCase();
    // The team's naming convention may use '_visual', 'visual',
    // 'check visual', 'check_visual', etc. Detect the word with any
    // surrounding separator so we don't miss new variants.
    return this.hasFilenameToken(filename, 'visual');
  }

  private isWarningSlide(index: number): boolean {
    const img = this.images[index];
    if (!img) return false;

    const url: string = img.url || img.src || '';
    const filename = (url.split(/[?#]/)[0].split('/').pop() || '').toLowerCase();
    // Use a substring so names such as "warningGIRADAS" also trigger it.
    return filename.includes('warning');
  }

  prevImage(): void {
    if (this.currentIndex < 0) return;
    if (this.capturingPhoto && this.captureMode === 'check') return;
    if (this.hasSimplePhotoCaptureError()) {
      this.clearSimplePhotoCaptureError();
    }
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
      this.slideLockUntil = 0;
      this.clearSlideLockIndicator();
      this.updateProjectedImage();
    }
  }

  private isCaptureSlide(index: number): boolean {
    const img = this.images[index];
    if (!img) return false;
    const url: string = img.url || img.src || '';
    const filename = (url.split('/').pop() || '').toLowerCase();
    // Visual revision step ('CHECK VISUAL' / '_visual' / 'check-visual'
    // etc.) is NOT a capture slide -- it only frames the cards for
    // the operator to verify by eye. We match on the word 'visual'
    // anywhere in the filename to tolerate however the team names it
    // (the current convention uses a space, not an underscore).
    if (this.isVisualSlide(index)) return false;
    return this.hasFilenameToken(filename, 'foto')
      || this.hasFilenameToken(filename, 'photo')
      || this.hasFilenameToken(filename, 'check');
  }

  private isSimplePhotoSlide(index: number): boolean {
    const img = this.images[index];
    if (!img || this.isVisualSlide(index)) return false;
    const url: string = img.url || img.src || '';
    const filename = (url.split('/').pop() || '').toLowerCase();
    return !this.hasFilenameToken(filename, 'check')
      && (
        this.hasFilenameToken(filename, 'foto')
        || this.hasFilenameToken(filename, 'photo')
      );
  }

  private hasFilenameToken(filename: string, token: 'foto' | 'photo' | 'check' | 'visual'): boolean {
    return new RegExp(`(^|[\\s_\\-.])${token}([\\s_\\-.]|$)`, 'i').test(filename);
  }

  updateProjectedImage(): void {
    this.markPendingIndexSync(this.currentIndex);

    if (this.isSupervisor) {
      const mesaId = this.mesaIdForPairing || this.mesaState?.id;
      if (!mesaId) return;
      this.http.post(`/api/mesas/${mesaId}/set_index/`, { index: this.currentIndex }, { headers: this.getUserAuthHeaders() })
        .subscribe({
          next: () => this.cdr.detectChanges(),
          error: (err) => {
            this.pendingIndexSync = null;
            console.error('[Visor] Error syncing index (supervisor):', err);
          }
        });
      return;
    }

    const mesaId = this.mesaIdForPairing || this.mesaState?.id;
    if (!mesaId) return;

    this.http.post(`${this.apiUrl}set_index/`, { mesa_id: mesaId, index: this.currentIndex }, { headers: this.getAuthHeaders() })
      .subscribe({
        next: () => this.cdr.detectChanges(),
        error: (err) => {
          this.pendingIndexSync = null;
          console.error('[Visor] Error syncing index:', err);
        }
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
  onProjectedImageReady(imageUrl: string): void {
    this.lastRenderedProjectionUrl = imageUrl;
    if (!this.capturingPhoto || imageUrl !== this.captureProjectionUrl) return;
    this.scheduleCaptureAfterProjectionReady();
  }

  onProjectedImageFailed(imageUrl: string): void {
    if (!this.capturingPhoto || imageUrl !== this.captureProjectionUrl) return;
    this.failCaptureProjection(
      'No se pudo cargar la imagen de comprobaciÃ³n. Puedes revisar la conexiÃ³n y volver a intentarlo.'
    );
  }

  private checkPhotoTrigger(): void {
    if (this.isSupervisor || this.capturingPhoto) return;
    if (this.currentIndex < 0 || !this.images.length) return;

    const currentImage = this.images[this.currentIndex];
    if (!currentImage) return;

    const imageUrl: string = currentImage.url || currentImage.src || '';
    const filename = (imageUrl.split('/').pop() || '').toLowerCase();

    // 'visual' (with any separator) is the manual revision step. Its
    // filename may include 'check' but it must NOT trigger capture.
    if (this.isVisualSlide(this.currentIndex)) {
      console.log('[Visor] checkPhotoTrigger: skipping visual slide:', filename);
      return;
    }

    // 'check' as a filename token triggers capture + color validation
    // (blocks advance on failure). The visual slide has already been
    // filtered out above, even when it is named 'check visual'.
    if (this.hasFilenameToken(filename, 'check')) {
      console.log('[Visor] checkPhotoTrigger: firing check on', filename);
      this.triggerPhotoCapture('check');
    } else if (this.isSimplePhotoSlide(this.currentIndex)) {
      console.log('[Visor] checkPhotoTrigger: firing foto on', filename);
      this.triggerPhotoCapture('foto');
    }
  }

  triggerPhotoCapture(mode: 'foto' | 'check' = 'foto'): void {
    if (this.capturingPhoto || !this.activeItem) return;
    this.clearCaptureSchedule();
    this.capturingPhoto = true;
    this.captureMode = mode;
    this.captureTargetIndex = this.currentIndex;
    this.captureTargetItemId = this.activeItem?.id ?? null;
    this.captureProjectionUrl = this.projectedImage;
    this.captureStatus = 'capturing';
    this.captureErrorMessage = null;
    this.cdr.detectChanges();

    if (!this.captureProjectionUrl) {
      this.failCaptureProjection('No hay una imagen preparada para capturar.');
      return;
    }

    this.captureLoadTimeoutTimer = setTimeout(
      () => this.failCaptureProjection(
        'La imagen de comprobaciÃ³n no terminÃ³ de cargar. Puedes revisar la conexiÃ³n y volver a intentarlo.'
      ),
      VisorComponent.PROJECTION_LOAD_TIMEOUT_MS,
    );

    // Cached images may already have emitted load before the capture was
    // armed. Otherwise onProjectedImageReady will continue the sequence.
    if (this.lastRenderedProjectionUrl === this.captureProjectionUrl) {
      this.scheduleCaptureAfterProjectionReady();
    }
  }

  private scheduleCaptureAfterProjectionReady(): void {
    if (this.captureStartScheduled || !this.capturingPhoto) return;
    this.captureStartScheduled = true;
    if (this.captureLoadTimeoutTimer) {
      clearTimeout(this.captureLoadTimeoutTimer);
      this.captureLoadTimeoutTimer = null;
    }

    const generation = this.captureScheduleGeneration;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (generation !== this.captureScheduleGeneration || !this.capturingPhoto) return;
      this.captureStartTimer = setTimeout(() => {
        this.captureStartTimer = null;
        this.captureStartScheduled = false;
        if (generation !== this.captureScheduleGeneration || !this.capturingPhoto) return;
        if (!this.isCurrentCaptureTarget(this.captureTargetIndex, this.captureTargetItemId)
            || this.projectedImage !== this.captureProjectionUrl) {
          this.cancelStaleCapture();
          return;
        }
        this.attemptCapture(1);
      }, VisorComponent.PROJECTOR_SETTLE_AFTER_RENDER_MS);
    }));
  }

  private failCaptureProjection(message: string): void {
    if (!this.capturingPhoto) return;
    const mode = this.captureMode;
    this.clearCaptureSchedule();
    this.capturingPhoto = false;
    this.cameraRetrying = false;
    this.captureStatus = 'error';
    this.captureErrorMessage = message;
    if (mode === 'check') this.applyCheckResult(false);
    this.cdr.detectChanges();
  }

  private cancelStaleCapture(): void {
    this.clearCaptureSchedule();
    this.capturingPhoto = false;
    this.cameraRetrying = false;
    this.captureStatus = 'idle';
    this.captureErrorMessage = null;
    this.cdr.detectChanges();
  }

  private clearCaptureSchedule(): void {
    this.captureScheduleGeneration += 1;
    this.captureStartScheduled = false;
    if (this.captureStartTimer) {
      clearTimeout(this.captureStartTimer);
      this.captureStartTimer = null;
    }
    if (this.captureLoadTimeoutTimer) {
      clearTimeout(this.captureLoadTimeoutTimer);
      this.captureLoadTimeoutTimer = null;
    }
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
        this.captureErrorMessage = null;
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
        if (this.captureMode === 'check') {
          // No photo means we cannot validate -- block the operator
          // with a 'camera unavailable' message instead of letting
          // them silently skip a verification step. Mirror it on the
          // backend so the supervisor visor sees the same block.
          this.applyCheckResult(false, 'no_camera');
          this.notifyNoCamera();
          this.cdr.detectChanges();
          setTimeout(() => {
            this.captureStatus = 'idle';
            this.cdr.detectChanges();
          }, 3000);
        } else {
          if (!this.isCurrentCaptureTarget(this.captureTargetIndex, this.captureTargetItemId)) {
            this.captureStatus = 'idle';
            this.captureErrorMessage = null;
            this.cdr.detectChanges();
            return;
          }
          this.captureErrorMessage = 'Falló la comunicación con la cámara. Puedes continuar sin capturar esta foto o pulsar P para reintentar.';
          this.cdr.detectChanges();
        }
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
    const capturedIndex = this.currentIndex;
    const activeItemId = this.activeItem?.id ?? null;
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
        this.captureErrorMessage = null;
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
        } else {
          this.autoAdvanceAfterSimplePhoto(capturedIndex, activeItemId);
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
          this.cdr.detectChanges();
          setTimeout(() => {
            this.captureStatus = 'idle';
            this.cdr.detectChanges();
          }, 3000);
        } else {
          if (!this.isCurrentCaptureTarget(capturedIndex, activeItemId)) {
            this.captureStatus = 'idle';
            this.captureErrorMessage = null;
            this.cdr.detectChanges();
            return;
          }
          this.captureErrorMessage = 'La foto se tomó, pero no se pudo guardar. Puedes continuar sin capturar esta foto o pulsar P para reintentar.';
          this.cdr.detectChanges();
        }
      }
    });
  }

  private hasSimplePhotoCaptureError(): boolean {
    return this.captureMode === 'foto'
      && this.captureStatus === 'error'
      && !!this.captureErrorMessage;
  }

  private isCurrentCaptureTarget(index: number | null, activeItemId: number | string | null): boolean {
    return index !== null
      && this.currentIndex === index
      && !!this.activeItem
      && this.activeItem.id === activeItemId;
  }

  private clearSimplePhotoCaptureError(): void {
    if (!this.hasSimplePhotoCaptureError()) return;
    this.captureStatus = 'idle';
    this.captureErrorMessage = null;
    this.slideLockUntil = 0;
    this.clearSlideLockIndicator();
  }

  private autoAdvanceAfterSimplePhoto(capturedIndex: number, activeItemId: number | string | null): void {
    if (this.isSupervisor) return;
    if (!this.activeItem || this.activeItem.id !== activeItemId) return;
    if (this.currentIndex !== capturedIndex) return;
    if (!this.isSimplePhotoSlide(capturedIndex)) return;

    // The capture itself proves the operator waited for this slide; do not
    // let the normal 5 s read-lock hold the flow after the photo is saved.
    this.slideLockUntil = 0;
    this.clearSlideLockIndicator();
    this.nextImage();
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
    // Supervisor needs near-real-time feedback while calibrating. The player
    // can poll a little slower because local keyboard actions are immediate
    // and backend changes tolerate a short delay.
    const statePollMs = this.isSupervisor ? 1000 : 2000;
    this.statePollSub = interval(statePollMs).pipe(
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
      if (!this.isSupervisor && this.deviceToken && this.diskTokenSyncedFor !== this.deviceToken) {
        this.persistTokenLocally(this.deviceToken);
      }
      const syncedIndex = this.reconcileRemoteIndex(state.current_image_index);
      this.mesaState = {
        ...state,
        current_image_index: syncedIndex ?? state.current_image_index,
      };
      if (state.nombre) {
        this.titleService.setTitle(`Visor - ${state.nombre}`);
      }
      const previousIndex = this.currentIndex;
      if (syncedIndex !== null) {
        this.currentIndex = syncedIndex;
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
      if (!this.isSupervisor && syncedIndex !== null && syncedIndex !== previousIndex) {
        this.checkPhotoTrigger();
      }
    });

    if (!this.isSupervisor && environment.enableDeviceSSE) {
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
        this.pendingIndexSync = null;
        this.clearSimplePhotoCaptureError();
        this.cdr.detectChanges();
      }
      return;
    }

    if (!this.activeItem || this.activeItem.id !== item.id) {
      this.clearSimplePhotoCaptureError();
      this.pendingIndexSync = null;
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
    const headers = this.isSupervisor ? this.getUserAuthHeaders() : this.getAuthHeaders();
    this.http.get<any[]>(url, { headers }).subscribe({
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
    this.heartbeatSub?.unsubscribe();
    this.heartbeatSub = interval(30000).pipe(
      startWith(0),
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
        return this.http.post(
          `${this.apiUrl}heartbeat/`,
          payload,
          { headers: this.getAuthHeaders() },
        ).pipe(
          // Keep the outer interval alive after a transient factory-network
          // failure. Otherwise one failed POST leaves a stale health value in
          // Railway until Chrome is restarted.
          catchError((err) => {
            if (err.status === 401) this.handleUnauthorized('Heartbeat');
            return of(null);
          }),
        );
      })
    ).subscribe();
  }

  private clearAuthRecoveryTimer(): void {
    if (this.authRecoveryTimer) {
      clearTimeout(this.authRecoveryTimer);
      this.authRecoveryTimer = null;
    }
  }

  private retryExistingToken(): void {
    if (this.isSupervisor) return;

    const source = this.authRecoverySource || 'Unknown';
    if (!this.deviceToken) {
      this.invalidateTokenAndRequestPairing(source, 'sin token en memoria');
      return;
    }

    const streak = this.authRecovery401Count;
    this.loadingMessage = 'Reconectando…';
    this.recoveryDebug = streak > 0
      ? `401 desde ${source}. Revalidando token (${streak}/${VisorComponent.AUTH_REVALIDATION_MAX_401})…`
      : `401 desde ${source}. Reintentando sin borrar token…`;
    this.cdr.detectChanges();

    this.http.get<MesaState>(`${this.apiUrl}state/`, { headers: this.getAuthHeaders() }).subscribe({
      next: (state) => {
        this.mesaState = state;
        this.recoveryDebug = 'Token revalidado. Recuperando proyeccion.';
        this.enterProjectionMode();
      },
      error: (err) => {
        let message: string;
        if (err?.status === 401) {
          this.authRecovery401Count += 1;
          if (this.authRecovery401Count >= VisorComponent.AUTH_REVALIDATION_MAX_401) {
            this.invalidateTokenAndRequestPairing(
              source,
              `401 repetido ${this.authRecovery401Count} veces`,
            );
            return;
          }
          message = `401 persistente (${this.authRecovery401Count}/${VisorComponent.AUTH_REVALIDATION_MAX_401}). Reintentando sin borrar token…`;
        } else {
          this.authRecovery401Count = 0;
          const status = err?.status ?? '?';
          message = `Backend no disponible (${status}). Reintentando con el mismo token…`;
        }

        this.recoveryDebug = message;
        this.cdr.detectChanges();
        this.clearAuthRecoveryTimer();
        this.authRecoveryTimer = setTimeout(
          () => this.retryExistingToken(),
          VisorComponent.AUTH_REVALIDATION_RETRY_MS,
        );
      },
    });
  }

  private invalidateTokenAndRequestPairing(source: string, reason: string): void {
    this.clearAuthRecoveryTimer();
    this.authRecovery401Count = 0;
    this.authRecoverySource = null;

    this.recoveryDebug = `Token rechazado tras ${source} (${reason}). Borrando token y solicitando nueva vinculacion.`;
    this.cdr.detectChanges();

    localStorage.removeItem(this.getTokenKey());
    this.diskTokenSyncedFor = null;
    this.persistTokenLocally('');
    this.deviceToken = null;
    this.mesaState = null;
    this.requestPairingCode();
  }

  handleUnauthorized(source: string = 'Unknown'): void {
    if (this.isSupervisor) {
      this.errorMessage = 'Sesion expirada. Vuelve a iniciar sesion en el dashboard.';
      this.mode = 'ERROR';
      this.cdr.detectChanges();
      return;
    }

    // Guard against re-entry: while we're already recovering, later
    // in-flight 401s must not spawn parallel retries or new pairing
    // requests every couple of seconds.
    if (this.authRecoverySource || this.mode === 'PAIRING') {
      return;
    }

    console.warn(`[Visor] Unauthorized access detected from ${source}.`);
    this.authRecoverySource = source;
    this.authRecovery401Count = 0;
    this.mode = 'LOADING';
    this.loadingMessage = 'Reconectando…';
    this.recoveryDebug = `401 desde ${source}. Reintentando con el token guardado antes de desvincular.`;
    this.cdr.detectChanges();

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.statePollSub?.unsubscribe();
    this.itemPollSub?.unsubscribe();
    this.heartbeatSub?.unsubscribe();
    this.pairingPollSub?.unsubscribe();
    this.retryExistingToken();
  }
}
