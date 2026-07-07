import { createTypedExecuteApi } from "@superblocksteam/library";

/**
 * Typed `executeApi` wrapper backed by the app's API registry.
 * For calling APIs outside of React components.
 */
import type { ApiRegistry } from "../../server/apis/index.js";

export const executeApi = createTypedExecuteApi<ApiRegistry>();
