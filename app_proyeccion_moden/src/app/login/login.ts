import { Component, ElementRef, inject, Renderer2, ViewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { ApiService } from '../services/api.service';

@Component({
  selector: 'app-login',
  imports: [FormsModule, CommonModule],
  templateUrl: './login.html',
  styleUrl: './login.css',
})
export class Login {
  private router = inject(Router);
  private api = inject(ApiService);

  username = '';
  password = '';
  loading = false;
  error = '';

  @ViewChild('passwordInput') input!: ElementRef<HTMLInputElement>;
  @ViewChild('password_icon') icon!: ElementRef<HTMLInputElement>;

  constructor(private renderer: Renderer2, private cdr: ChangeDetectorRef) { }

  @ViewChild('user_input') userInput!: ElementRef<HTMLInputElement>;

  submit() {
    // Fallback: Check native values if ngModel failed (common with autofill)
    if (!this.username && this.userInput) {
      this.username = this.userInput.nativeElement.value;
    }
    if (!this.password && this.input) {
      this.password = this.input.nativeElement.value;
    }

    if (!this.username || !this.password) {
      this.error = 'Por favor, introduce usuario y contraseña';
      this.cdr.detectChanges();
      return;
    }

    this.loading = true;
    this.error = '';
    this.cdr.detectChanges(); // Trigger update for loading state

    this.api.login({ username: this.username, password: this.password }).subscribe({
      next: (response) => {
        localStorage.setItem('auth_token', response.token);

        // Redirect based on role
        if (response.is_staff || response.is_superuser) {
          this.router.navigate(['/admin-dashboard/ferrallas'], { replaceUrl: true });
        } else {
          this.router.navigate(['/dashboard'], { replaceUrl: true });
        }

        this.loading = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('Login error', err);
        this.error = 'Usuario o contraseña incorrectos';
        this.loading = false;
        this.cdr.detectChanges(); // Force UI update to show error
      }
    });
  }
  toggle_pass() {
    var input_el = this.input.nativeElement
    var icon_el = this.icon.nativeElement;
    if (input_el.type === 'password') {
      input_el.type = 'text'
      this.renderer.removeClass(icon_el, 'fa-eye');
      this.renderer.addClass(icon_el, 'fa-eye-slash');
    } else {
      input_el.type = 'password'
      this.renderer.removeClass(icon_el, 'fa-eye-slash');
      this.renderer.addClass(icon_el, 'fa-eye');
    }
  }



}
