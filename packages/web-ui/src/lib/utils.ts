import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { WorkflowPhase } from './types.js';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function phaseBadgeVariant(
  phase: WorkflowPhase,
): 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning' {
  switch (phase) {
    case 'running':
      return 'default';
    case 'waiting_human':
      return 'warning';
    case 'completed':
      return 'success';
    case 'failed':
      return 'destructive';
    case 'aborted':
      return 'secondary';
    case 'interrupted':
      return 'warning';
    default:
      return 'outline';
  }
}
