import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ZoomableImageComponent } from './zoomable-image.component';

describe('ZoomableImageComponent', () => {
    let fixture: ComponentFixture<ZoomableImageComponent>;
    let component: ZoomableImageComponent;

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [ZoomableImageComponent],
        }).compileComponents();

        fixture = TestBed.createComponent(ZoomableImageComponent);
        fixture.componentRef.setInput('src', '/foto.jpg');
        fixture.detectChanges();
        component = fixture.componentInstance;
    });

    it('starts at one hundred percent', () => {
        expect(component.zoom()).toBe(1);
        expect(component.zoomPercent()).toBe(100);
        expect(component.panX()).toBe(0);
        expect(component.panY()).toBe(0);
    });

    it('keeps zoom inside the supported range', () => {
        for (let index = 0; index < 20; index++) component.zoomIn();
        expect(component.zoom()).toBe(4);

        for (let index = 0; index < 20; index++) component.zoomOut();
        expect(component.zoom()).toBe(1);
    });

    it('resets zoom when the displayed photo changes', () => {
        component.zoomIn();
        component.zoomIn();
        expect(component.zoom()).toBe(1.5);

        fixture.componentRef.setInput('resetKey', 2);
        fixture.detectChanges();

        expect(component.zoom()).toBe(1);
        expect(component.panX()).toBe(0);
        expect(component.panY()).toBe(0);
    });

    it('supports keyboard zoom and reset', () => {
        const viewport = fixture.nativeElement.querySelector('.zoomable-image-viewport') as HTMLElement;
        viewport.dispatchEvent(new KeyboardEvent('keydown', { key: '+' }));
        expect(component.zoom()).toBe(1.25);

        viewport.dispatchEvent(new KeyboardEvent('keydown', { key: '0' }));
        expect(component.zoom()).toBe(1);
    });
});
