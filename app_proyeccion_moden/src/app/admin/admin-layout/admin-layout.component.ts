import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';

@Component({
  selector: 'app-admin-layout',
  standalone: true,
  imports: [CommonModule, RouterModule],
  template: `
    <div class="admin-container">
      <nav class="sidebar" [class.expanded]="sidebarExpanded" 
           (mouseenter)="sidebarExpanded = true" 
           (mouseleave)="sidebarExpanded = false">
        <div class="brand">
          <span class="brand-icon">⚙️</span>
          <span class="brand-text">Admin Panel</span>
        </div>
        <ul class="nav-links">
          <li>
            <a routerLink="/admin-dashboard/ferrallas" routerLinkActive="active" title="Ferrallas">
              <span class="icon">👷</span>
              <span class="link-text">Ferrallas</span>
            </a>
          </li>
          <li>
            <a routerLink="/admin-dashboard/proyectos" routerLinkActive="active" title="Proyectos">
              <span class="icon">🏗️</span>
              <span class="link-text">Proyectos</span>
            </a>
          </li>
        </ul>
        <div class="user-info">
          <span class="user-icon">👤</span>
          <span class="user-text">Logueado como Admin</span>
        </div>
      </nav>
      <main class="content">
        <router-outlet></router-outlet>
      </main>
    </div>
  `,
  styles: [`
    .admin-container {
      display: flex;
      height: 100vh;
      background-color: #f5f5f5;
    }
    .sidebar {
      width: 60px;
      min-width: 60px;
      background-color: #fff;
      border-right: 1px solid #ddd;
      display: flex;
      flex-direction: column;
      padding: 0.75rem 0.5rem;
      transition: width 0.25s ease, min-width 0.25s ease;
      overflow: hidden;
    }
    .sidebar.expanded {
      width: 200px;
      min-width: 200px;
    }
    .brand {
      display: flex;
      align-items: center;
      padding: 0.5rem;
      margin-bottom: 1rem;
      white-space: nowrap;
    }
    .brand-icon {
      font-size: 1.5rem;
      flex-shrink: 0;
    }
    .brand-text {
      margin-left: 0.75rem;
      font-weight: 600;
      color: #333;
      font-size: 1rem;
      opacity: 0;
      transition: opacity 0.2s ease;
    }
    .sidebar.expanded .brand-text {
      opacity: 1;
    }
    .nav-links {
      list-style: none;
      padding: 0;
      margin: 0;
      flex: 1;
    }
    .nav-links li {
      margin-bottom: 0.25rem;
    }
    .nav-links a {
      display: flex;
      align-items: center;
      padding: 0.6rem;
      text-decoration: none;
      color: #555;
      border-radius: 6px;
      transition: background 0.2s;
      white-space: nowrap;
    }
    .nav-links a:hover, .nav-links a.active {
      background-color: #e3f2fd;
      color: #1976d2;
    }
    .icon {
      font-size: 1.25rem;
      flex-shrink: 0;
      width: 28px;
      text-align: center;
    }
    .link-text {
      margin-left: 0.5rem;
      opacity: 0;
      transition: opacity 0.2s ease;
    }
    .sidebar.expanded .link-text {
      opacity: 1;
    }
    .user-info {
      display: flex;
      align-items: center;
      padding: 0.5rem;
      border-top: 1px solid #eee;
      margin-top: auto;
      white-space: nowrap;
    }
    .user-icon {
      font-size: 1rem;
      flex-shrink: 0;
    }
    .user-text {
      margin-left: 0.5rem;
      font-size: 0.75rem;
      color: #777;
      opacity: 0;
      transition: opacity 0.2s ease;
    }
    .sidebar.expanded .user-text {
      opacity: 1;
    }
    .content {
      flex: 1;
      padding: 1.5rem;
      overflow-y: auto;
    }
  `]
})
export class AdminLayoutComponent {
  sidebarExpanded = false;
}
