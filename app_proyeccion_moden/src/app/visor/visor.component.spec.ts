import { ChangeDetectorRef, NgZone } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { Title } from '@angular/platform-browser';
import { of } from 'rxjs';
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
