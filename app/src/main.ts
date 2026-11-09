import "./style.css";
import { startApp } from "./app.ts";

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
    if (root) root.dataset.boot = "error";
  });
