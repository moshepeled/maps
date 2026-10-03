/** The current theme for React components (UX C-30); re-renders when it changes, in this tab or another one. */
import { useStore } from 'zustand';

import type { Theme } from './theme';
import { themeController } from './theme';

export function useTheme(): Theme {
  return useStore(themeController().store, (state) => state.theme);
}
