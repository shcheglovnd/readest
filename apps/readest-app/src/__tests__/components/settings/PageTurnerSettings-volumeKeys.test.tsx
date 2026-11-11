import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

// Real deviceStore; only the native bridge is mocked, so the test sees whether
// the settings panel leaves a volume-key interception held.
const h = vi.hoisted(() => ({
  reset: vi.fn(),
  settings: {
    globalViewSettings: {
      volumeKeysToFlip: true,
      volumeKeysMode: 'page' as 'page' | 'scroll',
      volumeKeysScrollStep: 25,
    },
    hardwarePageTurner: {
      enabled: false,
      bindings: {
        pagePrev: null,
        pageNext: null,
        sectionPrev: null,
        sectionNext: null,
        refresh: null,
      },
    },
  },
}));

vi.mock('@/utils/bridge', () => ({
  interceptKeys: vi.fn(),
  getScreenBrightness: vi.fn(),
  setScreenBrightness: vi.fn(),
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: {}, appService: { isMobileApp: true } }),
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (value: string) => value,
}));

vi.mock('@/hooks/useEinkRefreshSupported', () => ({
  useEinkRefreshSupported: () => false,
}));

vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({ settings: h.settings }),
}));

vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({ getViewSettings: () => h.settings.globalViewSettings }),
}));

vi.mock('@/hooks/useResetSettings', () => ({
  useResetViewSettings: () => h.reset,
}));

vi.mock('@/helpers/settings', () => ({
  saveSysSettings: vi.fn(),
  saveViewSettings: vi.fn(),
}));

vi.mock('@/components/settings/primitives', async (original) => ({
  ...(await original<object>()),
  BoxedList: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SettingsRow: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SettingsSwitchRow: ({ label, onChange }: { label: string; onChange: () => void }) => (
    <button type='button' onClick={onChange}>
      {label}
    </button>
  ),
}));

import { useDeviceControlStore } from '@/store/deviceStore';
import PageTurnerSettings from '@/components/settings/PageTurnerSettings';
import { saveViewSettings } from '@/helpers/settings';

beforeEach(() => {
  vi.clearAllMocks();
  h.settings.globalViewSettings = {
    volumeKeysToFlip: true,
    volumeKeysMode: 'page',
    volumeKeysScrollStep: 25,
  };
  useDeviceControlStore.setState({ volumeKeysIntercepted: false, volumeKeysInterceptionCount: 0 });
});

afterEach(() => {
  cleanup();
});

describe('PageTurnerSettings volume keys (#7119)', () => {
  test('reset restores page mode and the default scroll step', () => {
    h.settings.globalViewSettings = {
      volumeKeysToFlip: true,
      volumeKeysMode: 'scroll',
      volumeKeysScrollStep: 5,
    };
    h.reset.mockImplementation((setters: Record<string, (value: unknown) => void>) => {
      setters['volumeKeysToFlip']?.(true);
      setters['volumeKeysMode']?.('page');
      setters['volumeKeysScrollStep']?.(25);
    });
    const register = vi.fn();
    render(<PageTurnerSettings bookKey='book-1' onRegisterReset={register} />);
    act(() => register.mock.calls[0]![0]());
    expect(
      screen.getByRole<HTMLSelectElement>('combobox', { name: 'Volume key action' }).value,
    ).toBe('page');
    fireEvent.change(screen.getByRole('combobox', { name: 'Volume key action' }), {
      target: { value: 'scroll' },
    });
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Scroll step (%)' }).value).toBe(
      '25',
    );
  });

  test('persists scroll mode, enables continuous scrolling, and saves the chosen step', () => {
    const enableScrolling = vi.fn();
    render(<PageTurnerSettings bookKey='book-1' onEnableScrolledMode={enableScrolling} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Volume key action' }), {
      target: { value: 'scroll' },
    });
    expect(enableScrolling).toHaveBeenCalledOnce();
    expect(saveViewSettings).toHaveBeenCalledWith(
      {},
      'book-1',
      'volumeKeysMode',
      'scroll',
      false,
      false,
    );
    const step = screen.getByRole('textbox', { name: 'Scroll step (%)' });
    fireEvent.change(step, { target: { value: '5' } });
    fireEvent.blur(step);
    expect(saveViewSettings).toHaveBeenCalledWith(
      {},
      'book-1',
      'volumeKeysScrollStep',
      5,
      false,
      false,
    );
  });

  test('restores a saved scroll step when reopening and disables controls when volume keys are off', () => {
    h.settings.globalViewSettings = {
      volumeKeysToFlip: true,
      volumeKeysMode: 'scroll',
      volumeKeysScrollStep: 12,
    };
    render(<PageTurnerSettings bookKey='book-1' />);
    expect(
      screen.getByRole<HTMLSelectElement>('combobox', { name: 'Volume key action' }).value,
    ).toBe('scroll');
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Scroll step (%)' }).value).toBe(
      '12',
    );
    fireEvent.click(screen.getByText('Use Volume Keys'));
    expect(
      screen.getByRole<HTMLSelectElement>('combobox', { name: 'Volume key action' }).disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLInputElement>('textbox', { name: 'Scroll step (%)' }).disabled,
    ).toBe(true);
  });

  test('hides the step setting in normal page mode', () => {
    render(<PageTurnerSettings bookKey='book-1' />);
    expect(
      screen.getByRole<HTMLSelectElement>('combobox', { name: 'Volume key action' }).value,
    ).toBe('page');
    expect(screen.queryByRole('textbox', { name: 'Scroll step (%)' })).toBeNull();
  });

  test('reopening the panel and turning Use Volume Keys off leaves no interception held', () => {
    render(<PageTurnerSettings bookKey='book-1' />);
    cleanup();
    render(<PageTurnerSettings bookKey='book-1' />);

    fireEvent.click(screen.getByText('Use Volume Keys'));

    expect(useDeviceControlStore.getState().volumeKeysInterceptionCount).toBe(0);
    expect(useDeviceControlStore.getState().volumeKeysIntercepted).toBe(false);
  });
});
