/**
 * Typed `useApi` wrapper backed by the app's API registry.
 *
 * This gives compile-time inference for API names, inputs, and outputs based on
 * `server/apis/index.ts`.
 *
 * You generally do not need to modify this file. Add APIs to
 * `server/apis/index.ts` and import `useApi` from here.
 *
 * @example
 * ```typescript
 * import { useApi } from "@/hooks/useApi.js";
 *
 * const { run } = useApi("GetUsers");
 * // `run` is inferred from the `GetUsers` entry in `server/apis/index.ts`
 * ```
 */

import { useTypedApi } from "@superblocksteam/library";

import type { ApiRegistry } from "../../server/apis/index.js"; // Type-only import

/** Typed `useApi` with inference from `ApiRegistry`. */
// eslint-disable-next-line react-hooks/rules-of-hooks -- useTypedApi is a type-only factory (no React hooks are called at runtime)
export const useApi = useTypedApi<ApiRegistry>();
