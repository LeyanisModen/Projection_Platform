import { Title } from '@angular/platform-browser';
import { Injectable, inject } from '@angular/core';
import { RouterStateSnapshot, TitleStrategy } from '@angular/router';


@Injectable()
export class UserTitleStrategy extends TitleStrategy {
  private readonly documentTitle = inject(Title);

  override updateTitle(snapshot: RouterStateSnapshot): void {
    const routeTitle = this.buildTitle(snapshot) || 'MOD:EN';
    const username = this.getUsername();
    const title = username && routeTitle !== 'Login'
      ? `${username} | ${routeTitle}`
      : routeTitle;

    this.documentTitle.setTitle(title);
  }

  private getUsername(): string | null {
    if (typeof localStorage === 'undefined') {
      return null;
    }
    return localStorage.getItem('auth_username');
  }
}
