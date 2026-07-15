import type { DesktopApi } from "../shared/types";

declare global {
  interface Window {
    pdf2zh: DesktopApi;
  }
}

export {};
