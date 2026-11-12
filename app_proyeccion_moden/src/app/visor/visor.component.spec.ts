import { ChangeDetectorRef, NgZone } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { Title } from '@angular/platform-browser';
import { Subject, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VisorComponent } from './visor.component';


describe('VisorComponent shutdown chord', () => {
  let component: VisorComponent;
  let httpPost: ReturnType<typeof vi.fn>;

  const keyEvent = (type: 'keydown' | 'keyup', key: string): KeyboardEvent => (
    new KeyboardEvent(type, { key, cancelable: true })
  );

  beforeEach(() => {
    vi.useFakeTimers();
    httpPost = vi.fn(() => of({ status: 'ok' }));
    component = new VisorComponent(
      {} as ActivatedRoute,
      { post: httpPost } as unknown as HttpClient,
      { detectChanges: vi.fn() } as unknown as ChangeDetectorRef,
      {} as NgZone,
      {} as Title,
      'browser',
    );
    component.mode = 'PROJECTION';
    component.currentIndex = 0;
  });

  afterEach(() => {
    component.ngOnDestroy();
    vi.useRealTimers();
  });

  it('keeps a standalone arrow as a single navigation action', () => {
    const nextImage = vi.spyOn(component, 'nextImage').mockImplementation(() => undefined);

    component.handleKeyboardEvent(keyEvent('keydown', 'ArrowRight'));
    component.handleKeyboardUp(keyEvent('keyup', 'ArrowRight'));

    expect(nextImage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(350);
    expect(nextImage).toHaveBeenCalledTimes(1);
  });

  it('cancels shutdown when any button is released before five seconds', () => {
    const nextImage = vi.spyOn(component, 'nextImage').mockImplementation(() => undefined);
    const prevImage = vi.spyOn(component, 'prevImage').mockImplementation(() => undefined);

    component.handleKeyboardEvent(keyEvent('keydown', 'ArrowLeft'));
    component.handleKeyboardEvent(keyEvent('keydown', ' '));
    component.handleKeyboardEvent(keyEvent('keydown', 'ArrowRight'));
    expect(component.shutdownStatus).toBe('holding');

    vi.advanceTimersByTime(4000);
    component.handleKeyboardUp(keyEvent('keyup', 'ArrowRight'));
    vi.advanceTimersByTime(2000);

    expect(httpPost).not.toHaveBeenCalled();
    expect(nextImage).not.toHaveBeenCalled();
    expect(prevImage).not.toHaveBeenCalled();
  });

  it('requests local shutdown only after holding all three buttons', () => {
    const nextImage = vi.spyOn(component, 'nextImage').mockImplementation(() => undefined);
    const prevImage = vi.spyOn(component, 'prevImage').mockImplementation(() => undefined);

    component.handleKeyboardEvent(keyEvent('keydown', 'ArrowLeft'));
    component.handleKeyboardEvent(keyEvent('keydown', ' '));
    component.handleKeyboardEvent(keyEvent('keydown', 'ArrowRight'));
    vi.advanceTimersByTime(5000);

    expect(httpPost).toHaveBeenCalledTimes(1);
    expect(httpPost.mock.calls[0][0]).toBe('http://127.0.0.1:5555/shutdown_pc');
    expect(component.shutdownStatus).toBe('shutting-down');
    expect(nextImage).not.toHaveBeenCalled();
    expect(prevImage).not.toHaveBeenCalled();
  });

  it('never exposes the shutdown chord in supervisor mode', () => {
    component.mesaIdForPairing = 1;
    const nextImage = vi.spyOn(component, 'nextImage').mockImplementation(() => undefined);

    component.handleKeyboardEvent(keyEvent('keydown', 'ArrowRight'));

    expect(nextImage).toHaveBeenCalledTimes(1);
    expect(component.shutdownStatus).toBeNull();
    expect(httpPost).not.toHaveBeenCalled();
  });
});


describe('VisorComponent slide lock', () => {
  let component: VisorComponent;
  let httpPost: ReturnType<typeof vi.fn>;
  const image = (name: string) => ({ url: `/media/imagenes/1/${name}.jpg` });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-21T08:00:00Z'));
    httpPost = vi.fn(() => of({ status: 'ok' }));
    component = new VisorComponent(
      {} as ActivatedRoute,
      { post: httpPost, get: vi.fn(() => of(null)) } as unknown as HttpClient,
      { detectChanges: vi.fn() } as unknown as ChangeDetectorRef,
      {} as NgZone,
      {} as Title,
      'browser',
    );
    component.mode = 'PROJECTION';
    component.activeItem = { id: 1 };
    component.images = [image('01_a'), image('02_b'), image('03_c'), image('04_FIN')];
    component.currentIndex = 0;
  });

  afterEach(() => {
    component.ngOnDestroy();
    vi.useRealTimers();
  });

  const markDoneCalls = () => httpPost.mock.calls.filter(call => String(call[0]).endsWith('mark_done/')).length;

  it('advances one slide per press and drops presses made while locked', () => {
    component.nextImage();
    expect(component.currentIndex).toBe(1);

    component.nextImage();
    component.nextImage();
    expect(component.currentIndex).toBe(1);
  });

  it('hammering the button never rides through: the lock stays alive until the presses stop', () => {
    component.nextImage();
    expect(component.currentIndex).toBe(1);

    // A press every 400 ms for 20 s: before the fix one of them got through every 5 s.
    for (let elapsed = 0; elapsed < 20000; elapsed += 400) {
      vi.advanceTimersByTime(400);
      component.nextImage();
    }
    expect(component.currentIndex).toBe(1);

    // The operator stops, then presses once.
    vi.advanceTimersByTime(1500);
    component.nextImage();
    expect(component.currentIndex).toBe(2);
  });

  it('a burst on the last slide does not close the module', () => {
    component.currentIndex = 2;
    component.nextImage();
    expect(component.currentIndex).toBe(3);

    for (let elapsed = 0; elapsed < 12000; elapsed += 400) {
      vi.advanceTimersByTime(400);
      component.nextImage();
    }
    expect(markDoneCalls()).toBe(0);

    vi.advanceTimersByTime(1500);
    component.nextImage();
    expect(markDoneCalls()).toBe(1);
  });

  it('with the mesa paused by Moden it neither moves nor closes the module, whatever is pressed', () => {
    component.mesaState = { id: 1, nombre: 'Mesa 1', pausa: { motivo: 'Formación', hasta: null } } as any;
    component.currentIndex = 3;
    component.nextImage();
    component.prevImage();
    for (const key of ['ArrowRight', 'ArrowLeft', 'c', 'b']) {
      component.handleKeyboardEvent(new KeyboardEvent('keydown', { key, cancelable: true }));
    }
    vi.advanceTimersByTime(2000);
    expect(component.currentIndex).toBe(3);
    expect(markDoneCalls()).toBe(0);

    // Reanudada: sigue donde estaba.
    component.mesaState = { ...component.mesaState!, pausa: null };
    component.nextImage();
    expect(markDoneCalls()).toBe(1);
  });

  it('closes a module only once while the request is in flight', () => {
    const pending = new Subject<unknown>();
    httpPost.mockImplementation((url: string) => (String(url).endsWith('mark_done/') ? pending : of({ status: 'ok' })));
    component.currentIndex = 3;

    component.nextImage();
    component.finishActiveItem();
    component.finishActiveItem();
    expect(markDoneCalls()).toBe(1);

    pending.next({ status: 'ok' });
    pending.complete();
    expect(component.activeItem).toBeNull();
  });
});


