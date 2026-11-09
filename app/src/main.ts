import "./style.css";
import { startApp } from "./app.ts";
import { debugLog, describeDebug } from "./debug.ts";

const root = document.getElementById("app");
if (root) {
  root.dataset.boot = "pending";
}

startApp()
  .then(() => {
    if (root) root.dataset.boot = "ready";
  })
  .catch((error: unknown) => {
    console.error("[预言鲸] 启动失败", error);
    debugLog("start error", error);
    if (new URLSearchParams(location.search).has("debug")) {
      const panel = document.getElementById("debug-panel");
      if (panel) {
        panel.hidden = false;
        panel.textContent = `start error: ${describeDebug(error)}`;
      }
    }
    if (root) root.dataset.boot = "error";
  });
