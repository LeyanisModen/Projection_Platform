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

  // Add Mesa Logic
  showAddMesaForm = false;

  toggleAddMesaForm() {
    this.showAddMesaForm = !this.showAddMesaForm;
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
        this.showAddMesaForm = false; // Hide form after adding
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

  // Pairing Modal State
  showPairingModal = false;
  pairingMesa: any = null;
  pairingCode = '';
  pairingError = '';
  pairingLoading = false;
  pairingSuccess = false;

  // Unbind Modal State
  showUnbindModal = false;
  unbindMesa: any = null;
  unbindLoading = false;

  // Pairing Methods
  openPairingModal(mesa: any): void {
    this.pairingMesa = mesa;
    this.pairingCode = '';
    this.pairingError = '';
    this.pairingLoading = false;
    this.pairingSuccess = false;
    this.showPairingModal = true;
    this.cdr.detectChanges();
  }

  closePairingModal(): void {
    this.showPairingModal = false;
    this.pairingMesa = null;
    this.pairingCode = '';
    this.pairingError = '';
    this.pairingLoading = false;
    this.pairingSuccess = false;
    this.cdr.detectChanges();
  }

  submitPairing(): void {
    if (!this.pairingMesa || !this.pairingCode.trim()) {
      this.pairingError = 'Introduce un código válido';
      return;
    }

    this.pairingLoading = true;
    this.pairingError = '';

    this.api.pairDevice(this.pairingMesa.id, this.pairingCode.trim().toUpperCase())
      .subscribe({
        next: (res) => {
          this.pairingLoading = false;
          if (res.status === 'ok') {
            this.pairingSuccess = true;
            // Reload mesas to update is_linked status
            if (this.selectedUser) this.loadMesas(this.selectedUser.id);
          } else {
            this.pairingError = 'Error desconocido';
          }
          this.cdr.detectChanges();
        },
        error: (err) => {
          this.pairingLoading = false;
          this.pairingError = err.error?.detail || 'Error al vincular dispositivo';
          this.cdr.detectChanges();
        }
      });
  }

  onPairingCodeInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.pairingCode = input.value.toUpperCase();
  }

  // Unbind Methods
  openUnbindModal(mesa: any): void {
    this.unbindMesa = mesa;
    this.unbindLoading = false;
    this.showUnbindModal = true;
    this.cdr.detectChanges();
  }

  closeUnbindModal(): void {
    this.showUnbindModal = false;
    this.unbindMesa = null;
    this.unbindLoading = false;
    this.cdr.detectChanges();
  }

  confirmUnbind(): void {
    if (!this.unbindMesa) return;

    this.unbindLoading = true;
    this.api.unbindDevice(this.unbindMesa.id)
      .subscribe({
        next: () => {
          if (this.selectedUser) this.loadMesas(this.selectedUser.id);
          this.closeUnbindModal();
        },
        error: () => {
          this.unbindLoading = false;
          this.cdr.detectChanges();
        }
      });
  }

  // Credentials Modal Logic
  showCredentialsModal = false;
  credentialUser: User | null = null;
  newCredentialPassword = '';
  credentialError = '';
  credentialSuccess = '';
  credentialLoading = false;

  openCredentialsModal(user: User): void {
    this.credentialUser = user;
    this.newCredentialPassword = '';
    this.credentialError = '';
    this.credentialSuccess = '';
    this.credentialLoading = false;
    this.showCredentialsModal = true;
    this.cdr.detectChanges();
  }

  closeCredentialsModal(): void {
    this.showCredentialsModal = false;
    this.credentialUser = null;
    this.newCredentialPassword = '';
    this.credentialError = '';
    this.credentialSuccess = '';
    this.cdr.detectChanges();
  }

  generatePassword(): void {
    this.newCredentialPassword = Math.random().toString(36).slice(-8);
  }

  generateFormPassword(): void {
    this.newUser.password = Math.random().toString(36).slice(-8);
  }

  updateCredentials(): void {
    if (!this.credentialUser || !this.newCredentialPassword) return;

    this.credentialLoading = true;
    this.credentialError = '';

    // We only update the password.
    const payload = { password: this.newCredentialPassword };

    this.api.updateUser(this.credentialUser.id, payload).subscribe({
      next: () => {
        this.credentialLoading = false;
        this.credentialSuccess = 'Contraseña actualizada correctamente';
        this.newCredentialPassword = ''; // Clear for security
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        this.credentialLoading = false;
        this.credentialError = 'Error actualizando contraseña';
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
        console.log('[Ferrallas] User created successfully:', user);
        this.resetForm();
        this.showForm = false;
        // Reload all users to ensure list is perfectly synced and sorted
        this.loadUsers();
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
