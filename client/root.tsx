import "@superblocksteam/library/index.css";
import "./index.css";
import { createRoot, type Root } from "react-dom/client";
import { RouterProvider } from "react-router";

import { router } from "./router";

const rootEl = document.getElementById("root");
let root: Root | undefined = undefined;

if (rootEl && !root) {
  root = createRoot(rootEl);
}

if (root) {
  root.render(<RouterProvider router={router} />);
}
