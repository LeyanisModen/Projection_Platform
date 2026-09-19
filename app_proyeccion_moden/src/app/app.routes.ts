import { Routes } from '@angular/router';
import { Login } from './login/login';
import { AuthGuard } from './guards/auth.guard';
import { AdminGuard } from './guards/admin.guard';

// Only the login screen ships in the initial bundle. Dashboard, visor and
// mapper are loaded on demand so the mini-PC player never downloads the
// client dashboard and vice versa.
export const routes: Routes = [{
  path: '',
  component: Login,
  title: 'Login',
},
{
  path: 'visor/:id',
  loadComponent: () => import('./visor/visor.component').then(m => m.VisorComponent),
  title: 'Visor Mesa',
},
{
  path: 'player',
  loadComponent: () => import('./visor/visor.component').then(m => m.VisorComponent),
  title: 'Visor Player',
},
{
  // Second screen of a mini-PC: read-only mirror of the player (see MonitorComponent).
  path: 'monitor',
  loadComponent: () => import('./monitor/monitor.component').then(m => m.MonitorComponent),
  title: 'Monitor Mesa',
},
{
  path: 'dashboard',
  loadComponent: () => import('./dashboard/dashboard').then(m => m.Dashboard),
  title: 'Dashboard',
  canActivate: [AuthGuard],
},
{
  path: 'admin-dashboard',
  loadChildren: () => import('./admin/admin.routes').then(m => m.ADMIN_ROUTES),
  title: 'Admin Dashboard',
  canActivate: [AdminGuard],
},
{
  path: 'mapper',
  loadComponent: () => import('./mapper/mapper').then(m => m.Mapper),
  title: 'Mapper',
  canActivate: [AuthGuard],
},
];


export default routes;