describe('VisorComponent revisión del supervisor y volver al anterior', () => {
  let component: VisorComponent;
  let httpPost: ReturnType<typeof vi.fn>;
  let httpGet: ReturnType<typeof vi.fn>;
  const image = (name: string) => ({ url: `/media/imagenes/1/${name}.png` });
  const key = (type: 'keydown' | 'keyup', k: string) => new KeyboardEvent(type, { key: k, cancelable: true });
  const llamadas = (ruta: string) => httpPost.mock.calls.filter(call => String(call[0]).endsWith(ruta));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-06T08:00:00Z'));
    httpPost = vi.fn(() => of({ status: 'ok' }));
    httpGet = vi.fn(() => of(null));
    component = new VisorComponent(
      {} as ActivatedRoute,
      { post: httpPost, get: httpGet } as unknown as HttpClient,
      { detectChanges: vi.fn() } as unknown as ChangeDetectorRef,
      {} as NgZone,
      {} as Title,
      'browser',
    );
    component.mode = 'PROJECTION';
    component.activeItem = { id: 1 };
    component.images = [image('01_a'), image('02_b'), image('03_supervisor'), image('04_FIN')];
    component.currentIndex = 2;
  });

  afterEach(() => {
    component.ngOnDestroy();
    vi.useRealTimers();
  });

  it('on the supervisor step next alone does nothing and says nothing', () => {
    component.handleKeyboardEvent(key('keydown', 'ArrowRight'));
    component.handleKeyboardUp(key('keyup', 'ArrowRight'));
    vi.advanceTimersByTime(2000);
    expect(component.currentIndex).toBe(2);
    expect(llamadas('set_index/')).toHaveLength(0);
    expect(component.volverStatus).toBeNull();
    expect(component.shutdownStatus).toBeNull();
  });

  it('space and next together pass it as soon as they are released and keep the time', () => {
    component.mesaState = { id: 5, nombre: 'Mesa 1' } as any;
    component.handleKeyboardEvent(key('keydown', ' '));
    component.handleKeyboardEvent(key('keydown', 'ArrowRight'));
    component.handleKeyboardUp(key('keyup', ' '));
    expect(component.currentIndex).toBe(2);
    component.handleKeyboardUp(key('keyup', 'ArrowRight'));
    expect(component.currentIndex).toBe(3);
    expect(llamadas('set_index/').map(call => call[1])).toEqual([{ mesa_id: 5, index: 3, revision: true }]);
    expect(component.shutdownStatus).toBeNull();
  });

  it('with back pressed too it is the shutdown chord, not the review', () => {
    component.handleKeyboardEvent(key('keydown', ' '));
    component.handleKeyboardEvent(key('keydown', 'ArrowRight'));
    component.handleKeyboardEvent(key('keydown', 'ArrowLeft'));
    vi.advanceTimersByTime(1000);
    for (const k of [' ', 'ArrowRight', 'ArrowLeft']) component.handleKeyboardUp(key('keyup', k));
    expect(component.currentIndex).toBe(2);
    expect(llamadas('set_index/')).toHaveLength(0);
  });

  it('a NN_FOTO_supervisor step takes the photo on arrival and still needs both buttons', () => {
    component.mesaState = { id: 5, nombre: 'Mesa 1' } as any;
    component.images = [image('01_a'), image('02_b'), image('03_FOTO_supervisor'), image('04_FIN')];
    component.currentIndex = 1;
    const foto = vi.spyOn(component, 'triggerPhotoCapture').mockImplementation(() => undefined);
    component.nextImage();
    expect(component.currentIndex).toBe(2);
    expect(foto).toHaveBeenCalledWith('foto');

    vi.advanceTimersByTime(6000);
    component.handleKeyboardEvent(key('keydown', 'ArrowRight'));
    component.handleKeyboardUp(key('keyup', 'ArrowRight'));
    expect(component.currentIndex).toBe(2);
    component.handleKeyboardEvent(key('keydown', ' '));
    component.handleKeyboardEvent(key('keydown', 'ArrowRight'));
    component.handleKeyboardUp(key('keyup', ' '));
    component.handleKeyboardUp(key('keyup', 'ArrowRight'));
    expect(component.currentIndex).toBe(3);
    expect(llamadas('set_index/').at(-1)?.[1]).toEqual({ mesa_id: 5, index: 3, revision: true });
  });

  it('from the dashboard visor the supervisor passes it with next', () => {
    component.mesaIdForPairing = 7;
    component.handleKeyboardEvent(key('keydown', 'ArrowRight'));
    expect(component.currentIndex).toBe(3);
    expect(httpPost.mock.calls[0]).toEqual(['/api/mesas/7/set_index/', { index: 3, revision: true }, expect.anything()]);
  });

  it('double back on the first image goes back to the last image of the module finished before', () => {
    component.activeItem = { id: 2 };
    component.images = [image('01_a'), image('02_b')];
    component.currentIndex = 0;
    httpPost.mockImplementation((url: string) => of(String(url).endsWith('volver_anterior/') ? { status: 'ok', item: 1, index: 3 } : { status: 'ok' }));
    httpGet.mockImplementation(() => of({ id: 1, images: [image('01_a'), image('02_b'), image('03_supervisor'), image('04_FIN')] }));

    component.prevImage();
    expect(component.volverStatus).toBe('confirm');
    expect(llamadas('volver_anterior/')).toHaveLength(0);
    component.prevImage();
    expect(llamadas('volver_anterior/')).toHaveLength(1);
    expect(component.activeItem.id).toBe(1);
    expect(component.currentIndex).toBe(3);
    expect(component.volverStatus).toBeNull();
    // De ahi ya no se vuelve mas atras.
    component.currentIndex = 0;
    component.prevImage();
    component.prevImage();
    expect(llamadas('volver_anterior/')).toHaveLength(1);
  });

  it('not once the module on the mesa has gone past its first image, and the server has the last word', () => {
    component.activeItem = { id: 2 };
    component.images = [image('01_a'), image('02_b'), image('03_c')];
    component.currentIndex = 0;
    component.nextImage();
    vi.advanceTimersByTime(6000);
    component.prevImage();
    expect(component.currentIndex).toBe(0);
    component.prevImage();
    component.prevImage();
    expect(component.volverStatus).toBeNull();
    expect(llamadas('volver_anterior/')).toHaveLength(0);

    component.activeItem = null;
    component.handleActiveItemUpdate({ id: 3, images: [image('01_a')] });
    httpPost.mockImplementation((url: string) => String(url).endsWith('volver_anterior/')
      ? throwError(() => ({ status: 409, error: { detail: 'El módulo de ahora ya ha avanzado.' } }))
      : of({ status: 'ok' }));
    component.prevImage();
    component.prevImage();
    expect(component.volverStatus).toBe('error');
    expect(component.volverError).toBe('El módulo de ahora ya ha avanzado.');
    vi.advanceTimersByTime(3000);
    expect(component.volverStatus).toBeNull();
  });
});
