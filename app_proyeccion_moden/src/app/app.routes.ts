import { Routes } from '@angular/router';
import { Login } from './login/login';
import { Dashboard } from './dashboard/dashboard';
import { Mapper } from './mapper/mapper';
import { VisorComponent } from './visor/visor.component';
import { AuthGuard } from './guards/auth.guard';
import { AdminGuard } from './guards/admin.guard';

export const routes: Routes = [{
  path: '',
  component: Login,
  title: 'Login',
},
{
  path: 'visor/:id',
  component: VisorComponent,
  title: 'Visor Mesa',
},
{
  path: 'player',
  component: VisorComponent,
  title: 'Visor Player',
},
{
  path: 'dashboard',
  component: Dashboard,
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
  component: Mapper,
  title: 'Mapper',
  canActivate: [AuthGuard],
},
];


export default routes;