/// <reference types="vite/client" />

// vite-plugin-compile-time's client types, which its package doesn't export
interface ImportMeta {
  compileTime: <T>(id: string) => T;
}

// Fonts imported for their CSS
declare module "@fontsource/*";
declare module "typeface-*";

// Extending Window object

interface Window {
  publicPath: string;
  apiEndpoint: string;
  appLogo: string;
  gravatarCdn: string;
  ghAvatarCdn: string;
  appVersion: {
    hash?: string;
    date?: string;
  };

  fatalError(messages: string[], stack?: string): void;

  // For get session info JSONP API
  sessionInfo: ApiTypes.GetSessionInfoResponseDto;
  getSessionInfoCallback: (sessionInfo: ApiTypes.GetSessionInfoResponseDto) => void;
  refreshSession: (tokan: string) => void;

  // Monaco Editor's window.require
  require: any;

  // MathJax configuration
  MathJax: any;
}

// Where the libraries loaded on demand are, relative to the public path (see vite.config.ts)
declare const VENDOR: Readonly<Record<"monaco" | "mathjax" | "prism" | "twemoji", string>>;
