import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { ApiService, Modulo } from './api.service';

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
