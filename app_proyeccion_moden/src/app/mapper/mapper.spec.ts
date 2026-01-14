import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Mapper } from './mapper';

describe('Mapper', () => {
  let component: Mapper;
  let fixture: ComponentFixture<Mapper>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Mapper]
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
