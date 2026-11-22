import type { Browser, Page, Target } from 'puppeteer-core';
import { autologinInpage } from '../inpage.js';
import type { PageLike } from '../login/engine.js';

export interface TargetLike {
  type(): string;
  url(): string;
  page(): Promise<PageLike | null>;
}

export interface BrowserLike {
  targets(): TargetLike[];
  disconnect(): Promise<void>;
  onDisconnected(listener: () => void): void;
}

export function adaptPage(page: Page): PageLike {
  return {
    url: () => page.url(),
    run: async <T>(action: Parameters<typeof autologinInpage>[0], arg: Parameters<typeof autologinInpage>[1]) =>
      (await page.evaluate(autologinInpage, action, arg)) as T,
    element: async (selector) => {
      const handle = await page.$(selector);
      return handle === null ? null : { focus: () => handle.focus(), click: () => handle.click() };
    },
    insertText: (text) => page.keyboard.sendCharacter(text),
    press: (key) => page.keyboard.press(key),
    bringToFront: () => page.bringToFront(),
  };
}

function adaptTarget(target: Target): TargetLike {
  return {
    type: () => target.type(),
    url: () => target.url(),
    page: async () => {
      const page = await target.page();
      return page === null ? null : adaptPage(page);
    },
  };
}

/** Wraps a puppeteer Browser. Only ever disconnects: the user's Chrome is never closed. */
export function adaptBrowser(browser: Browser): BrowserLike {
  return {
    targets: () => browser.targets().map(adaptTarget),
    disconnect: () => browser.disconnect(),
    onDisconnected: (listener) => {
      browser.on('disconnected', listener);
    },
  };
}
