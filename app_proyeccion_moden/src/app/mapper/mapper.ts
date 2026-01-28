import { Component, ElementRef, inject, PLATFORM_ID, Renderer2, ViewChild, HostListener, Input, Output, EventEmitter, OnChanges, SimpleChanges, AfterViewInit } from '@angular/core';
import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import fixPerspective from './css3-perspective';

interface Submodule {
  id: string;
  name: string;
  status: 'waiting' | 'processing' | 'done';
  images: string[];
}

interface TableData {
  id: string;
  submodules: Submodule[];
}

@Component({
  selector: 'app-mapper',
  standalone: true,
  imports: [],
  templateUrl: './mapper.html',
  styleUrl: './mapper.css',
})
// Clase Mapper: Implementa OnChanges para detectar cambios en inputs.
export class Mapper implements OnChanges {
  // Configuración básica (Imágen, Estado, ID, Interacción)
  @Input() imageUrl: string | null = null;
  @Input() isCalibrationActive: boolean = false;
  @Input() mesaId: number | null = null;
  @Input() allowInteraction: boolean = true;

  // Variables para gestionar la lógica del setter de calibración
  private _calibrationJson: any = null;
  private _lastCalibrationHash: string = ''; // Hash para comparar y evitar reaplicar calibraciones idénticas

  // Setter personalizado para detectar cambios reales en el JSON de calibración
  @Input()
  set calibrationJson(value: any) {
    this._calibrationJson = value;

    // Compare using hash to detect actual changes
    const newHash = value?.corners ? JSON.stringify(value.corners) : '';
    if (newHash !== this._lastCalibrationHash && newHash !== '') {
      this._lastCalibrationHash = newHash;
      console.log('[Mapper] Calibration changed, applying:', value);

      // Apply immediately if markers are ready and not actively calibrating
      if (this.markers?.length === 4 && !this.calibrating) {
        this.applyCalibrationFromServer(value);
      }
    }
  }

  get calibrationJson(): any {
    return this._calibrationJson;
  }
  @Output() calibrationSaved = new EventEmitter<any>();

  private http = inject(HttpClient);
  public isSaving = false;
  public saveMessage = '';

  // @ViewChild('dirPath') dirPath!: ElementRef<HTMLInputElement>;
  @ViewChild('sourceIframe') sourceIframe!: ElementRef<HTMLInputElement>;
  @ViewChild('markertl') markertl!: ElementRef<HTMLInputElement>;
  @ViewChild('markertr') markertr!: ElementRef<HTMLInputElement>;
  @ViewChild('markerbl') markerbl!: ElementRef<HTMLInputElement>;
  @ViewChild('markerbr') markerbr!: ElementRef<HTMLInputElement>;
  @ViewChild('buttonsContainer') buttonsContainer!: ElementRef<HTMLInputElement>;
  @ViewChild('line1') line1!: ElementRef<HTMLInputElement>;
  @ViewChild('line2') line2!: ElementRef<HTMLInputElement>;
  @ViewChild('line3') line3!: ElementRef<HTMLInputElement>;
  @ViewChild('line4') line4!: ElementRef<HTMLInputElement>;
  @ViewChild('correctedVideo') correctedVideo!: ElementRef<HTMLInputElement>;
  @ViewChild('mapperWrapper') mapperWrapper!: ElementRef<HTMLInputElement>;
  private document = inject(DOCUMENT);
  private platformId = inject(PLATFORM_ID);
  private inactiveDelay = 2000;
  private previewPaddingSize = 40; // in pixels
  private nextImage = '';
  private dirIndex = 0;
  private imgIndex = 0;
  private images: string[] = [];
  // private callbackExportConfig: () => {};
  // private callbackImportConfig;
  // private callbackOpenDirectory;
  public calibrating = false;

