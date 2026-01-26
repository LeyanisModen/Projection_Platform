import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService, User } from '../../services/api.service';

@Component({
  selector: 'app-ferrallas',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './ferrallas.component.html',
  styleUrls: ['./ferrallas.component.css']
})
export class FerrallasComponent implements OnInit {
  users: User[] = [];
  loading = false;
  error = '';
  showForm = false;
  newUser: any = { username: '', first_name: '', email: '', password: '', telefono: '', direccion: '', coordinador: '' };
  isEditing = false;
  editingId: number | null = null;
  selectedUser: User | null = null;

  constructor(
    private api: ApiService,
    private cdr: ChangeDetectorRef
  ) { }

  ngOnInit(): void {
    this.loadUsers();
  }

  loadUsers() {
    this.loading = true;
    this.api.getUsers().subscribe({
      next: (data) => {
        this.users = data;
        this.loading = false;
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        console.error('Error loading users', err);
        this.error = 'Error cargando usuarios';
        this.loading = false;
        this.cdr.detectChanges();
      }
    });
  }

  toggleForm() {
    this.showForm = !this.showForm;
    this.error = '';
    if (!this.showForm) {
      this.resetForm();
    }
  }

  resetForm() {
    this.newUser = { username: '', first_name: '', email: '', password: '', telefono: '', direccion: '', coordinador: '' };
    this.isEditing = false;
    this.editingId = null;
    // Don't clear selectedUser here unless necessary, but maybe useful if we edit the selected user
  }

  // Mesas Logic
  mesas: any[] = [];
  loadingMesas = false;

  selectUser(user: User) {
    this.selectedUser = this.selectedUser?.id === user.id ? null : user;
    this.showForm = false;

    if (this.selectedUser) {
      this.loadMesas(this.selectedUser.id);
    } else {
      this.mesas = [];
    }
  }

  loadMesas(userId: number) {
    this.loadingMesas = true;
    this.api.getMesas(userId).subscribe({
      next: (data) => {
        this.mesas = data;
        this.loadingMesas = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('Error loading mesas', err);
        this.loadingMesas = false;
        this.cdr.detectChanges();
      }
    });
  }

  confirmDeleteMesa(mesa: any) {
    if (confirm(`¿Eliminar mesa "${mesa.nombre}"?`)) {
      this.deleteMesa(mesa);
    }
  }

  deleteMesa(mesa: any) {
    this.loadingMesas = true;
    this.api.deleteMesa(mesa.id).subscribe({
      next: () => {
        this.mesas = this.mesas.filter(m => m.id !== mesa.id);
        this.loadingMesas = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('Error deleting mesa', err);
        this.loadingMesas = false;
        alert('Error eliminando mesa');
        this.cdr.detectChanges();
      }
    });
  }

  addMesa(nombreInput: HTMLInputElement) {
    if (!this.selectedUser || !nombreInput.value.trim()) return;

    this.loadingMesas = true;
    const payload = {
      nombre: nombreInput.value.trim(),
      usuario: this.selectedUser.id
    };

    this.api.createMesa(payload).subscribe({
      next: (mesa) => {
        this.mesas.push(mesa);
        nombreInput.value = ''; // Reset input
        this.loadingMesas = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('Error creating mesa', err);
        this.loadingMesas = false;
        alert('Error creando mesa');
        this.cdr.detectChanges();
      }
    });
  }

  // User Actions (Existing)
  saveUser() {
    if (this.isEditing && this.editingId) {
      this.updateUser(this.editingId);
    } else {
      this.createUser();
    }
  }

  editUser(user: User) {
    this.newUser = { ...user, password: '' }; // Don't show hash, allow new password
    this.isEditing = true;
    this.editingId = user.id;
    this.showForm = true;
  }

  createUser() {
    this.loading = true;
    this.api.createUser(this.newUser).subscribe({
      next: (user: User) => {
        this.users.unshift(user);
        this.resetForm();
        this.showForm = false;
        this.loading = false;
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        console.error('Error creating user', err);
        this.handleError(err, 'Error creando usuario');
        this.loading = false;
        this.cdr.detectChanges();
      }
    });
  }

  updateUser(id: number) {
    this.loading = true;
    const payload = { ...this.newUser };
    if (!payload.password) {
      delete payload.password; // Don't send empty password
    }

    this.api.updateUser(id, payload).subscribe({
      next: (updatedUser: User) => {
        const index = this.users.findIndex(u => u.id === id);
        if (index !== -1) {
          this.users[index] = updatedUser;
        }
        this.resetForm();
        this.showForm = false;
        this.loading = false;
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        console.error('Error updating user', err);
        this.handleError(err, 'Error actualizando usuario');
        this.loading = false;
        this.cdr.detectChanges();
      }
    });
  }

  private handleError(err: any, defaultMsg: string) {
    if (err.error && typeof err.error === 'object') {
      let messages: string[] = [];
      for (const key in err.error) {
        if (Object.prototype.hasOwnProperty.call(err.error, key)) {
          const val = err.error[key];
          const fieldName = key === 'non_field_errors' ? '' : `${key}: `;
          if (Array.isArray(val)) {
            messages.push(`${fieldName}${val.join(' ')}`);
          } else {
            messages.push(`${fieldName}${val}`);
          }
        }
      }
      this.error = messages.length > 0 ? messages.join('\n') : defaultMsg;
    } else {
      this.error = defaultMsg;
    }
  }

  confirmDelete(user: User) {
    if (confirm(`¿Estás seguro de eliminar a ${user.username}?`)) {
      this.deleteUser(user.id);
    }
  }

  deleteUser(id: number) {
    this.loading = true;
    this.api.deleteUser(id).subscribe({
      next: () => {
        this.users = this.users.filter(u => u.id !== id);
        this.loading = false;
        if (this.selectedUser?.id === id) {
          this.selectedUser = null;
        }
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        console.error('Error deleting user', err);
        this.error = 'Error eliminando usuario';
        this.loading = false;
        this.cdr.detectChanges();
      }
    });
  }
}
