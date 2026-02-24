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
            { path: '', redirectTo: 'ferrallas', pathMatch: 'full' },
            { path: 'ferrallas', component: FerrallasComponent, title: 'Admin - Ferrallas' },
            { path: 'proyectos', component: ProyectosComponent, title: 'Admin - Proyectos' },
            {
                path: 'proyectos/:id',
                loadComponent: () => import('./proyectos/detalle/detalle.component').then(m => m.ProyectoDetailComponent),
                title: 'Admin - Detalle Proyecto'
            }
        ]
    }
];
