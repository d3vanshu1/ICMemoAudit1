import React from "react";

// Custom hook to track current pathname and determine active menu items
export const useActivePage = () => {
  // Track current pathname
  const [currentPath, setCurrentPath] = React.useState(
    window.location.pathname,
  );

  // Update current path when location changes
  React.useEffect(() => {
    const handleLocationChange = () => {
      setCurrentPath(window.location.pathname);
    };

    // Listen for navigation events
    window.addEventListener("popstate", handleLocationChange);

    // Custom event listener for programmatic navigation
    const handleNavigationEvent = () => {
      setTimeout(() => {
        setCurrentPath(window.location.pathname);
      }, 0);
    };

    // Listen for hash changes too
    window.addEventListener("hashchange", handleLocationChange);

    // Add custom navigation listener
    window.addEventListener("navigation", handleNavigationEvent);

    return () => {
      window.removeEventListener("popstate", handleLocationChange);
      window.removeEventListener("hashchange", handleLocationChange);
      window.removeEventListener("navigation", handleNavigationEvent);
    };
  }, []);

  // Function to determine if a menu item is active
  const isPageActive = React.useCallback(
    (pageUrl: string) => {
      if (!pageUrl) {
        return false;
      }

      // Handle different URL formats
      if (pageUrl.startsWith("http") || pageUrl.startsWith("//")) {
        // External URLs - not active
        return false;
      }

      // Remove leading slash if present for comparison
      const cleanUrl = pageUrl.startsWith("/") ? pageUrl : `/${pageUrl}`;
      const cleanCurrentPath = currentPath || "/";

      // Exact match
      if (cleanUrl === cleanCurrentPath) {
        return true;
      }

      // For root page, only match exact
      if (cleanUrl === "/" || cleanCurrentPath === "/") {
        return cleanUrl === cleanCurrentPath;
      }

      // Check if current path starts with the menu item URL (for nested routes)
      return cleanCurrentPath.startsWith(cleanUrl);
    },
    [currentPath],
  );

  return { isPageActive };
};
