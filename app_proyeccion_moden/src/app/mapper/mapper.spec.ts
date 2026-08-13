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
});
