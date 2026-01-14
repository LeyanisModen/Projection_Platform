import { Routes } from '@angular/router';
import { Login } from './login/login';
import { Dashboard } from './dashboard/dashboard';
import { Mapper } from './mapper/mapper';
export const routes: Routes = [{
    path: '',
    component: Login,
    title: 'Login',
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