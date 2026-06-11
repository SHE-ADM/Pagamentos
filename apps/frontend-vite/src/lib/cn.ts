import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge condicional de classes Tailwind: clsx resolve condicionais e
 * tailwind-merge desconflita utilitários sobrepostos (ex.: `px-2 px-4`).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
