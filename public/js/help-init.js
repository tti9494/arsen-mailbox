import { initTheme } from "./theme.js?v=2.3.0";
import { buildPwaIllustration, buildThemeSelector } from "./dom.js?v=2.3.0";

initTheme();

const themeSlot = document.getElementById("help-theme-slot");
if (themeSlot) {
  themeSlot.replaceChildren(buildThemeSelector("화면 테마"));
}

const iosSlot = document.getElementById("help-pwa-ios");
if (iosSlot) iosSlot.replaceChildren(buildPwaIllustration("ios"));

const androidSlot = document.getElementById("help-pwa-android");
if (androidSlot) androidSlot.replaceChildren(buildPwaIllustration("android"));
