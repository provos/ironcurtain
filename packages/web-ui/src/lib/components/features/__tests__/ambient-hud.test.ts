import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/svelte';
import AmbientHud from '../ambient-hud.svelte';

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    workflowName: 'my-workflow',
    currentRound: 3,
    totalRounds: 20,
    connectionStatus: 'connected' as const,
    tokensPerSec: 42.7,
    modelName: 'sonnet-4-20250514',
    ...overrides,
  };
}

describe('AmbientHud', () => {
  describe('top-left panel', () => {
    it('renders the workflow name', () => {
      const { getByText } = render(AmbientHud, { props: makeProps() });
      expect(getByText('my-workflow')).toBeTruthy();
    });

    it('renders the round count when both currentRound and totalRounds are provided', () => {
      const { getByText } = render(AmbientHud, { props: makeProps({ currentRound: 7, totalRounds: 20 }) });
      expect(getByText('7/20')).toBeTruthy();
    });

    it('omits the round count when currentRound is missing', () => {
      const { queryByText } = render(AmbientHud, { props: makeProps({ currentRound: undefined, totalRounds: 20 }) });
      expect(queryByText('/20')).toBeNull();
    });

    it('omits the round count when totalRounds is missing', () => {
      const { queryByText } = render(AmbientHud, { props: makeProps({ currentRound: 3, totalRounds: undefined }) });
      expect(queryByText('3/')).toBeNull();
    });

    it('omits the round count when totalRounds is 0 (uninitialized budget)', () => {
      const { container } = render(AmbientHud, { props: makeProps({ currentRound: 0, totalRounds: 0 }) });
      const left = container.querySelector('[data-testid="ambient-hud-top-left"]');
      expect(left?.textContent).not.toMatch(/0\/0/);
    });
  });

  describe('connection indicator glyph', () => {
    it('shows a filled circle when connected', () => {
      const { container } = render(AmbientHud, { props: makeProps({ connectionStatus: 'connected' }) });
      const dot = container.querySelector('.hud-dot');
      expect(dot?.textContent).toBe('●');
      expect(dot?.className).toContain('hud-dot--ok');
    });

    it('shows a filled circle with the reconnecting class when reconnecting', () => {
      const { container } = render(AmbientHud, { props: makeProps({ connectionStatus: 'reconnecting' }) });
      const dot = container.querySelector('.hud-dot');
      expect(dot?.textContent).toBe('●');
      expect(dot?.className).toContain('hud-dot--reconnect');
    });

    it('shows an open circle when disconnected', () => {
      const { container } = render(AmbientHud, { props: makeProps({ connectionStatus: 'disconnected' }) });
      const dot = container.querySelector('.hud-dot');
      expect(dot?.textContent).toBe('○');
      expect(dot?.className).toContain('hud-dot--down');
    });
  });

  describe('top-right panel', () => {
    it('renders tokens/sec rounded to a whole number', () => {
      const { getByText } = render(AmbientHud, { props: makeProps({ tokensPerSec: 42.7 }) });
      expect(getByText('43')).toBeTruthy();
      expect(getByText('tok/s')).toBeTruthy();
    });

    it('renders 0 when tokens/sec is zero', () => {
      const { getByText } = render(AmbientHud, { props: makeProps({ tokensPerSec: 0 }) });
      expect(getByText('0')).toBeTruthy();
    });

    it('clamps non-finite tokens/sec to 0 rather than showing NaN', () => {
      const { container } = render(AmbientHud, { props: makeProps({ tokensPerSec: NaN }) });
      const right = container.querySelector('[data-testid="ambient-hud-top-right"]');
      expect(right?.textContent).not.toMatch(/NaN/);
      expect(right?.textContent).toMatch(/\b0\b/);
    });

    it('clamps negative tokens/sec to 0', () => {
      const { container } = render(AmbientHud, { props: makeProps({ tokensPerSec: -5 }) });
      const right = container.querySelector('[data-testid="ambient-hud-top-right"]');
      expect(right?.textContent).toMatch(/\b0\b/);
    });

    it('renders the model name', () => {
      const { getByText } = render(AmbientHud, { props: makeProps({ modelName: 'sonnet-4-20250514' }) });
      expect(getByText('sonnet-4-20250514')).toBeTruthy();
    });

    it('omits the model name separator when modelName is null', () => {
      const { container } = render(AmbientHud, { props: makeProps({ modelName: null }) });
      const right = container.querySelector('[data-testid="ambient-hud-top-right"]');
      // The separator '·' appears only between tok/s and the model name
      expect(right?.textContent).not.toMatch(/·/);
    });
  });

  describe('layout', () => {
    it('renders two distinct corner panels', () => {
      const { container } = render(AmbientHud, { props: makeProps() });
      expect(container.querySelector('[data-testid="ambient-hud-top-left"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="ambient-hud-top-right"]')).not.toBeNull();
    });

    it('renders no bottom corners in v1 (§F.3 defers them)', () => {
      const { container } = render(AmbientHud, { props: makeProps() });
      expect(container.querySelector('[data-testid="ambient-hud-bottom-left"]')).toBeNull();
      expect(container.querySelector('[data-testid="ambient-hud-bottom-right"]')).toBeNull();
    });
  });
});
