// Globals the plain browser scripts publish on window for one another, for
// the scoped type check (tsconfig.browser.json). Only shapes the checked
// files rely on are spelled out.
export {};

declare global {
  interface Window {
    WSAdminResetInactivityTimer?: () => void;
    WSAdminLock?: {
      lock(reason?: string): Promise<void>; reset(): void; configure(minutes: number | string): number; minutes(): number;
      clampMinutes(value: unknown): number; mayUnlock(token: string | null): boolean; lockedState(): any; clearLock(): void;
      endServerSession(): Promise<boolean>; sessionIdOf(token: string | null): string | null; MIN_MINUTES: number; MAX_MINUTES: number;
    };
    wsDialog?: any;
    supabase?: any;
    __WS_ADMIN_SB__?: any;
  }
}
