// The headless DOM harness is a dev dependency; jsdom does not ship types.
declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string, options?: { url?: string; pretendToBeVisual?: boolean });
    readonly window: any;
  }
}
