import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, TitleStrategy } from '@angular/router';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';

import { routes } from './app.routes';
import { reintentarSiArranca } from './services/reintentar.interceptor';
import { UserTitleStrategy } from './services/user-title.strategy';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideHttpClient(withFetch(), withInterceptors([reintentarSiArranca])),
    { provide: TitleStrategy, useClass: UserTitleStrategy }
  ]
};
