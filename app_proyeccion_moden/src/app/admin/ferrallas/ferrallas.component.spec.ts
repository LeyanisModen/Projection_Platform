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

    it('la ficha arranca sin cambios y solo se puede guardar cuando algo cambia', () => {
        const {http, fixture} = setup();
        http.expectOne('/api/users/').flush({results: [user(3, 'ferralia', 114)], next: null, count: 1});
        fixture.detectChanges();
        flushFerrallaDetail(http, 3);
        const component = fixture.componentInstance;

        expect(component.fichaDirty).toBe(false);
        component.ficha!.bastidor_longitud_cm = 120.5;
        expect(component.fichaDirty).toBe(true);
        component.discardFicha();
        expect(component.fichaDirty).toBe(false);
        expect(component.ficha?.bastidor_longitud_cm).toBe(114);
        http.verify();
        fixture.destroy();
    });

    it('guarda la ficha completa con PATCH y refresca la lista', () => {
        const {http, fixture} = setup();
        http.expectOne('/api/users/').flush({results: [user(3, 'ferralia', 114)], next: null, count: 1});
        fixture.detectChanges();
        flushFerrallaDetail(http, 3);
        const component = fixture.componentInstance;

        component.ficha!.first_name = 'Ferralia SL';
        component.ficha!.bastidor_longitud_cm = 120.5;
        component.addFichaContacto();
        component.ficha!.contactos[0].nombre = 'Ana';
        component.ficha!.contactos[0].telefono = ' 600 ';
        component.saveFicha();

        const request = http.expectOne('/api/users/3/');
        expect(request.request.method).toBe('PATCH');
        expect(request.request.body).toEqual({
            first_name: 'Ferralia SL', username: 'ferralia', bastidor_longitud_cm: 120.5,
            contactos: [{nombre: 'Ana', cargo: '', telefono: '600', email: '', orden: 0}],
            direcciones: [],
        });
        request.flush({...user(3, 'ferralia', 120.5), first_name: 'Ferralia SL'});

        expect(component.fichaDirty).toBe(false);
        expect(component.selectedUser?.bastidor_longitud_cm).toBe(120.5);
        expect(component.users[0].first_name).toBe('Ferralia SL');
        http.verify();
        fixture.destroy();
    });

    it('rechaza bastidor no positivo sin llamar a la API', () => {
        const {http, fixture} = setup();
        http.expectOne('/api/users/').flush({results: [user(3, 'ferralia', 114)], next: null, count: 1});
        fixture.detectChanges();
        flushFerrallaDetail(http, 3);
        const component = fixture.componentInstance;

        component.ficha!.bastidor_longitud_cm = 0;
        component.saveFicha();

        http.expectNone('/api/users/3/');
        expect(component.fichaError).toContain('mayor que 0');
        http.verify();
        fixture.destroy();
    });
});
