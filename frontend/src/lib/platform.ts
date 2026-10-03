/** Platform wording for key chips and hints: `Ctrl` reads `⌘` on macOS and iOS (UX section 9.15). */

export function isApplePlatform(platform: string = globalThis.navigator.platform): boolean {
  return /Mac|iPhone|iPad/u.test(platform);
}

/** A key-chip label with the platform's modifier: `Ctrl S` -> `⌘ S` on Apple platforms. */
export function platformKeys(chip: string, apple: boolean = isApplePlatform()): string {
  return apple ? chip.replace(/\bCtrl\b/u, '⌘') : chip;
}
