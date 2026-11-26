import { Routes } from '@angular/router';
import { AdminLayoutComponent } from './admin-layout/admin-layout.component';
import { FerrallasComponent } from './ferrallas/ferrallas.component';
import { ProyectosComponent } from './proyectos/proyectos.component';
import { AdminGuard } from '../guards/admin.guard';

export const ADMIN_ROUTES: Routes = [
    {
        path: '',
        component: AdminLayoutComponent,
        canActivate: [AdminGuard],
        children: [
            { path: '', redirectTo: 'proyectos', pathMatch: 'full' },
            { path: 'proyectos', component: ProyectosComponent, title: 'Admin - Proyectos' },
            { path: 'ferrallas', component: FerrallasComponent, title: 'Admin - Ferrallas' },
            { path: 'seguimiento', loadComponent: () => import('./seguimiento/seguimiento.component').then(m => m.SeguimientoComponent), title: 'Admin - Seguimiento' },
            // Dos pestanas: la 1, el minimo de siempre; la 2, con el patio y los camiones.
            { path: 'planificacion', loadComponent: () => import('./planificacion/planificacion.component').then(m => m.PlanificacionComponent), data: { vista: 1 }, title: 'Admin - Planificación 1' },
            { path: 'planificacion-2', loadComponent: () => import('./planificacion/planificacion.component').then(m => m.PlanificacionComponent), data: { vista: 2 }, title: 'Admin - Planificación 2' },
            { path: 'calendario', loadComponent: () => import('./calendario/calendario.component').then(m => m.CalendarioComponent), title: 'Admin - Calendario' },
            { path: 'lista-control', loadComponent: () => import('./lista-control/lista-control.component').then(m => m.ListaControlComponent), title: 'Admin - Lista de control' },
            {
                path: 'proyectos/:id',
                loadComponent: () => import('./proyectos/detalle/detalle.component').then(m => m.ProyectoDetailComponent),
                title: 'Admin - Detalle Proyecto'
            }
        ]
    }
];
