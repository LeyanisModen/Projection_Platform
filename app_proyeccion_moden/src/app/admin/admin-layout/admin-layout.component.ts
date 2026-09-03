import { Component, inject } from '@angular/core';
import { Router, RouterModule } from '@angular/router';

import { ApiService } from '../../services/api.service';

@Component({
  selector: 'app-admin-layout',
  imports: [RouterModule],
  template: `
    <div class="admin-container">
      <header class="admin-header">
        <a class="brand" routerLink="/admin-dashboard/proyectos" aria-label="Ir a Proyectos">
          <img src="assets/logo-moden.jpg" alt="MOD:EN" class="header-logo" />
          <span class="subtitle">Administracion de la plataforma</span>
        </a>

        <nav class="header-nav" aria-label="Secciones de administracion">
          <a
            routerLink="/admin-dashboard/proyectos"
            routerLinkActive="active"
            ariaCurrentWhenActive="page"
          >
            Proyectos
          </a>
          <a
            routerLink="/admin-dashboard/ferrallas"
            routerLinkActive="active"
            ariaCurrentWhenActive="page"
          >
            Ferrallas
          </a>
        </nav>

        <div class="header-right">
          <span class="user-display">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            <span>Usuario {{ username }}</span>
          </span>
          <button
            type="button"
            class="logout-button"
            (click)="logout()"
            title="Cerrar sesion"
            aria-label="Cerrar sesion"
          >
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" x2="9" y1="12" y2="12" />
            </svg>
          </button>
        </div>
      </header>

      <main class="admin-content">
        <router-outlet />
      </main>
    </div>
  `,
  styles: `
    :host {
      --header-height: 64px;
      --card-bg: #ffffff;
      --text-primary: #1a1a2e;
      --text-secondary: #6b6b7b;
      --accent-orange: #f0640f;
      --border-light: #e0e0e0;

      display: block;
      height: 100vh;
      overflow: hidden;
      color: var(--text-primary);
    }

    .admin-container {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: #f0f2f5;
    }

    .admin-header {
      position: relative;
      z-index: 20;
      display: grid;
      grid-template-columns: minmax(260px, 1fr) auto minmax(260px, 1fr);
      align-items: center;
      gap: 24px;
      height: var(--header-height);
      padding: 0 24px;
      flex-shrink: 0;
      background: var(--card-bg);
      border-bottom: 1px solid var(--border-light);
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.02);
      box-sizing: border-box;
    }

    .brand {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 16px;
      color: inherit;
      text-decoration: none;
    }

    .header-logo {
      height: 40px;
      border-radius: 6px;
      flex-shrink: 0;
    }

    .subtitle {
      overflow: hidden;
      color: var(--text-secondary);
      font-size: 0.9rem;
      font-weight: 500;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .header-nav {
      display: flex;
      align-items: stretch;
      align-self: stretch;
      gap: 28px;
    }

    .header-nav a {
      position: relative;
      display: flex;
      align-items: center;
      border: 0;
      color: var(--text-secondary);
      font-size: 0.95rem;
      font-weight: 600;
      text-decoration: none;
      transition: color 160ms ease;
    }

    .header-nav a::after {
      position: absolute;
      right: 0;
      bottom: 0;
      left: 0;
      height: 3px;
      border-radius: 3px 3px 0 0;
      background: var(--accent-orange);
      content: '';
      opacity: 0;
      transform: scaleX(0.55);
      transition: opacity 160ms ease, transform 160ms ease;
    }

    .header-nav a:hover,
    .header-nav a.active {
      color: var(--accent-orange);
    }

    .header-nav a.active::after {
      opacity: 1;
      transform: scaleX(1);
    }

    .header-nav a:focus-visible,
    .brand:focus-visible,
    .logout-button:focus-visible {
      outline: 2px solid var(--accent-orange);
      outline-offset: 4px;
    }

    .header-right {
      min-width: 0;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 15px;
    }

    .user-display {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--text-secondary);
      font-size: 0.9rem;
      font-weight: 500;
      white-space: nowrap;
    }

    .user-display span {
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .logout-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 4px;
      border: 0;
      background: none;
      color: var(--text-secondary);
      cursor: pointer;
      transition: color 160ms ease;
    }

    .logout-button:hover {
      color: var(--accent-orange);
    }

    .admin-content {
      min-height: 0;
      flex: 1;
      padding: 1.5rem;
      overflow-y: auto;
      box-sizing: border-box;
    }

    @media (max-width: 900px) {
      .admin-header {
        grid-template-columns: auto 1fr auto;
        gap: 18px;
      }

      .subtitle {
        display: none;
      }

      .header-nav {
        justify-content: center;
      }

      .user-display span {
        display: none;
      }
    }

    @media (max-width: 560px) {
      :host {
        --header-height: 58px;
      }

      .admin-header {
        gap: 12px;
        padding: 0 12px;
      }

      .header-logo {
        width: 86px;
        height: auto;
      }

      .header-nav {
        gap: 14px;
      }

      .header-nav a {
        font-size: 0.84rem;
      }

      .user-display {
        display: none;
      }

      .admin-content {
        padding: 1rem 0.75rem;
      }
    }
  `,
})
export class AdminLayoutComponent {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);

  readonly username = this.api.getUsername() || 'Administrador';

  logout(): void {
    this.api.logout();
    this.router.navigate(['/']);
  }
}