  // Mock Data
  private mockTableData: Record<string, TableData> = {
    '1': {
      id: '1',
      submodules: [
        {
          id: 'sub1',
          name: 'Submódulo A',
          status: 'waiting',
          images: [
            'assets/demo/E04 (2025-07-30)/JPG(PSY)_01.sup_Xtmp.jpg',
            'assets/demo/E04 (2025-07-30)/JPG(PSY)_02.sup_MALLAtmp.jpg',
            'assets/demo/E04 (2025-07-30)/JPG(PSY)_03.sup_X_soldartmp.jpg',
            'assets/demo/E04 (2025-07-30)/JPG(PSY)_04.sup_RETIRARtmp.jpg',
            'assets/demo/E04 (2025-07-30)/JPG(PSY)_05.inf_X.jpg',
            'assets/demo/E04 (2025-07-30)/JPG(PSY)_06.inf_MALLA.jpg',
            'assets/demo/E04 (2025-07-30)/JPG(PSY)_07.inf_X_soldar.jpg',
            'assets/demo/E04 (2025-07-30)/JPG(PSY)_08.inf_Y_soldartmp.jpg',
            'assets/demo/E04 (2025-07-30)/JPG(PSY)_09.inf_Y_soldartmp.jpg',
            'assets/demo/E04 (2025-07-30)/JPG(PSY)_10.inf_XYtmp.jpg',
            'assets/demo/E04 (2025-07-30)/JPG(PSY)_11.intermtmp.jpg',
            'assets/demo/E04 (2025-07-30)/JPG(PSY)_12.inf_piezas_encajetmp.jpg',
            'assets/demo/E04 (2025-07-30)/JPG(PSY)_13.sup_SOLDARtmp.jpg',
            'assets/demo/E04 (2025-07-30)/JPG(PSY)_14.sup_Ytmp.jpg',
            'assets/demo/E04 (2025-07-30)/JPG(PSY)_15.sup_Y_posictmp.jpg',
            'assets/demo/E04 (2025-07-30)/JPG(PSY)_16.sup_Y_soldartmp.jpg',
            'assets/demo/E04 (2025-07-30)/JPG(PSY)_17.sup_XYtmp.jpg',
            'assets/demo/E04 (2025-07-30)/JPG(PSY)_18.inf+sup_encaje_quitartmp.jpg',
            'assets/demo/E04 (2025-07-30)/JPG(PSY)_19.inf_guiado_hembratmp.jpg',
            'assets/demo/E04 (2025-07-30)/JPG(PSY)_20.sup_guiado_macho.jpg',
            'assets/demo/E04 (2025-07-30)/JPG(PSY)_21.FINtmp.jpg'
          ]
        },
        {
          id: 'sub2',
          name: 'Submódulo B',
          status: 'waiting',
          images: ['assets/parts/part3.png']
        }
      ]
    }
  };




