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
    http.expectOne(`/api/pausas-mesa/?usuario=${id}`).flush([]);
    http.expectOne(`/api/users/${id}/capture-config/`).flush({
        user_id: id, active_days: [], start_time: '07:00', end_time: '19:00', horario: [],
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
    it('pausa varias mesas a la vez, las muestra en su fila y las reanuda', () => {
        const {http, fixture} = setup();
        http.expectOne('/api/users/').flush({results: [user(2, 'sancho')], next: null, count: 1});
        const mesa = (id: number, indice: number) => ({id, nombre: `Mesa ${indice}`, tipo: 'INFERIOR', indice, activa: true, is_linked: true});
        http.expectOne('/api/grupos-mesas/?usuario=2').flush({results: [{
            id: 9, nombre: 'Línea 1', usuario: 2, activa: true, mesas: [mesa(31, 1), mesa(32, 2), mesa(33, 3)], proyectos_cola: [],
        }], next: null, count: 1});
        http.expectOne('/api/pausas-mesa/?usuario=2').flush([{
            id: 5, mesa: 31, tipo: 'DIARIA', motivo: 'Luz de las ventanas', inicio: '2026-11-04T20:00:00+01:00', fin: null,
            hora_desde: '13:00', hora_hasta: '16:00', activa: false,
        }]);
        http.expectOne('/api/users/2/capture-config/').flush({
            user_id: 2, active_days: [], start_time: '07:00', end_time: '19:00', horario: [],
            interval_seconds: 600, check_times: [], mesas: [],
        });
        fixture.detectChanges();
        const el: HTMLElement = fixture.nativeElement;
        expect(el.querySelector('.mesa-pausa-pill')!.textContent).toContain('Pausa cada día 13:00-16:00');

        (el.querySelector('.pausar-mesas-btn') as HTMLButtonElement).click();
        fixture.detectChanges();
        const marcas = () => Array.from(el.querySelectorAll('.pausa-mesas input')) as HTMLInputElement[];
        expect(marcas().map(m => m.checked)).toEqual([true, true, true]);
        // La de la formación sigue.
        marcas()[2].click();
        const component = fixture.componentInstance;
        component.pausaMotivo = ' Formación ';
        component.pausaHasta = '';
        (el.querySelector('.pausa-guardar') as HTMLButtonElement).click();
        const crear = http.expectOne('/api/pausas-mesa/');
        expect(crear.request.body).toEqual({mesas: [31, 32], motivo: 'Formación', tipo: 'PUNTUAL', fin: null});
        crear.flush([]);
        http.expectOne('/api/pausas-mesa/?usuario=2').flush([]);
        http.expectOne('/api/grupos-mesas/?usuario=2').flush({results: [], next: null, count: 0});

        // Cada dia, con una mesa: solo esa.
        component.openPausaModal(component.gruposMesas[0]?.mesas[0] ?? {id: 31} as any);
        component.pausaCuando = 'CADA_DIA';
        component.pausaDesdeHora = '13:00';
        component.pausaHastaHora = '13:00';
        component.guardarPausa();
        expect(component.pausaError).toBe('Pon a qué hora empieza y a qué hora acaba.');
        component.pausaHastaHora = '16:00';
        component.guardarPausa();
        expect(http.expectOne('/api/pausas-mesa/').request.body).toEqual({
            mesas: [31], motivo: '', tipo: 'DIARIA', hora_desde: '13:00', hora_hasta: '16:00',
        });

        vi.spyOn(window, 'confirm').mockReturnValue(true);
        component.terminarPausa({id: 5, mesa: 31, tipo: 'DIARIA', motivo: '', inicio: '', fin: null, hora_desde: '13:00', hora_hasta: '16:00', activa: false});
        expect(http.expectOne('/api/pausas-mesa/5/terminar/').request.method).toBe('POST');
    });
});
