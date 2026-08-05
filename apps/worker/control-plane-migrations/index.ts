import migration0 from "./0000_bootstrap.sql";
import migration1 from "./0001_expand_provider_auth_schemes.sql";

export const controlPlaneMigrations = [
  {
    name: "0000_bootstrap",
    sql: migration0,
    version: 1,
  },
  {
    name: "0001_expand_provider_auth_schemes",
    sql: migration1,
    version: 2,
  },
] as const;

export const CONTROL_PLANE_SCHEMA_VERSION = controlPlaneMigrations.length;
