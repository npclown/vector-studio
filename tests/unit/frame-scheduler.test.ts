import { FrameScheduler, type AnimationFrameClock } from '@vector-studio/renderer-core';
import { describe, expect, it, vi } from 'vitest';

class ManualAnimationFrameClock implements AnimationFrameClock {
  readonly callbacks = new Map<number, (timestampMs: number) => void>();
  readonly cancelled: number[] = [];
  #nextHandle = 1;

  request(callback: (timestampMs: number) => void): number {
    const handle = this.#nextHandle++;
    this.callbacks.set(handle, callback);
    return handle;
  }

  cancel(handle: number): void {
    this.cancelled.push(handle);
    this.callbacks.delete(handle);
  }

  flush(timestampMs = 16): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) {
      callback(timestampMs);
    }
  }
}

describe('FrameScheduler', () => {
  it('coalesces synchronous invalidations into one animation frame', () => {
    const clock = new ManualAnimationFrameClock();
    const render = vi.fn();
    const scheduler = new FrameScheduler({ clock, render });

    for (let index = 0; index < 100; index += 1) {
      scheduler.invalidate();
    }

    expect(scheduler.pendingCallbacks).toBe(1);
    expect(clock.callbacks).toHaveLength(1);
    clock.flush(20);
    expect(render).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledWith(20);
    expect(scheduler.pendingCallbacks).toBe(0);
    expect(clock.callbacks).toHaveLength(0);
  });

  it('submits no further work while on-demand rendering is idle', () => {
    const clock = new ManualAnimationFrameClock();
    const render = vi.fn();
    const scheduler = new FrameScheduler({ clock, render });

    scheduler.invalidate();
    clock.flush();
    clock.flush(32);

    expect(render).toHaveBeenCalledOnce();
    expect(clock.callbacks).toHaveLength(0);
  });

  it('schedules frames continuously only while continuous mode is active', () => {
    const clock = new ManualAnimationFrameClock();
    const render = vi.fn();
    const scheduler = new FrameScheduler({ clock, render });

    scheduler.setMode('continuous');
    clock.flush(16);
    clock.flush(32);
    expect(render).toHaveBeenCalledTimes(2);
    expect(scheduler.pendingCallbacks).toBe(1);

    scheduler.setMode('on-demand');
    clock.flush(48);
    expect(render).toHaveBeenCalledTimes(3);
    expect(scheduler.pendingCallbacks).toBe(0);
  });

  it('cancels pending work on disposal', () => {
    const clock = new ManualAnimationFrameClock();
    const render = vi.fn();
    const scheduler = new FrameScheduler({ clock, render });

    scheduler.invalidate();
    scheduler.dispose();
    clock.flush();

    expect(render).not.toHaveBeenCalled();
    expect(clock.cancelled).toEqual([1]);
    expect(scheduler.pendingCallbacks).toBe(0);
  });
});
