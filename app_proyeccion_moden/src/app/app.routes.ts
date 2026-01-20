import { Routes } from '@angular/router';
import { Login } from './login/login';
import { Dashboard } from './dashboard/dashboard';
import { Mapper } from './mapper/mapper';
import { VisorComponent } from './visor/visor.component';

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
},
{
  path: 'mapper',
  component: Mapper,
  title: 'Mapper',
},
];


export default routes;