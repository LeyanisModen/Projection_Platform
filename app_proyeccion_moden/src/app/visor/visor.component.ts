import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { interval, Subscription, switchMap } from 'rxjs';
import { Mesa } from '../mesa';

@Component({
  selector: 'app-visor',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './visor.component.html',
  styleUrl: './visor.component.css'
})
export class VisorComponent implements OnInit, OnDestroy {
  mesa: Mesa | null = null;
  mesaId: string | null = null;
  pollingSubscription: Subscription | null = null;
  apiUrl = 'http://localhost:8000/api/mesas/'; // Ajustar según entorno

  constructor(private route: ActivatedRoute, private http: HttpClient) {}

  ngOnInit(): void {
    this.mesaId = this.route.snapshot.paramMap.get('id');
    if (this.mesaId) {
      this.startPolling();
    }
  }

  ngOnDestroy(): void {
    if (this.pollingSubscription) {
      this.pollingSubscription.unsubscribe();
    }
  }

  startPolling(): void {
    // Poll every 5 seconds
    this.pollingSubscription = interval(5000)
      .pipe(
        switchMap(() => this.http.get<Mesa>(`${this.apiUrl}${this.mesaId}/`))
      )
      .subscribe({
        next: (data) => {
          this.mesa = data;
          console.log('Mesa actualizada:', this.mesa);
        },
        error: (err) => console.error('Error polling mesa:', err)
      });
      
    // Initial load
    this.http.get<Mesa>(`${this.apiUrl}${this.mesaId}/`).subscribe(data => this.mesa = data);
  }
}
