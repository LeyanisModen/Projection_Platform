import { Injectable } from '@angular/core';
import { Router, CanActivate, ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import { ApiService } from '../services/api.service';

@Injectable({
    providedIn: 'root'
})
export class AuthGuard implements CanActivate {

    constructor(private router: Router, private api: ApiService) { }

    canActivate(route: ActivatedRouteSnapshot, state: RouterStateSnapshot): boolean {
        if (this.api.isLoggedIn()) {
            return true;
        }

        // Not logged in so redirect to login page
        this.router.navigate(['/'], { queryParams: { returnUrl: state.url } });
        return false;
    }
}
