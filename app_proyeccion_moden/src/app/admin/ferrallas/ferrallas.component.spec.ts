import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { User } from '../../services/api.service';
import { FerrallasComponent } from './ferrallas.component';

const user = (id: number, username: string, bastidor?: number): User => ({
    id, username, url: `/api/users/${id}/`, first_name: '', last_name: '', email: '',
    groups: [], bastidor_longitud_cm: bastidor,
} as User);

function setup(queryParams: Record<string, string> = {}) {
    TestBed.configureTestingModule({
        imports: [FerrallasComponent],
        providers: [
            provideHttpClient(), provideHttpClientTesting(),
            {provide: ActivatedRoute, useValue: {snapshot: {queryParamMap: convertToParamMap(queryParams)}}},
        ],
    });
    const http = TestBed.inject(HttpTestingController);
    const fixture: ComponentFixture<FerrallasComponent> = TestBed.createComponent(FerrallasComponent);
    fixture.detectChanges();
    return {http, fixture};
}

/** Abrir una ferralla carga sus grupos de mesas y su configuracion de captura. */
function flushFerrallaDetail(http: HttpTestingController, id: number) {
    http.expectOne(`/api/grupos-mesas/?usuario=${id}`).flush({results: [], next: null, count: 0});
    http.expectOne(`/api/users/${id}/capture-config/`).flush({
        user_id: id, active_days: [], start_time: '07:00', end_time: '19:00',
        interval_seconds: 600, check_times: [], mesas: [],
    });
}

describe('FerrallasComponent', () => {
    afterEach(() => TestBed.resetTestingModule());

    it('abre la primera ferralla seleccionada con su detalle cargado', () => {
        const {http, fixture} = setup();
        http.expectOne('/api/users/').flush({results: [user(3, 'ferralia'), user(9, 'europapl5')], next: null, count: 2});
        fixture.detectChanges();
        expect(fixture.componentInstance.selectedUser?.id).toBe(3);
        flushFerrallaDetail(http, 3);
        http.verify();
        fixture.destroy();
    });

    it('abre la ferralla indicada en ?usuario con su detalle cargado', () => {
        const {http, fixture} = setup({usuario: '9'});
        http.expectOne('/api/users/').flush({results: [user(3, 'ferralia'), user(9, 'europapl5')], next: null, count: 2});
        fixture.detectChanges();
        expect(fixture.componentInstance.selectedUser?.id).toBe(9);
        flushFerrallaDetail(http, 9);
        http.verify();
        fixture.destroy();
    });

    it('sin ferrallas no selecciona nada ni pide detalle', () => {
        const {http, fixture} = setup();
        http.expectOne('/api/users/').flush({results: [], next: null, count: 0});
        fixture.detectChanges();
        expect(fixture.componentInstance.selectedUser).toBeNull();
        http.verify();
        fixture.destroy();
    });

    it('guarda la longitud del bastidor desde la ficha y refresca la lista', () => {
        const {http, fixture} = setup();
        http.expectOne('/api/users/').flush({results: [user(3, 'ferralia', 114)], next: null, count: 1});
        fixture.detectChanges();
        flushFerrallaDetail(http, 3);
        const component = fixture.componentInstance;

        component.startRackEdit();
        expect(component.rackDraft).toBe(114);
        component.rackDraft = 120.5;
        component.saveRackLength();

        const request = http.expectOne('/api/users/3/');
        expect(request.request.method).toBe('PATCH');
        expect(request.request.body).toEqual({bastidor_longitud_cm: 120.5});
        request.flush(user(3, 'ferralia', 120.5));

        expect(component.editingRack).toBe(false);
        expect(component.selectedUser?.bastidor_longitud_cm).toBe(120.5);
        expect(component.users[0].bastidor_longitud_cm).toBe(120.5);
        http.verify();
        fixture.destroy();
    });

    it('rechaza longitudes no positivas sin llamar a la API', () => {
        const {http, fixture} = setup();
        http.expectOne('/api/users/').flush({results: [user(3, 'ferralia', 114)], next: null, count: 1});
        fixture.detectChanges();
        flushFerrallaDetail(http, 3);
        const component = fixture.componentInstance;

        component.startRackEdit();
        component.rackDraft = 0;
        component.saveRackLength();

        http.expectNone('/api/users/3/');
        expect(component.rackError).toContain('mayor que 0');
        expect(component.editingRack).toBe(true);
        http.verify();
        fixture.destroy();
    });
});
