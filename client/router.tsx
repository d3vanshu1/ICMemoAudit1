import { createBrowserRouter } from "react-router";
import App from "./App";

export const router = createBrowserRouter([
  {
    path: "/",
    Component: App,
    children: [
      {
        index: true,
        lazy: () => import("./pages/DealList/index"),
      },
      {
        path: "deals/:dealId",
        lazy: () => import("./pages/DealDashboard/index"),
      },
      {
        path: "*",
        lazy: () => import("./pages/NotFound/index"),
      },
    ],
  },
]);
