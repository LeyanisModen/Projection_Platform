import { ChangeDetectorRef, NgZone } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { Title } from '@angular/platform-browser';
import { Subject, of } from 'rxjs';
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
