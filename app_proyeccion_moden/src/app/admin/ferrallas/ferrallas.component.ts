import { Component, OnInit, OnDestroy, ChangeDetectorRef, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  ApiService,
  CaptureConfigStatus,
  CaptureDay,
  FerrallaCaptureConfig,
  FerrallaContacto,
  FerrallaDireccion,
  GrupoMesas,
  GrupoMesaResumen,
  User,
} from '../../services/api.service';

@Component({
  selector: 'app-ferrallas',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './ferrallas.component.html',
  styleUrls: ['./ferrallas.component.css', '../admin-responsive.css']
})
export class FerrallasComponent implements OnInit, OnDestroy {
  private static readonly MESA_OFFLINE_AFTER_MS = 2 * 60 * 1000;
  private static readonly MESA_REFRESH_MS = 30 * 1000;
  readonly captureDays: { value: CaptureDay; label: string }[] = [
    { value: 'MON', label: 'L' },
    { value: 'TUE', label: 'M' },
    { value: 'WED', label: 'X' },
    { value: 'THU', label: 'J' },
    { value: 'FRI', label: 'V' },
    { value: 'SAT', label: 'S' },
    { value: 'SUN', label: 'D' },
  ];
  readonly imageRotations = [0, 90, 180, 270] as const;

  users: User[] = [];
  loading = false;
  error = '';
  showForm = false;
  newUser: any = this.getEmptyUserForm();
  isEditing = false;
  editingId: number | null = null;
  selectedUser: User | null = null;

  gruposMesas: GrupoMesas[] = [];
  loadingMesas = false;
  showAddMesaForm = false;
  captureConfig: FerrallaCaptureConfig | null = null;
  loadingCaptureConfig = false;
  savingCaptureConfig = false;
  captureConfigError = '';
  captureConfigMessage = '';

  editingGrupoId: number | null = null;
  editingGrupoName: string = '';

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
  private mesaRefreshTimer: any = null;

  constructor(
    private api: ApiService,
    private cdr: ChangeDetectorRef
  ) { }

  ngOnInit(): void {
    this.loadUsers();
  }

  ngOnDestroy(): void {
    this.clearMesaAutoRefresh();
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
    this.newUser = this.getEmptyUserForm();
    this.isEditing = false;
    this.editingId = null;
  }

  private getEmptyUserForm() {
    return {
      username: '',
      first_name: '',
      password: '',
      contactos: [] as FerrallaContacto[],
      direcciones: [] as FerrallaDireccion[],
      capacidad_diaria_modulos: 12,
      bastidor_longitud_cm: 114
    };
  }

  addContacto(): void {
    this.newUser.contactos = [
      ...(this.newUser.contactos || []),
      { nombre: '', cargo: '', telefono: '', email: '' }
    ];
  }

  removeContacto(index: number): void {
    this.newUser.contactos = (this.newUser.contactos || []).filter((_: FerrallaContacto, i: number) => i !== index);
  }

  addDireccion(): void {
    this.newUser.direcciones = [
      ...(this.newUser.direcciones || []),
      { nombre: '', direccion: '' }
    ];
  }

  removeDireccion(index: number): void {
    this.newUser.direcciones = (this.newUser.direcciones || []).filter((_: FerrallaDireccion, i: number) => i !== index);
  }

  hasContactos(user: User | null): boolean {
    return !!user?.contactos?.length;
  }

  hasDirecciones(user: User | null): boolean {
    return !!user?.direcciones?.length;
  }

  selectUser(user: User) {
    this.selectedUser = this.selectedUser?.id === user.id ? null : user;
    this.showForm = false;
    this.showAddMesaForm = false;

    if (this.selectedUser) {
      this.loadGruposMesas(this.selectedUser.id);
      this.loadCaptureConfig(this.selectedUser.id);
      this.startMesaAutoRefresh();
    } else {
      this.gruposMesas = [];
      this.captureConfig = null;
      this.captureConfigError = '';
      this.captureConfigMessage = '';
      this.clearMesaAutoRefresh();
    }
  }

