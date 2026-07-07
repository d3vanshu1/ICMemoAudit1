import { Outlet } from "react-router";

import { App as AppProvider } from "@superblocksteam/library";

import { Toaster } from "./components/common/sonner";

export default function AppComponent() {
  return (
    <>
      {/* Do not remove the AppProvider */}
      <AppProvider className="h-screen w-screen overflow-hidden bg-ic-dark font-sans">
        <Outlet />
      </AppProvider>
      <Toaster />
    </>
  );
}
