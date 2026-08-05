import migration0 from "./0000_bootstrap.sql";
import migration1 from "./0001_expand_provider_auth_schemes.sql";
import migration2 from "./0002_tricky_purple_man.sql";

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
  {
    name: "0002_tricky_purple_man",
    sql: migration2,
    version: 3,
  },
] as const;

export const CONTROL_PLANE_SCHEMA_VERSION = controlPlaneMigrations.length;
