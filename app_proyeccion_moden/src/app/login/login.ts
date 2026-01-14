import { Component, ElementRef, inject, Renderer2, ViewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

@Component({
  selector: 'app-login',
  // imports: [RouterLink],
  imports: [],
  templateUrl: './login.html',
  styleUrl: './login.css',
})
export class Login {
  private router = inject(Router);
  @ViewChild('password')input!: ElementRef<HTMLInputElement>;
  @ViewChild('password_icon') icon!: ElementRef<HTMLInputElement>;
  constructor(private renderer: Renderer2) {}
  submit() {
    this.router.navigate(['/dashboard']);
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
