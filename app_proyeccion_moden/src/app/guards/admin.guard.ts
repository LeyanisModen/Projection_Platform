import { Injectable } from '@angular/core';
import { Router, CanActivate, ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import { ApiService } from '../services/api.service';

@Injectable({
    providedIn: 'root'
})
export class AdminGuard implements CanActivate {

    constructor(private router: Router, private api: ApiService) { }

    canActivate(route: ActivatedRouteSnapshot, state: RouterStateSnapshot): boolean {
        if (this.api.isLoggedIn()) {
            // Check if user is admin
            const isStaff = localStorage.getItem('is_staff') === 'true';
            const isSuperuser = localStorage.getItem('is_superuser') === 'true';

            if (isStaff || isSuperuser) {
                return true;
            }

            // Logged in but not admin, redirect to main dashboard
            this.router.navigate(['/dashboard']);
            return false;
        }

        // Not logged in so redirect to login page
        this.router.navigate(['/'], { queryParams: { returnUrl: state.url } });
        return false;
    }
}
