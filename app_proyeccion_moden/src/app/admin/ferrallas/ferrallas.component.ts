import { Component, OnInit, ChangeDetectorRef, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService, GrupoMesas, GrupoMesaResumen, User } from '../../services/api.service';

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
  newUser: any = { username: '', first_name: '', email: '', password: '', telefono: '', direccion: '', coordinador: '', capacidad_diaria_modulos: 12 };
  isEditing = false;
  editingId: number | null = null;
  selectedUser: User | null = null;

  gruposMesas: GrupoMesas[] = [];
  loadingMesas = false;
  showAddMesaForm = false;

  showPairingModal = false;
  pairingMesa: GrupoMesaResumen | null = null;
  pairingCode = '';
  pairingError = '';
  pairingLoading = false;
  pairingSuccess = false;

  showUnbindModal = false;
  unbindMesa: GrupoMesaResumen | null = null;
  unbindLoading = false;

  showCredentialsModal = false;
  credentialUser: User | null = null;
  newCredentialPassword = '';
  credentialError = '';
  credentialSuccess = '';
  credentialLoading = false;

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
    if (!this.showForm) {
      this.resetForm();
    }
    this.showForm = !this.showForm;
    this.error = '';
  }

  resetForm() {
    this.newUser = { username: '', first_name: '', email: '', password: '', telefono: '', direccion: '', coordinador: '', capacidad_diaria_modulos: 12 };
    this.isEditing = false;
    this.editingId = null;
  }

  selectUser(user: User) {
    this.selectedUser = this.selectedUser?.id === user.id ? null : user;
    this.showForm = false;
    this.showAddMesaForm = false;

    if (this.selectedUser) {
      this.loadGruposMesas(this.selectedUser.id);
    } else {
      this.gruposMesas = [];
    }
  }

  loadGruposMesas(userId: number) {
    this.loadingMesas = true;
    this.api.getGruposMesas(userId).subscribe({
      next: (data) => {
        this.gruposMesas = data;
        this.loadingMesas = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('Error loading grupos de mesas', err);
        this.loadingMesas = false;
        this.cdr.detectChanges();
      }
    });
  }

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

    this.api.createGrupoMesas(payload).subscribe({
      next: (grupo) => {
        this.gruposMesas.push(grupo);
        this.gruposMesas.sort((a, b) => a.nombre.localeCompare(b.nombre));
        nombreInput.value = '';
        this.loadingMesas = false;
        this.showAddMesaForm = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('Error creating grupo de mesas', err);
        this.loadingMesas = false;
        alert(err?.error?.detail || 'Error creando grupo de mesas');
        this.cdr.detectChanges();
      }
    });
  }

  confirmDeleteGrupo(grupo: GrupoMesas) {
    if (confirm(`Eliminar grupo "${grupo.nombre}" y sus 3 mesas?`)) {
      this.deleteGrupo(grupo);
    }
  }

  deleteGrupo(grupo: GrupoMesas) {
    this.loadingMesas = true;
    this.api.deleteGrupoMesas(grupo.id).subscribe({
      next: () => {
        this.gruposMesas = this.gruposMesas.filter(item => item.id !== grupo.id);
        this.loadingMesas = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('Error deleting grupo de mesas', err);
        this.loadingMesas = false;
        alert('Error eliminando grupo de mesas');
        this.cdr.detectChanges();
      }
    });
  }

  openPairingModal(mesa: GrupoMesaResumen): void {
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
      this.pairingError = 'Introduce un codigo valido';
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
            if (this.selectedUser) this.loadGruposMesas(this.selectedUser.id);
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

  openUnbindModal(mesa: GrupoMesaResumen): void {
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
          if (this.selectedUser) this.loadGruposMesas(this.selectedUser.id);
          this.closeUnbindModal();
        },
        error: () => {
          this.unbindLoading = false;
          this.cdr.detectChanges();
        }
      });
  }

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
    const payload = { password: this.newCredentialPassword };

    this.api.updateUser(this.credentialUser.id, payload).subscribe({
      next: () => {
        this.credentialLoading = false;
        this.credentialSuccess = 'Contrasena actualizada correctamente';
        this.newCredentialPassword = '';
        this.cdr.detectChanges();
      },
      error: () => {
        this.credentialLoading = false;
        this.credentialError = 'Error actualizando contrasena';
        this.cdr.detectChanges();
      }
    });
  }

  saveUser() {
    if (this.isEditing && this.editingId) {
      this.updateUser(this.editingId);
    } else {
      this.createUser();
    }
  }

  editUser(user: User) {
    this.newUser = { ...user, password: '' };
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
      delete payload.password;
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
    if (confirm(`Estas seguro de eliminar a ${user.username}?`)) {
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

  generateUsername(name: string) {
    if (!name) return;

    if (!this.isEditing) {
      const username = name.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, '_');

      this.newUser.username = username;
    }
  }

  getMesaRoleLabel(mesa: GrupoMesaResumen): string {
    switch (mesa.rol) {
      case 'INFERIOR_1':
        return 'INF1';
      case 'INFERIOR_2':
        return 'INF2';
      case 'SUPERIORES':
        return 'SUP';
      default:
        return 'LEG';
    }
  }

  @HostListener('document:keydown.escape', ['$event'])
  onKeydownHandler(event: any) {
    if (this.showCredentialsModal) this.closeCredentialsModal();
    if (this.showPairingModal) this.closePairingModal();
    if (this.showUnbindModal) this.closeUnbindModal();
  }

  @HostListener('document:keydown.enter', ['$event'])
  onEnterHandler(event: any) {
    if (this.showCredentialsModal) {
      this.closeCredentialsModal();
      return;
    }

    if (this.showPairingModal) {
      if (this.pairingSuccess) {
        this.closePairingModal();
        return;
      }
      if (!this.pairingLoading && this.pairingCode.trim().length >= 6) {
        this.submitPairing();
      }
    }

    if (this.showUnbindModal) {
      if (!this.unbindLoading) {
        this.confirmUnbind();
      }
    }
  }
}
