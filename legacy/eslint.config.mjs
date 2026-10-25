import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "dist/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    rules: {
      // Downgrade to warning: all instances are intentional mount-only
      // initialization effects (hydration safety, browser API detection).
      // These follow the pattern `useEffect(() => { setState(fn()) }, [])`
      // which is a well-established SSR-safe idiom, not a cascade risk.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
]);

export default eslintConfig;
