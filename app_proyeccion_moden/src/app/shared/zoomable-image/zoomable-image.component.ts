import {
    ChangeDetectionStrategy,
    Component,
    DestroyRef,
    ElementRef,
    afterNextRender,
    computed,
    effect,
    inject,
    input,
    signal,
    untracked,
    viewChild,
} from '@angular/core';

interface Point {
    x: number;
    y: number;
}

interface PinchState {
    distance: number;
    zoom: number;
    panX: number;
    panY: number;
    center: Point;
}

@Component({
    selector: 'app-zoomable-image',
    templateUrl: './zoomable-image.component.html',
    styleUrls: ['./zoomable-image.component.css'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ZoomableImageComponent {
    private static readonly MIN_ZOOM = 1;
    private static readonly MAX_ZOOM = 4;
    private static readonly ZOOM_STEP = 0.25;
    private static readonly KEYBOARD_PAN_STEP = 48;

    readonly src = input.required<string>();
    readonly alt = input('Imagen');
    readonly viewerLabel = input('Visor de imagen ampliable');
    readonly resetKey = input<unknown>(null);

    readonly zoom = signal(ZoomableImageComponent.MIN_ZOOM);
    readonly panX = signal(0);
    readonly panY = signal(0);
    readonly dragging = signal(false);
    readonly zoomPercent = computed(() => Math.round(this.zoom() * 100));
    readonly canZoomOut = computed(() => this.zoom() > ZoomableImageComponent.MIN_ZOOM);
    readonly canZoomIn = computed(() => this.zoom() < ZoomableImageComponent.MAX_ZOOM);
    readonly imageTransform = computed(
        () => `translate3d(${this.panX()}px, ${this.panY()}px, 0) scale(${this.zoom()})`,
    );

    private readonly destroyRef = inject(DestroyRef);
    private readonly viewport = viewChild.required<ElementRef<HTMLDivElement>>('viewport');
    private readonly image = viewChild<ElementRef<HTMLImageElement>>('image');
    private readonly pointers = new Map<number, Point>();
    private dragOrigin: Point | null = null;
    private dragPanOrigin: Point = { x: 0, y: 0 };
    private pinchState: PinchState | null = null;

    constructor() {
        effect(() => {
            this.src();
            this.resetKey();
            untracked(() => this.reset());
        });

        afterNextRender(() => {
            if (typeof ResizeObserver === 'undefined') return;
            const observer = new ResizeObserver(() => this.constrainPan());
            observer.observe(this.viewport().nativeElement);
            this.destroyRef.onDestroy(() => observer.disconnect());
        });
    }

    zoomIn(): void {
        this.setZoom(this.zoom() + ZoomableImageComponent.ZOOM_STEP);
    }

    zoomOut(): void {
        this.setZoom(this.zoom() - ZoomableImageComponent.ZOOM_STEP);
    }

    reset(): void {
        this.zoom.set(ZoomableImageComponent.MIN_ZOOM);
        this.panX.set(0);
        this.panY.set(0);
        this.dragging.set(false);
        this.pointers.clear();
        this.dragOrigin = null;
        this.pinchState = null;
    }

    onImageLoad(): void {
        this.reset();
    }

    onWheel(event: WheelEvent): void {
        event.preventDefault();
        const direction = event.deltaY < 0 ? 1 : -1;
        this.setZoom(
            this.zoom() + direction * ZoomableImageComponent.ZOOM_STEP,
            { x: event.clientX, y: event.clientY },
        );
    }

    onDoubleClick(event: MouseEvent): void {
        event.preventDefault();
        if (this.zoom() > ZoomableImageComponent.MIN_ZOOM) {
            this.reset();
            return;
        }
        this.setZoom(2, { x: event.clientX, y: event.clientY });
    }

    onKeyDown(event: KeyboardEvent): void {
        switch (event.key) {
            case '+':
            case '=':
                event.preventDefault();
                this.zoomIn();
                break;
            case '-':
            case '_':
                event.preventDefault();
                this.zoomOut();
                break;
            case '0':
                event.preventDefault();
                this.reset();
                break;
            case 'ArrowLeft':
                this.panWithKeyboard(event, ZoomableImageComponent.KEYBOARD_PAN_STEP, 0);
                break;
            case 'ArrowRight':
                this.panWithKeyboard(event, -ZoomableImageComponent.KEYBOARD_PAN_STEP, 0);
                break;
            case 'ArrowUp':
                this.panWithKeyboard(event, 0, ZoomableImageComponent.KEYBOARD_PAN_STEP);
                break;
            case 'ArrowDown':
                this.panWithKeyboard(event, 0, -ZoomableImageComponent.KEYBOARD_PAN_STEP);
                break;
        }
    }

    onPointerDown(event: PointerEvent): void {
        if (event.pointerType === 'mouse' && event.button !== 0) return;

        this.viewport().nativeElement.focus({ preventScroll: true });
        this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (event.currentTarget instanceof HTMLElement) {
            event.currentTarget.setPointerCapture(event.pointerId);
        }

        if (this.pointers.size >= 2) {
            this.beginPinch();
            return;
        }

        this.dragOrigin = { x: event.clientX, y: event.clientY };
        this.dragPanOrigin = { x: this.panX(), y: this.panY() };
        this.dragging.set(this.zoom() > ZoomableImageComponent.MIN_ZOOM);
    }

    onPointerMove(event: PointerEvent): void {
        if (!this.pointers.has(event.pointerId)) return;
        this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

        if (this.pointers.size >= 2) {
            this.updatePinch();
            return;
        }

        if (!this.dragOrigin || this.zoom() <= ZoomableImageComponent.MIN_ZOOM) return;
        this.setPan(
            this.dragPanOrigin.x + event.clientX - this.dragOrigin.x,
            this.dragPanOrigin.y + event.clientY - this.dragOrigin.y,
        );
    }

    onPointerEnd(event: PointerEvent): void {
        this.pointers.delete(event.pointerId);

        if (this.pointers.size === 1) {
            const point = [...this.pointers.values()][0];
            this.dragOrigin = point;
            this.dragPanOrigin = { x: this.panX(), y: this.panY() };
            this.pinchState = null;
            this.dragging.set(this.zoom() > ZoomableImageComponent.MIN_ZOOM);
            return;
        }

        if (this.pointers.size === 0) {
            this.dragOrigin = null;
            this.pinchState = null;
            this.dragging.set(false);
        }
    }

    private setZoom(nextZoom: number, focalPoint?: Point): void {
        const oldZoom = this.zoom();
        const zoom = this.clampZoom(nextZoom);
        if (zoom === oldZoom) return;

        if (zoom === ZoomableImageComponent.MIN_ZOOM) {
            this.reset();
            return;
        }

        let nextPanX = this.panX() * (zoom / oldZoom);
        let nextPanY = this.panY() * (zoom / oldZoom);

        if (focalPoint) {
            const bounds = this.viewport().nativeElement.getBoundingClientRect();
            const focalX = focalPoint.x - bounds.left - bounds.width / 2;
            const focalY = focalPoint.y - bounds.top - bounds.height / 2;
            nextPanX = focalX - ((focalX - this.panX()) / oldZoom) * zoom;
            nextPanY = focalY - ((focalY - this.panY()) / oldZoom) * zoom;
        }

        this.zoom.set(zoom);
        this.setPan(nextPanX, nextPanY);
    }

    private setPan(x: number, y: number): void {
        const limits = this.panLimits();
        this.panX.set(Math.max(-limits.x, Math.min(limits.x, x)));
        this.panY.set(Math.max(-limits.y, Math.min(limits.y, y)));
    }

    private constrainPan(): void {
        this.setPan(this.panX(), this.panY());
    }

    private panLimits(): Point {
        const viewport = this.viewport().nativeElement;
        const image = this.image()?.nativeElement;
        if (!image) return { x: 0, y: 0 };

        return {
            x: Math.max(0, (image.offsetWidth * this.zoom() - viewport.clientWidth) / 2),
            y: Math.max(0, (image.offsetHeight * this.zoom() - viewport.clientHeight) / 2),
        };
    }

    private panWithKeyboard(event: KeyboardEvent, x: number, y: number): void {
        if (this.zoom() <= ZoomableImageComponent.MIN_ZOOM) return;
        event.preventDefault();
        this.setPan(this.panX() + x, this.panY() + y);
    }

    private beginPinch(): void {
        const [first, second] = [...this.pointers.values()];
        this.pinchState = {
            distance: Math.max(1, this.distance(first, second)),
            zoom: this.zoom(),
            panX: this.panX(),
            panY: this.panY(),
            center: this.midpoint(first, second),
        };
        this.dragging.set(true);
    }

    private updatePinch(): void {
        if (!this.pinchState) this.beginPinch();
        if (!this.pinchState) return;

        const [first, second] = [...this.pointers.values()];
        const center = this.midpoint(first, second);
        const zoom = this.clampZoom(
            this.pinchState.zoom * this.distance(first, second) / this.pinchState.distance,
        );
        const bounds = this.viewport().nativeElement.getBoundingClientRect();
        const startCenterX = this.pinchState.center.x - bounds.left - bounds.width / 2;
        const startCenterY = this.pinchState.center.y - bounds.top - bounds.height / 2;
        const currentCenterX = center.x - bounds.left - bounds.width / 2;
        const currentCenterY = center.y - bounds.top - bounds.height / 2;
        const imagePointX = (startCenterX - this.pinchState.panX) / this.pinchState.zoom;
        const imagePointY = (startCenterY - this.pinchState.panY) / this.pinchState.zoom;

        this.zoom.set(zoom);
        this.setPan(
            currentCenterX - imagePointX * zoom,
            currentCenterY - imagePointY * zoom,
        );
    }

    private clampZoom(zoom: number): number {
        const rounded = Math.round(zoom * 100) / 100;
        return Math.max(
            ZoomableImageComponent.MIN_ZOOM,
            Math.min(ZoomableImageComponent.MAX_ZOOM, rounded),
        );
    }

    private distance(first: Point, second: Point): number {
        return Math.hypot(second.x - first.x, second.y - first.y);
    }

    private midpoint(first: Point, second: Point): Point {
        return {
            x: (first.x + second.x) / 2,
            y: (first.y + second.y) / 2,
        };
    }
}
