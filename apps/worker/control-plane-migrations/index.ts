import migration0 from "./0000_bootstrap.sql";

export const controlPlaneMigrations = [
  {
    name: "0000_bootstrap",
    sql: migration0,
    version: 1,
  },
] as const;

export const CONTROL_PLANE_SCHEMA_VERSION = controlPlaneMigrations.length;