  loadCaptureConfig(userId: number, silent = false): void {
    if (!silent) this.loadingCaptureConfig = true;
    this.api.getFerrallaCaptureConfig(userId).subscribe({
      next: (config) => {
        if (this.selectedUser?.id !== userId) return;
        this.captureConfig = config;
        this.loadingCaptureConfig = false;
        this.captureConfigError = '';
        this.cdr.detectChanges();
      },
      error: (err) => {
        if (this.selectedUser?.id !== userId) return;
        console.error('Error loading capture config', err);
        this.loadingCaptureConfig = false;
        if (!silent) {
          this.captureConfigError = 'No se pudo cargar la configuracion.';
        }
        this.cdr.detectChanges();
      },
    });
  }

  isCaptureDayActive(day: CaptureDay): boolean {
    return !!this.captureConfig?.active_days.includes(day);
  }

  toggleCaptureDay(day: CaptureDay): void {
    if (!this.captureConfig || this.savingCaptureConfig) return;
    const activeDays = new Set(this.captureConfig.active_days);
    if (activeDays.has(day)) {
      if (activeDays.size === 1) return;
      activeDays.delete(day);
    } else {
      activeDays.add(day);
    }
    this.captureConfig.active_days = this.captureDays
      .map(item => item.value)
      .filter(value => activeDays.has(value));
    this.captureConfigMessage = '';
  }

  saveCaptureConfig(): void {
    if (!this.selectedUser || !this.captureConfig || this.savingCaptureConfig) return;
    const userId = this.selectedUser.id;
    this.savingCaptureConfig = true;
    this.captureConfigError = '';
    this.captureConfigMessage = '';
    const payload = {
      active_days: [...this.captureConfig.active_days],
      start_time: this.captureConfig.start_time,
      end_time: this.captureConfig.end_time,
      interval_seconds: Number(this.captureConfig.interval_seconds),
      rotations: this.captureConfig.mesas.map(mesa => ({
        mesa_id: mesa.id,
        image_rotation: mesa.image_rotation,
      })),
    };
    this.api.updateFerrallaCaptureConfig(userId, payload).subscribe({
      next: (config) => {
        this.savingCaptureConfig = false;
        if (this.selectedUser?.id !== userId) {
          this.cdr.detectChanges();
          return;
        }
        this.captureConfig = config;
        this.captureConfigMessage = 'Configuracion guardada. Las mesas la aplicaran en su proxima consulta.';
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('Error saving capture config', err);
        this.savingCaptureConfig = false;
        if (this.selectedUser?.id !== userId) {
          this.cdr.detectChanges();
          return;
        }
        const detail = err?.error?.detail;
        this.captureConfigError = typeof detail === 'string'
          ? detail
          : 'No se pudo guardar la configuracion.';
        this.cdr.detectChanges();
      },
    });
  }

  captureStatusLabel(status: CaptureConfigStatus): string {
    const labels: Record<CaptureConfigStatus, string> = {
      applied: 'Aplicado',
      pending: 'Pendiente',
      error: 'Error',
      unlinked: 'Sin vincular',
    };
    return labels[status];
  }

  loadGruposMesas(userId: number, silent = false) {
    if (!silent) this.loadingMesas = true;
    this.api.getGruposMesas(userId).subscribe({
      next: (data) => {
        this.gruposMesas = data.map(grupo => ({
          ...grupo,
          mesas: this.sortMesasByName(grupo.mesas),
        }));
        if (!silent) this.loadingMesas = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('Error loading grupos de mesas', err);
        if (!silent) this.loadingMesas = false;
        this.cdr.detectChanges();
      }
    });
  }

  private startMesaAutoRefresh(): void {
    this.clearMesaAutoRefresh();
    this.mesaRefreshTimer = setInterval(() => {
      if (!this.selectedUser || this.loadingMesas || this.showPairingModal || this.showUnbindModal) return;
      this.loadGruposMesas(this.selectedUser.id, true);
    }, FerrallasComponent.MESA_REFRESH_MS);
  }

