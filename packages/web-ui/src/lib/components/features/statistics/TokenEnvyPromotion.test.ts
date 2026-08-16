import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import TokenEnvyPromotion from './TokenEnvyPromotion.svelte';

describe('TokenEnvyPromotion', () => {
  it('promotes the local Claude Code companion with the documented command', () => {
    render(TokenEnvyPromotion);

    expect(screen.getByRole('heading', { name: 'More detail for your regular Claude Code sessions' })).toBeTruthy();
    expect(screen.getByText('npx tokenenvy')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Learn more/ }).getAttribute('href')).toBe(
      'https://github.com/provos/tokenenvy',
    );
  });

  it('copies the launch command and confirms success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(TokenEnvyPromotion);

    await fireEvent.click(screen.getByRole('button', { name: 'Copy npx tokenenvy' }));

    expect(writeText).toHaveBeenCalledWith('npx tokenenvy');
    expect(screen.getByText('Copied')).toBeTruthy();
    vi.unstubAllGlobals();
  });
});
