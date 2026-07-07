import { useTypedApiData } from "@superblocksteam/library";

/**
 * Typed `useApiData` wrapper backed by the app's API registry.
 */
import type { ApiRegistry } from "../../server/apis/index.js";

/** Typed `useApiData` with inference from `ApiRegistry`. */
// eslint-disable-next-line react-hooks/rules-of-hooks -- useTypedApiData is a type-only factory (no React hooks are called at runtime)
export const useApiData = useTypedApiData<ApiRegistry>();
