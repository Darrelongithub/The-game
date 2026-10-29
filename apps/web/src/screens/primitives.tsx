'use client';
import React from 'react';
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';

// Self-contained versions of the UI-system primitives while the shell is built.
export function GlassCard({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`glass-card rounded-2xl p-6 md:p-8 ${className}`} {...props} />;
}
export function GlowButton({ className = '', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return <button type="button" className={`relative min-h-[48px] min-w-[48px] rounded-2xl bg-gradient-to-r from-purple-primary to-blue-secondary px-6 py-3.5 font-medium text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-accent ${className}`} {...props}>{children}</button>;
}
export function AnimatedWords({ text, className = '' }: { text: string; className?: string }) {
  return <span className={className}>{text}</span>;
}
