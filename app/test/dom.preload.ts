// 为 bun test 提供 DOM 全局（仅 card 视图等 UI 测试需要）。
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
