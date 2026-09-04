import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { ApiService, Modulo, Proyecto } from './api.service';

describe('ApiService', () => {
    let service: ApiService;
    let httpTesting: HttpTestingController;

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [
                ApiService,
                provideHttpClient(),
                provideHttpClientTesting(),
            ],
        });
        service = TestBed.inject(ApiService);
        httpTesting = TestBed.inject(HttpTestingController);
    });

    afterEach(() => httpTesting.verify());

    it('loads all project pages for calendar and combined deadline demand without mixed content', () => {
        let received: Proyecto[] = [];
        service.getProyectos().subscribe(projects => received = projects);
        httpTesting.expectOne('/api/proyectos/').flush({
            count: 2, next: 'http://backend.example/api/proyectos/?page=2',
            previous: null, results: [{id: 1}],
        });
        expect(received).toEqual([]);
        httpTesting.expectOne('/api/proyectos/?page=2').flush({
            count: 2, next: null, previous: '/api/proyectos/', results: [{id: 2}],
        });
        expect(received.map(p => p.id)).toEqual([1, 2]);
    });

    it('loads every module page before returning a project module list', () => {
        const firstPage = Array.from({ length: 100 }, (_, index) => ({
            id: index + 1,
            nombre: `A${index + 1}`,
        })) as Modulo[];
        const recreatedModule = { id: 101, nombre: 'F12' } as Modulo;
        let received: Modulo[] = [];

        service.getModulos(7).subscribe(modulos => received = modulos);

        httpTesting.expectOne('/api/modulos/?proyecto=7').flush({
            count: 101,
            next: 'http://projectionplatform-production.up.railway.app/api/modulos/?page=2&proyecto=7',
            previous: null,
            results: firstPage,
        });
        httpTesting.expectOne(
            '/api/modulos/?page=2&proyecto=7'
        ).flush({
            count: 101,
            next: null,
            previous: '/api/modulos/?proyecto=7',
            results: [recreatedModule],
        });

        expect(received).toHaveLength(101);
        expect(received.at(-1)?.nombre).toBe('F12');
    });
});
