import { DIAGNOSTIC_CODES, type RendererDiagnostic } from '@vector-studio/contracts';
import { DiagnosticChannel } from '@vector-studio/renderer-core';
import { describe, expect, it, vi } from 'vitest';

describe('DiagnosticChannel', () => {
  it('uses the injected clock and deterministic sequence numbers', () => {
    const timestamps = [125, 250];
    const channel = new DiagnosticChannel({ clock: () => timestamps.shift() ?? -1 });
    const received: RendererDiagnostic[] = [];
    channel.subscribe((diagnostic) => received.push(diagnostic));

    const first = channel.emit({
      code: DIAGNOSTIC_CODES.RECOVERY_STARTED,
      severity: 'info',
      message: 'Recovery started.',
      generation: 2,
      context: { trigger: 'device-loss' },
    });
    const second = channel.emit({
      code: DIAGNOSTIC_CODES.RECOVERY_SUCCEEDED,
      severity: 'info',
      message: 'Recovery succeeded.',
      generation: 3,
    });

    expect(received).toEqual([first, second]);
    expect(first).toMatchObject({ sequence: 0, timestampMs: 125, generation: 2 });
    expect(second).toMatchObject({ sequence: 1, timestampMs: 250, generation: 3 });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.context)).toBe(true);
  });

  it('returns an idempotent disposable subscription', () => {
    const channel = new DiagnosticChannel({ clock: () => 0 });
    const listener = vi.fn();
    const subscription = channel.subscribe(listener);

    expect(channel.listenerCount).toBe(1);
    expect(subscription.disposed).toBe(false);

    subscription.dispose();
    subscription.dispose();
    channel.emit({
      code: DIAGNOSTIC_CODES.DISPOSAL_COMPLETED,
      severity: 'info',
      message: 'Disposed.',
    });

    expect(subscription.disposed).toBe(true);
    expect(channel.listenerCount).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it('tracks repeated registrations of the same listener independently', () => {
    const channel = new DiagnosticChannel({ clock: () => 0 });
    const listener = vi.fn();
    const first = channel.subscribe(listener);
    channel.subscribe(listener);

    first.dispose();
    channel.emit({
      code: DIAGNOSTIC_CODES.RENDER_SUBMISSION_FAILED,
      severity: 'error',
      message: 'Submission failed.',
    });

    expect(channel.listenerCount).toBe(1);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('isolates listener failures and continues the emission snapshot', () => {
    const listenerError = new Error('listener failed');
    const onListenerError = vi.fn();
    const healthyListener = vi.fn();
    const channel = new DiagnosticChannel({ clock: () => 0, onListenerError });

    channel.subscribe(() => {
      throw listenerError;
    });
    channel.subscribe(healthyListener);

    channel.emit({
      code: DIAGNOSTIC_CODES.VALIDATION_ERROR,
      severity: 'error',
      message: 'Validation failed.',
    });

    expect(onListenerError).toHaveBeenCalledWith(listenerError);
    expect(healthyListener).toHaveBeenCalledOnce();
  });

  it('can clear all listeners during teardown', () => {
    const channel = new DiagnosticChannel();
    const first = channel.subscribe(() => undefined);
    const second = channel.subscribe(() => undefined);

    channel.clear();

    expect(channel.listenerCount).toBe(0);
    expect(first.disposed).toBe(true);
    expect(second.disposed).toBe(true);
  });
});
