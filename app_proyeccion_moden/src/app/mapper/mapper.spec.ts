import { SimpleChange } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';

import { Mapper } from './mapper';

describe('Mapper', () => {
  let component: Mapper;
  let fixture: ComponentFixture<Mapper>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Mapper],
      providers: [provideHttpClient(), provideRouter([])]
    })
    .compileComponents();

    fixture = TestBed.createComponent(Mapper);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('shows the image flat in plain view and warps it again when calibrating', () => {
    fixture.detectChanges();
    const main: HTMLElement = fixture.nativeElement.querySelector('main');
    const surface: HTMLElement = fixture.nativeElement.querySelector('#sourceIframe');

    component.plainView = true;
    component.ngOnChanges({ plainView: new SimpleChange(false, true, false) });
    component.calibrationJson = { corners: [10, 10, 800, 0, 0, 600, 790, 610] };
    expect(main.classList.contains('plain-view')).toBe(true);
    expect(surface.style.transform).toBe('none');

    component.plainView = false;
    component.ngOnChanges({ plainView: new SimpleChange(true, false, false) });
    expect(main.classList.contains('plain-view')).toBe(false);
    expect(surface.style.transform.startsWith('matrix3d(')).toBe(true);
  });
});