  // const document = window.document;
  private corners: number[] = [];
  private markers: ElementRef<HTMLInputElement>[] = [];
  private currentCorner: HTMLInputElement | null = null;
  private currentCornerArrow: HTMLInputElement | null = null;
  private grabOffset = { x: 0, y: 0 };
  private polygonError = false;
  private boundsError = false;
  private screenWidth = 0;
  private screenHeight = 0;
  private currentScreenWidth = 0;
  private currentScreenHeight = 0;
  private currentStream = "";
  private correctingSource = false;
  private userInactiveTimer: any;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['imageUrl']) {
      const url = changes['imageUrl'].currentValue;
      this.nextImage = url || ''; // Update nextImage even if null

      if (this.correctedVideo?.nativeElement) {
        if (url) {
          this.changeImage(url);
        } else {
          // Must clear the src if null, though display:none should handle it visually
          this.correctedVideo.nativeElement.src = '';
        }
      }
    }

    if (changes['isCalibrationActive']) {
      const active = changes['isCalibrationActive'].currentValue;
      if (active !== this.calibrating) {
        // Sync internal state with input
        // We might need to call toggleCalibration, but toggleCalibration toggles.
        // Better to set it explicitly.
        this.calibrating = active;
        if (this.markers) { // markers populated in ngAfterViewInit
          this.markers.forEach(marker => {
            marker.nativeElement.style.visibility = active ? "visible" : "hidden";
          });
        }
      }
    }

    // Note: calibrationJson is now handled by setter, not here
  }

  constructor(private renderer: Renderer2, private route: ActivatedRoute) { }



  // Apply calibration received from server
  private applyCalibrationFromServer(calibration: any): void {
    console.log('[Mapper] applyCalibrationFromServer called with:', calibration);
    console.log('[Mapper] markers length:', this.markers?.length);
    console.log('[Mapper] calibrating:', this.calibrating);

    if (!calibration?.corners || !this.markers?.length) {
      console.log('[Mapper] BAILING: no corners or no markers');
      return;
    }

    // Apply the corner positions
    this.corners = calibration.corners;
    console.log('[Mapper] corners set to:', this.corners);

    // Update marker positions on screen
    if (isPlatformBrowser(this.platformId) && this.markers.length === 4) {
      const cornerPositions = [
        { x: this.corners[0], y: this.corners[1] }, // TL
        { x: this.corners[2], y: this.corners[3] }, // TR
        { x: this.corners[4], y: this.corners[5] }, // BL
        { x: this.corners[6], y: this.corners[7] }, // BR
      ];

      this.markers.forEach((marker, idx) => {
        marker.nativeElement.style.left = cornerPositions[idx].x + 'px';
        marker.nativeElement.style.top = cornerPositions[idx].y + 'px';
      });

      // Recalculate perspective transform
      console.log('[Mapper] calling update()');
      this.update();
      console.log('[Mapper] update() completed');
    } else {
      console.log('[Mapper] SKIPPED update: not browser or markers != 4');
    }
  }

  // Save calibration to server
  public saveCalibrationToServer(): void {
    if (!this.mesaId) {
      console.warn('Cannot save calibration: mesaId not set');
      return;
    }

    this.isSaving = true;
    this.saveMessage = '';

    const calibrationData = {
      corners: this.corners,
      screenWidth: this.screenWidth,
      screenHeight: this.screenHeight,
      timestamp: new Date().toISOString()
    };

    this.http.post(`/api/mesas/${this.mesaId}/calibration/`, {
      calibration_json: calibrationData
    }).subscribe({
      next: (response: any) => {
        this.isSaving = false;
        this.saveMessage = '✓ Guardado';
        this.calibrationSaved.emit(calibrationData);
        setTimeout(() => this.saveMessage = '', 3000);
      },
      error: (err) => {
        this.isSaving = false;
        this.saveMessage = '✗ Error al guardar';
        console.error('Error saving calibration:', err);
        setTimeout(() => this.saveMessage = '', 3000);
      }
    });
  }

  private saveCalibration() {
    if (isPlatformBrowser(this.platformId)) {
      localStorage.setItem('mapper_corners', JSON.stringify(this.corners));
    }
  }

  setCurrentCorner(newCorner: HTMLInputElement | null) {
    this.currentCorner = newCorner;
  };

  setCurrentCornerArrow(newCorner: HTMLInputElement | null) {
    this.currentCornerArrow = newCorner;
  };

  setDeselectCorner() {
    this.setCurrentCornerArrow(null);
    this.markers.forEach(el => {
      el.nativeElement.classList.remove("selected");
    });
  };

  async setExportCofig() {
    return
    // await callbackExportConfig()
  };

  async setImportCofig() {
    return
    // var values =  await callbackImportConfig()
    // var pardedValues = JSON.parse(values)
    // console.log(pardedValues.targetCorners)
    // this.corners = pardedValues.targetCorners
    // this.update()
  };

  async setDirectory() {
    // var values =  await callbackOpenDirectory()
    var values = [""]
    // console.log(values)
    this.images = values
    this.dirIndex = 0
    this.imgIndex = 0
    this.changeImage(values[0]);
    var path = values[0].split("\\")
    // this.dirPath.nativeElement.innerText = "Directorio: " + path[path.length - 2] + "\n Archivo: " + path[path.length - 1];
  };

  toggleCalibration() {
    this.calibrating = !this.calibrating;

    this.markers.forEach(marker => {
      if (this.calibrating) {
        marker.nativeElement.style.visibility = "visible";
      } else {
        marker.nativeElement.style.visibility = "hidden";
      }
    });

    if (!this.calibrating) {
      this.setDeselectCorner();
    }
  }

  async setEditMode() {
    // Deprecated in favor of toggleCalibration logic, keeping if needed for other calls
    // but keydown 'g' will now point to toggleCalibration
    this.toggleCalibration();
  };

  // Get the determinant of given 3 points
  getDeterminant(p0: { x: number, y: number }, p1: { x: number, y: number }, p2: { x: number, y: number }) {
    return (
      p0.x * p1.y +
      p1.x * p2.y +
      p2.x * p0.y -
      p0.y * p1.x -
      p1.y * p2.x -
      p2.y * p0.x
    );
  };

  hasBoundsError() {
    const clientWidth = this.document.documentElement.clientWidth;
    const clientHeight = this.document.documentElement.clientHeight;
    var currentBoundsError = false;
    for (var i = 0; i != 8; i += 2) {
      const x = this.corners[i];
      const y = this.corners[i + 1];
      const contained =
        x >= 0 && x <= clientWidth && y >= 0 && y <= clientHeight;

      if (!contained) {
        currentBoundsError = true;
        break;
      }
    }

    if (currentBoundsError !== this.boundsError) {
      if (currentBoundsError) {
        this.renderer.addClass(this.mapperWrapper.nativeElement, "boundsError");
      } else {
        this.renderer.removeClass(this.mapperWrapper.nativeElement, "boundsError");
      }
      this.boundsError = currentBoundsError;
    }
  };

  // Return true if it is a concave polygon. Otherwise return true;
  haspolygonError() {
    var det1 = this.getDeterminant(
      // Topleft
      { x: this.corners[0], y: this.corners[1] },
      // Topright
      { x: this.corners[2], y: this.corners[3] },
      // Bottomright
      { x: this.corners[6], y: this.corners[7] }
    );
    var det2 = this.getDeterminant(
      // Bottomright
      { x: this.corners[6], y: this.corners[7] },
      // Bottomleft
      { x: this.corners[4], y: this.corners[5] },
      // Topleft
      { x: this.corners[0], y: this.corners[1] }
    );

    if (det1 * det2 <= 0) return true;

    var det1 = this.getDeterminant(
      // Topright
      { x: this.corners[2], y: this.corners[3] },
      // Bottomright
      { x: this.corners[6], y: this.corners[7] },
      // Bottomleft
      { x: this.corners[4], y: this.corners[5] }
    );
    var det2 = this.getDeterminant(
      // Bottomleft
      { x: this.corners[4], y: this.corners[5] },
      // Topleft
      { x: this.corners[0], y: this.corners[1] },
      // Topright
      { x: this.corners[2], y: this.corners[3] }
    );

    if (det1 * det2 <= 0) return true;

    return false;
  };

  transform2d(srcCorners: number[], dstCorners: number[]) {
    const H = fixPerspective(srcCorners, dstCorners);
    const t = "matrix3d(" + H.join(", ") + ")";
    this.sourceIframe.nativeElement.style.transform = t;
  };

  adjustLine(from: { x: number, y: number }, to: { x: number, y: number }, line: ElementRef<HTMLInputElement>) {
    var fT = from.y;
    var tT = to.y;
    var fL = from.x;
    var tL = to.x;

    var CA = Math.abs(tT - fT);
    var CO = Math.abs(tL - fL);
    var H = Math.sqrt(CA * CA + CO * CO);
    var ANG = (180 / Math.PI) * Math.acos(CA / H);

    if (tT > fT) {
      var top = (tT - fT) / 2 + fT;
    } else {
      var top = (fT - tT) / 2 + tT;
    }
    if (tL > fL) {
      var left = (tL - fL) / 2 + fL;
    } else {
      var left = (fL - tL) / 2 + tL;
    }

    if (
      (fT < tT && fL < tL) ||
      (tT < fT && tL < fL) ||
      (fT > tT && fL > tL) ||
      (tT > fT && tL > fL)
    ) {
      ANG *= -1;
    }
    top -= H / 2;

    line.nativeElement.style.transform = "rotate(" + ANG + "deg)";
    line.nativeElement.style.top = top + "px";
    line.nativeElement.style.left = left + "px";
    line.nativeElement.style.height = H + "px";
  };

  adjustLines(corners: number[]) {
    this.adjustLine(
      { x: corners[0], y: corners[1] },
      { x: corners[2], y: corners[3] },
      this.line1
    );

    this.adjustLine(
      { x: corners[2], y: corners[3] },
      { x: corners[6], y: corners[7] },
      this.line2
    );

    this.adjustLine(
      { x: corners[6], y: corners[7] },
      { x: corners[4], y: corners[5] },
      this.line3
    );

    this.adjustLine(
      { x: corners[0], y: corners[1] },
      { x: corners[4], y: corners[5] },
      this.line4
    );
  };

  updateResolution() {
    var changed = false;
    if (this.screenWidth !== this.currentScreenWidth) {
      this.screenWidth = this.currentScreenWidth;
      this.sourceIframe.nativeElement.style.width = this.screenWidth + "px";
      changed = true;
    }

    if (this.screenHeight !== this.currentScreenHeight) {
      this.screenHeight = this.currentScreenHeight;
      this.sourceIframe.nativeElement.style.height = this.screenHeight + "px";
      changed = true;
    }

    if (changed) {
      this.update();
    }

    return changed;
  };

  update() {
    var w = this.sourceIframe.nativeElement.offsetWidth,
      h = this.sourceIframe.nativeElement.offsetHeight;

    // Check if dimensions are valid
    if (w === 0 || h === 0) {
      console.log('[Mapper] update() - INVALID dimensions w=', w, 'h=', h);
      // Try using screen dimensions as fallback
      w = this.screenWidth || window.innerWidth;
      h = this.screenHeight || window.innerHeight;
      console.log('[Mapper] update() - using fallback dimensions w=', w, 'h=', h);
    }

    const from = [0, 0, w, 0, 0, h, w, h];
    const to = this.corners;

    console.log('[Mapper] update() - transform2d from:', from, 'to:', to);
    this.transform2d(from, to);

    for (var i = 0; i != 8; i += 2) {
      var elt = this.markers[i / 2].nativeElement
      elt.style.left = this.corners[i] + "px";
      elt.style.top = this.corners[i + 1] + "px";
    }

    this.adjustLines(to);

    const currentPolygonError = this.haspolygonError();
    if (currentPolygonError !== this.polygonError) {
      if (currentPolygonError) {
        this.renderer.addClass(this.mapperWrapper.nativeElement, "polygonError");
      } else {
        this.renderer.removeClass(this.mapperWrapper.nativeElement, "polygonError");
      }
      this.polygonError = currentPolygonError;
    }

    // Force browser repaint
    void this.sourceIframe.nativeElement.offsetHeight;
  };

  move(e: MouseEvent) {

    this.scheduleUserInactive();

    if (this.currentCorner) {

      const targetX = e.pageX - this.grabOffset.x;
      const targetY = e.pageY - this.grabOffset.y;
      const cornerIndex = parseInt(
        this.currentCorner.id.slice("marker".length)
      );
      // Don't drag out of viewport
      if (targetX <= this.document.documentElement.clientWidth && targetX >= 0) {
        this.corners[cornerIndex] = targetX;
      }
      if (targetY <= this.document.documentElement.clientHeight && targetY >= 0) {
        this.corners[cornerIndex + 1] = targetY;
      }
      // console.log(this.currentCorner.id)
      this.update();
      // Real-time sync while dragging
      this.throttledSaveToServer();
    }
  };

  moveArrows(pos: string) {
    this.scheduleUserInactive();
    if (this.currentCornerArrow) {
      const cornerIndex = parseInt(
        this.currentCornerArrow.id.slice("marker".length)
      );
      if (pos == "l") {
        var targetX = this.corners[cornerIndex] - 1;
        if (targetX <= this.document.documentElement.clientWidth && targetX >= 0) {
          this.corners[cornerIndex] = targetX;
        }
      } else if (pos == "r") {
        var targetX = this.corners[cornerIndex] + 1;
        if (targetX <= this.document.documentElement.clientWidth && targetX >= 0) {
          this.corners[cornerIndex] = targetX;
        }
      } else if (pos == "d") {
        var targetY = this.corners[cornerIndex + 1] + 1;
        if (targetY <= this.document.documentElement.clientHeight && targetY >= 0) {
          this.corners[cornerIndex + 1] = targetY;
        }
      } else if (pos == "u") {
        var targetY = this.corners[cornerIndex + 1] - 1;
        if (targetY <= this.document.documentElement.clientHeight && targetY >= 0) {
          this.corners[cornerIndex + 1] = targetY;
        }
      }

      this.update();
      this.saveCalibration();
      // Throttled save to server for real-time sync with player
      this.throttledSaveToServer();
    }
  };

  private arrowSaveTimeout: any = null;
  private debouncedSaveToServer() {
    if (this.arrowSaveTimeout) {
      clearTimeout(this.arrowSaveTimeout);
    }
    this.arrowSaveTimeout = setTimeout(() => {
      this.saveCalibrationToServer();
    }, 150); // 150ms debounce
  }

  // Throttle for real-time sync during drag (sends every 100ms)
  private lastThrottleSave: number = 0;
  private throttledSaveToServer() {
    const now = Date.now();
    if (now - this.lastThrottleSave >= 100) {
      this.lastThrottleSave = now;
      this.saveCalibrationToServer();
    }
  }

  initCorners(initialTargetCorners: any[]) {
    if (this.correctingSource) {
      return;
    }

    const viewportWidth = this.document.documentElement.clientWidth;
    const viewportHeight = this.document.documentElement.clientHeight;

    const left = 0;
    const top = 0;
    const right = viewportWidth + left;
    const bottom = viewportHeight + top;

    const newCorners = [left, top, right, top, left, bottom, right, bottom];

    if (initialTargetCorners) {
      var matchesDefaultPosition = true;
      for (let i = 0; i < initialTargetCorners.length; i++) {
        if (initialTargetCorners[i] !== newCorners[i]) {
          matchesDefaultPosition = false;
          break;
        }
      }

      this.corners = initialTargetCorners;
    } else {
      this.corners = newCorners;
    }
    if (!this.updateResolution()) {
      this.update();
    }
    this.hasBoundsError();
  };

  transitionEndHandler() {
    this.renderer.removeClass(this.mapperWrapper.nativeElement, "transition");
  };

  setInactiveImmediately() {
    clearTimeout(this.userInactiveTimer);
    this.renderer.addClass(this.mapperWrapper.nativeElement, "inactive");
  };

  startSourceCorrect() {
    this.correctingSource = true;
    this.renderer.addClass(this.mapperWrapper.nativeElement, "correctingSource");
    this.renderer.addClass(this.mapperWrapper.nativeElement, "transition");
    this.setInactiveImmediately();
  };

  endSourceCorrect() {
    this.correctingSource = false;
    this.renderer.addClass(this.mapperWrapper.nativeElement, "transition");
    this.renderer.removeClass(this.mapperWrapper.nativeElement, "correctingSource");
    this.document.body.scrollTop = 0;
    this.document.body.scrollLeft = 0;
    this.scheduleUserInactive();
    this.renderer.addClass(this.mapperWrapper.nativeElement, "inactive");
  };

  toggleGuides() {
    return
    // this.sourceIframe &&
    //   this.sourceIframe.contentWindow &&
    //   this.sourceIframe.contentWindow.toggleGuides &&
    //   this.sourceIframe.contentWindow.toggleGuides();
  };

  changeImage(imageUrl: string) {
    this.correctedVideo.nativeElement.src = imageUrl;
  };

  toggleSourceCorrect() {
    if (this.correctingSource) {
      this.endSourceCorrect();
    } else {
      this.startSourceCorrect();
    }
  };

  scheduleUserInactive() {
    if (typeof this.document.hasFocus === 'function') {
      if (!this.document.hasFocus()) {
        this.setInactiveImmediately();
        return;
      }
    }
    // User inactive doesn't apply in source correct mode
    if (this.correctingSource) {
      return;
    }
    clearTimeout(this.userInactiveTimer);
    this.renderer.removeClass(this.mapperWrapper.nativeElement, "inactive");
    this.userInactiveTimer = setTimeout(() => {
      this.renderer.addClass(this.mapperWrapper.nativeElement, "inactive");
    }, this.inactiveDelay);
  };

  toggleFullScreen() {
    if (!this.document.fullscreenElement) {
      this.document.documentElement.requestFullscreen();
    } else {
      this.document.exitFullscreen();
    }
  };

  mouseupHandler() {
    if (this.calibrating) {
      this.scheduleUserInactive();
      if (this.currentCorner) {
        this.saveCalibration();
        // Auto-save on drag release for real-time sync with player
        this.saveCalibrationToServer();
      }
      this.setCurrentCorner(null);
      this.markers.forEach(marker => {
        marker.nativeElement.classList.remove("grabbing");
      });
    }
  }

  mousedownHandler(e: MouseEvent) {

    var target: HTMLInputElement = e.target as HTMLInputElement
    if (this.calibrating) {
      this.scheduleUserInactive();
      if (this.markers.length > -1) {
        this.setCurrentCorner(target);
        this.setCurrentCornerArrow(target)
        target.classList.add("grabbing");
        this.markers.forEach(marker => {
          marker.nativeElement.classList.remove("selected");
        });
        target.classList.add("selected");
        var rect = target.getBoundingClientRect();
        // x and y position within the element relative to its center
        var x = e.clientX - rect.left - rect.width / 2;
        var y = e.clientY - rect.top - rect.height / 2;

        this.grabOffset.x = x;
        this.grabOffset.y = y;
      }
    }
  }

  public isBlackout = false;

  @HostListener('document:keydown', ['$event'])
  async keydownHandler(e: KeyboardEvent) {
    if (!this.allowInteraction) return;

    this.scheduleUserInactive();

    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) {
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      this.toggleFullScreen();
    } else if ((e.key === "g" || e.key === "G") && !this.correctingSource) {
      e.preventDefault();
      this.toggleCalibration();
    } else if (e.key === "i" || e.key === "I") {
      e.preventDefault();
      // this.setImportCofig()
    } else if (e.key === "e" || e.key === "E") {
      e.preventDefault();
      // this.setExportCofig()
    } else if (e.key === "o" || e.key === "O") {
      e.preventDefault();
      this.setDirectory();
    } else if (e.key === " ") {
      e.preventDefault();
      this.isBlackout = !this.isBlackout;
    } else if (e.key == "Home" || e.key == "PageUp" || e.key == "End" || e.key == "PageDown") {
      if (this.calibrating) {
        this.scheduleUserInactive();
        var markerIndex = 0
        if (e.key == "Home") {
          markerIndex = 0
        } else if (e.key == "PageUp") {
          markerIndex = 1
        } else if (e.key == "End") {
          markerIndex = 2
        } else if (e.key == "PageDown") {
          markerIndex = 3
        }
        // console.log(markerIndex)
        // console.log(this.markers)
        // console.log(this.markers[markerIndex])
        const target = this.markers[markerIndex].nativeElement
        this.setCurrentCornerArrow(target)
        this.markers.forEach(marker => {
          marker.nativeElement.classList.remove("selected");
        });

        target.classList.add("selected");
        var rect = target.getBoundingClientRect();
        var eventTarget = e.target as HTMLInputElement
        const { x, y, width, height } = eventTarget.getBoundingClientRect();

        var calcX = x - rect.left - rect.width / 2;
        var calcY = y - rect.top - rect.height / 2;

        this.grabOffset.x = calcX;
        this.grabOffset.y = calcY;
      }
    } else if (e.key === "c" || e.key === "C") {
      this.toggleCalibration();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      this.moveArrows('d');
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (this.currentCornerArrow) {
        this.moveArrows('l');
      } else {
        if (this.imgIndex > 0) {
          this.imgIndex--;
        }
        this.nextImage = this.images[this.imgIndex];
        this.changeImage(this.nextImage);
        console.log("Showing image: " + this.nextImage);
      }
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (this.currentCornerArrow) {
        this.moveArrows('r');
      } else {
        if (this.images.length - 1 > this.imgIndex) {
          this.imgIndex++;
        }
        this.nextImage = this.images[this.imgIndex];
        this.changeImage(this.nextImage);
        console.log("Showing image: " + this.nextImage);
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.moveArrows('u');
    }
  };

  ngOnInit() {
    if (isPlatformBrowser(this.platformId)) {
      this.currentScreenHeight = window.innerHeight
      this.currentScreenWidth = window.innerWidth

      this.route.queryParams.subscribe((params: any) => {
        const tableId = params['tableId'];
        if (tableId && this.mockTableData[tableId]) {
          console.log("Loading data for table: " + tableId);
          const tableData = this.mockTableData[tableId];
          if (tableData.submodules.length > 0) {
            const firstSubmodule = tableData.submodules[0];
            if (firstSubmodule.status === 'waiting') {
              firstSubmodule.status = 'processing';
            }
            this.images = firstSubmodule.images;
            this.imgIndex = 0;
            if (this.images.length > 0) {
              this.nextImage = this.images[0];
              // changeImage will be called in ngAfterViewInit or manually here if view is ready 
              // but better to set nextImage and let init handle it or call changeImage if elements exist
            }
          }
        }
      });
    }
  }

  ngAfterViewInit() {
    // SSR/Prerender guard: this component is DOM-heavy and must not run on the server.
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }
    console.log("ngAfterViewInit START")
    var stream = ""
    var initialState = { targetCorners: [0, 0, this.currentScreenWidth, 0, 0, this.currentScreenHeight, this.currentScreenWidth, this.currentScreenHeight], sourceCorners: [] }
    console.log(initialState)
    this.markers.push(this.markertl, this.markertr, this.markerbl, this.markerbr)
    if (this.nextImage == "") {
      this.currentStream = stream;
    }

    var initialTargetCorners: any[] = [];
    var initialSourceCorners: any[] = [];

    // Priority 1: Use server calibration if available
    if (this.calibrationJson?.corners) {
      initialTargetCorners = this.calibrationJson.corners;
      console.log("Using server calibration", initialTargetCorners);
    }
    // Priority 2: Fallback to localStorage
    else if (isPlatformBrowser(this.platformId)) {
      const savedCorners = localStorage.getItem('mapper_corners');
      if (savedCorners) {
        try {
          initialTargetCorners = JSON.parse(savedCorners);
          console.log("Loaded calibration from LocalStorage", initialTargetCorners);
        } catch (e) {
          console.error("Error parsing saved calibration", e);
        }
      }
    }

    if (initialTargetCorners.length === 0 && initialState) {
      if (
        initialState.targetCorners &&
        initialState.targetCorners.length === 8
      ) {
        initialTargetCorners = initialState.targetCorners;
      }
      if (
        initialState.sourceCorners &&
        initialState.sourceCorners.length === 4
      ) {
        initialSourceCorners = initialState.sourceCorners;
      }
    }

    console.log(initialTargetCorners)

    // Only set src if we have an actual image to display
    // This prevents the browser from rendering a black/empty image box
    if (this.nextImage) {
      this.correctedVideo.nativeElement.src = this.nextImage;
    } else if (this.currentStream) {
      this.correctedVideo.nativeElement.src = this.currentStream;
    }
    // If neither exists, leave src unset to avoid black box

    this.buttonsContainer.nativeElement.height = this.previewPaddingSize;

    this.initCorners(initialTargetCorners);

    setInterval(this.updateResolution, 1000);

    this.scheduleUserInactive();

    this.correctedVideo.nativeElement.oncontextmenu = () => {
      return false;
    };
    this.correctedVideo.nativeElement.ondragstart = () => {
      return false;
    };
    this.markers.forEach(marker => {
      marker.nativeElement.style.visibility = this.calibrating ? "visible" : "hidden";
    });

    // Handle background tab throttling: force update when tab becomes visible
    this.document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.corners.length === 8) {
        console.log('[Mapper] Tab became visible, forcing update');
        this.update();
      }
    });
  };
};
