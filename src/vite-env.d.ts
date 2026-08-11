/// <reference types="vite/client" />

/**
 * Vite's ambient module declarations cover the asset imports used by the brand
 * mark (`*.png` resolves to a URL string). Without this reference `tsc --noEmit`
 * would reject `import mark from './assets/brand-mark.png'`.
 */