  private clearMesaAutoRefresh(): void {
    if (!this.mesaRefreshTimer) return;
    clearInterval(this.mesaRefreshTimer);
    this.mesaRefreshTimer = null;
  }

  private sortMesasByName(mesas: GrupoMesaResumen[] = []): GrupoMesaResumen[] {
    return [...mesas].sort((a, b) =>
      (a.nombre || '').localeCompare(b.nombre || '', 'es', {
        numeric: true,
        sensitivity: 'base',
      })
    );
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

  startEditingGrupo(grupo: GrupoMesas, event?: Event) {
    if (event) event.stopPropagation();
    this.editingGrupoId = grupo.id;
    this.editingGrupoName = grupo.nombre;
  }

  stopEditingGrupo() {
    this.editingGrupoId = null;
    this.editingGrupoName = '';
  }

  updateGrupoName(grupo: GrupoMesas) {
    if (this.editingGrupoId !== grupo.id) return;
    const newName = (this.editingGrupoName || '').trim();
    if (!newName || newName === grupo.nombre) {
      this.stopEditingGrupo();
      return;
    }
    this.api.updateGrupoMesas(grupo.id, { nombre: newName }).subscribe({
      next: (updated) => {
        grupo.nombre = updated.nombre;
        this.stopEditingGrupo();
      },
      error: (err) => {
        console.error('Error updating grupo name', err);
        alert('No se pudo renombrar el grupo');
        this.stopEditingGrupo();
      }
    });
  }

  confirmDeleteGrupo(grupo: GrupoMesas) {
    const numMesas = grupo.mesas?.length ?? 0;
    const mesasTxt = numMesas === 1 ? '1 mesa' : `${numMesas} mesas`;
    if (confirm(`Eliminar grupo "${grupo.nombre}" y sus ${mesasTxt}?`)) {
      this.deleteGrupo(grupo);
    }
  }

  /** Anade una mesa nueva al grupo. Por defecto INFERIOR; el admin
   * puede cambiar el tipo con el switch despues. */
  addMesaToGrupo(grupo: GrupoMesas) {
    this.loadingMesas = true;
    this.api.addMesaToGrupo(grupo.id, 'INFERIOR').subscribe({
      next: (mesa) => {
        grupo.mesas = this.sortMesasByName([...(grupo.mesas || []), mesa]);
        if (this.selectedUser) this.loadCaptureConfig(this.selectedUser.id, true);
        this.loadingMesas = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('Error creating mesa', err);
        this.loadingMesas = false;
        alert(err?.error?.detail || 'Error creando mesa');
        this.cdr.detectChanges();
      }
    });
  }

  /** Estado actual de la mesa: combina tipo+activa en uno de tres
   * valores. Coincide con la logica del modal Gestionar del cliente. */
  mesaEstadoActual(mesa: GrupoMesaResumen): 'INFERIOR' | 'SUPERIOR' | 'INACTIVA' {
    if (!mesa.activa) return 'INACTIVA';
    return mesa.tipo === 'SUPERIOR' ? 'SUPERIOR' : 'INFERIOR';
  }

  /** Cambia el estado de una mesa al instante: una llamada al
   * endpoint actualizar-mesas con el cambio puntual. Replanifica las
   * mesas del grupo (preserve-anchored) en el backend. */
  setMesaEstado(grupo: GrupoMesas, mesa: GrupoMesaResumen, estado: 'INFERIOR' | 'SUPERIOR' | 'INACTIVA') {
    if (this.mesaEstadoActual(mesa) === estado) return;
    const cambio: { mesa_id: number; tipo?: 'INFERIOR' | 'SUPERIOR'; activa?: boolean } = {
      mesa_id: mesa.id,
    };
    if (estado === 'INACTIVA') {
      cambio.activa = false;
    } else {
      cambio.tipo = estado;
      cambio.activa = true;
    }
    this.loadingMesas = true;
    this.api.actualizarMesasGrupo(grupo.id, [cambio]).subscribe({
      next: () => {
        if (this.selectedUser) this.loadGruposMesas(this.selectedUser.id);
        this.loadingMesas = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.loadingMesas = false;
        alert(err?.error?.detail || 'No se pudo cambiar el estado de la mesa.');
        this.cdr.detectChanges();
      },
    });
  }

  confirmDeleteMesa(grupo: GrupoMesas, mesa: GrupoMesaResumen) {
    if (!confirm(`Eliminar la mesa "${mesa.nombre}"?`)) return;
    this.deleteMesa(grupo, mesa, false);
  }

  private deleteMesa(grupo: GrupoMesas, mesa: GrupoMesaResumen, force: boolean) {
    this.loadingMesas = true;
    this.api.deleteMesa(mesa.id, force).subscribe({
      next: () => {
        grupo.mesas = (grupo.mesas || []).filter(m => m.id !== mesa.id);
        if (this.selectedUser) this.loadCaptureConfig(this.selectedUser.id, true);
        this.loadingMesas = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.loadingMesas = false;
        const body = err?.error || {};
        if (err?.status === 409 && (body.cola_activa || body.device_vinculado) && !force) {
          const motivos: string[] = [];
          if (body.cola_activa) motivos.push('tiene cola activa');
          if (body.device_vinculado) motivos.push('tiene un dispositivo vinculado');
          const motivo = motivos.join(' y ');
          if (confirm(`La mesa ${motivo}. Eliminarla de todos modos?`)) {
            this.deleteMesa(grupo, mesa, true);
            return;
          }
        } else if (err?.status === 409) {
          alert(body.detail || 'No se puede eliminar la mesa.');
        } else {
          console.error('Error deleting mesa', err);
          alert(body.detail || 'Error eliminando la mesa');
        }
        this.cdr.detectChanges();
      }
    });
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

  openMesaVisor(mesa: GrupoMesaResumen): void {
    window.open(`/visor/${mesa.id}`, '_blank', 'noopener');
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
            if (this.selectedUser) {
              this.loadGruposMesas(this.selectedUser.id);
              this.loadCaptureConfig(this.selectedUser.id, true);
            }
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
          if (this.selectedUser) {
            this.loadGruposMesas(this.selectedUser.id);
            this.loadCaptureConfig(this.selectedUser.id, true);
          }
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
    this.showCredentialsModal = true;
    this.cdr.detectChanges();
  }

  closeCredentialsModal(): void {
    this.showCredentialsModal = false;
    this.credentialUser = null;
    this.cdr.detectChanges();
  }

  generateFormPassword(): void {
    this.newUser.password = Math.random().toString(36).slice(-8);
  }

  saveUser() {
    if (this.isEditing && this.editingId) {
      this.updateUser(this.editingId);
    } else {
      this.createUser();
    }
  }

  editUser(user: User) {
    this.newUser = {
      ...user,
      password: '',
      bastidor_longitud_cm: user.bastidor_longitud_cm || 114,
      contactos: this.getEditableContactos(user),
      direcciones: this.getEditableDirecciones(user)
    };
    this.isEditing = true;
    this.editingId = user.id;
    this.showForm = true;
  }

  private getEditableContactos(user: User): FerrallaContacto[] {
    if (user.contactos?.length) {
      return user.contactos.map(contacto => ({ ...contacto }));
    }

    if (user.coordinador || user.telefono || user.email) {
      return [{
        nombre: user.coordinador || '',
        cargo: '',
        telefono: user.telefono || '',
        email: user.email || ''
      }];
    }

    return [];
  }

  private getEditableDirecciones(user: User): FerrallaDireccion[] {
    if (user.direcciones?.length) {
      return user.direcciones.map(direccion => ({ ...direccion }));
    }

    if (user.direccion) {
      return [{
        nombre: 'Principal',
        direccion: user.direccion
      }];
    }

    return [];
  }

  private buildUserPayload(): any {
    const payload = {
      ...this.newUser,
      contactos: this.normalizeContactos(this.newUser.contactos || []),
      direcciones: this.normalizeDirecciones(this.newUser.direcciones || [])
    };

    delete payload.id;
    delete payload.url;
    delete payload.email;
    delete payload.groups;
    delete payload.telefono;
    delete payload.direccion;
    delete payload.coordinador;

    return payload;
  }

  private normalizeContactos(contactos: FerrallaContacto[]): FerrallaContacto[] {
    return contactos
      .map((contacto, index) => ({
        nombre: (contacto.nombre || '').trim(),
        cargo: (contacto.cargo || '').trim(),
        telefono: (contacto.telefono || '').trim(),
        email: (contacto.email || '').trim(),
        orden: index
      }))
      .filter(contacto => contacto.nombre || contacto.cargo || contacto.telefono || contacto.email);
  }

  private normalizeDirecciones(direcciones: FerrallaDireccion[]): FerrallaDireccion[] {
    return direcciones
      .map((direccion, index) => ({
        nombre: (direccion.nombre || '').trim(),
        direccion: (direccion.direccion || '').trim(),
        orden: index
      }))
      .filter(direccion => direccion.nombre || direccion.direccion);
  }

  createUser() {
    this.loading = true;
    const payload = this.buildUserPayload();
    if (payload.password && !payload.password_texto_plano) {
      payload.password_texto_plano = payload.password;
    }

    this.api.createUser(payload).subscribe({
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
    const payload = this.buildUserPayload();
    if (!payload.password) {
      delete payload.password;
      delete payload.password_texto_plano;
    } else {
      payload.password_texto_plano = payload.password;
    }

    this.api.updateUser(id, payload).subscribe({
      next: (updatedUser: User) => {
        const index = this.users.findIndex(u => u.id === id);
        if (index !== -1) {
          this.users[index] = updatedUser;
        }
        if (this.selectedUser?.id === id) {
          this.selectedUser = updatedUser;
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
    return mesa.nombre || `Mesa ${mesa.indice}`;
  }

  getMesaTipoLabel(mesa: GrupoMesaResumen): string {
    return mesa.tipo === 'INFERIOR' ? 'INF' : 'SUP';
  }

  isMesaPlayerOffline(mesa: GrupoMesaResumen): boolean {
    if (!mesa.is_linked) return false;
    if (!mesa.last_seen) return true;
    const lastSeen = new Date(mesa.last_seen).getTime();
    if (!Number.isFinite(lastSeen)) return true;
    return Date.now() - lastSeen > FerrallasComponent.MESA_OFFLINE_AFTER_MS;
  }

  getMesaLastSeenLabel(mesa: GrupoMesaResumen): string {
    if (!mesa.last_seen) return 'Sin heartbeat recibido';
    const lastSeen = new Date(mesa.last_seen).getTime();
    if (!Number.isFinite(lastSeen)) return 'Ultima señal desconocida';
    const seconds = Math.max(0, Math.round((Date.now() - lastSeen) / 1000));
    if (seconds < 60) return `Ultima señal hace ${seconds}s`;
    const minutes = Math.round(seconds / 60);
    return `Ultima señal hace ${minutes} min`;
  }

  getGrupoSubtitulo(grupo: GrupoMesas): string {
    let inf = 0;
    let sup = 0;
    let inactivas = 0;
    for (const mesa of grupo.mesas || []) {
      if (!mesa.activa) inactivas++;
      if (mesa.tipo === 'INFERIOR') inf++;
      else if (mesa.tipo === 'SUPERIOR') sup++;
    }
    const total = (grupo.mesas || []).length;
    const totalTxt = total === 1 ? '1 mesa' : `${total} mesas`;
    const partes: string[] = [];
    if (inf) partes.push(`${inf} INF`);
    if (sup) partes.push(`${sup} SUP`);
    if (inactivas) partes.push(`${inactivas} desactivada(s)`);
    return partes.length ? `${totalTxt} (${partes.join(' / ')})` : totalTxt;
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
